/**
 * Digistore24 Refund/Chargeback Handler
 * Endpoint: POST /webhook/digistore24/refund
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { validateSignature, normalizePayload } from '../services/digistore24';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { METRICS_ONLY } from '../config/env';
import { lookupStore, extractDS24Identifier, resolveDS24StoreBySignature } from './store-lookup';
import { upsertProduct, extractDS24ProductId } from './product-upsert';
import { extractDS24Metrics } from './metrics-extract';
import { marcarEnriquecimento } from './webhook-status';

const CTX = 'Webhook:DS24:Refund';

export async function handleDS24Refund(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const params = { ...req.body, ...req.query };

  try {
    // 1. Try to resolve store by testing signature against all registered
    //    DS24 clients. If it matches, the signature is already validated.
    let store = await resolveDS24StoreBySignature(params);

    if (!store) {
      // Fallback: legacy identifier-based lookup (product_id/vendor_id)
      const identifier = extractDS24Identifier(params);
      store = await lookupStore('digistore24', identifier);

      const passphrase = store.apiToken || process.env.DS24_IPN_PASSPHRASE || '';
      if (!passphrase) {
        logger.error(CTX, 'DS24_IPN_PASSPHRASE not configured — rejecting request (fail closed)');
        res.status(403).json({ error: 'Webhook validation not configured' });
        return;
      }
      if (!validateSignature(params, passphrase)) {
        logger.warn(CTX, 'Invalid IPN signature — rejecting');
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
    }

    // 2.5 — Digistore24 "Test connection": ping sintético sem dado de comprador. Responder OK sem processar.
    if (params.event === 'connection_test' || params.function_call === 'connection_test') {
      logger.info(CTX, `Test connection OK (client ${store.clientId})`);
      res.status(200).send('OK');
      return;
    }

    const data = normalizePayload(params);

    // isChargeback vem de payload.transaction_type, não de params.event. Achado ao auditar: a
    // Digistore manda o evento como "on_refund"/"on_payment" (prefixo "on_"), então
    // `params.event === 'chargeback'` nunca batia — os únicos 5 que caíam certo eram de um
    // formato de IPN mais antigo. Resultado medido em produção: 132 chargebacks gravados como
    // 'order.refunded'. transaction_type é o MESMO campo que a tela de Transactions da Digistore
    // usa (confirmado contra o CSV do afiliado) — mais confiável que adivinhar pelo nome do
    // evento. Mantém o fallback pelo event antigo pra payload sem transaction_type (medido: ~1%
    // do volume, IPN de formato legado).
    const tipoPayload = String(params.transaction_type || '').toLowerCase();
    const isChargeback = tipoPayload
      ? tipoPayload === 'chargeback'
      : params.event === 'chargeback';
    const eventType = isChargeback ? 'order.chargeback' : 'order.refunded';
    const externalId = extractDS24ProductId(params);

    // GRAVA PRIMEIRO, PROCESSA DEPOIS — mesma razão do handler de pagamento (ver o comentário
    // grande lá): e-mail ausente ou ActiveCampaign fora do ar não podem fazer um reembolso
    // desaparecer. Um 4xx/5xx aqui é a Digistore reenviando e, se persistir, desligando a
    // conexão de IPN inteira — foi o que explicou os 19 dias sem NENHUM evento.
    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const m = extractDS24Metrics(data.rawPayload);
        const result = await query(
          `INSERT INTO webhook_logs (
            client_id, event_type, source, payload, status,
            total_price, currency, product_name, product_external_id,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            affiliate_name, tracking_code
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [
            store.clientId, eventType, 'digistore24', JSON.stringify(data.rawPayload), 'processing',
            m.totalPrice, m.currency, m.productName, m.productExternalId,
            m.utmSource, m.utmMedium, m.utmCampaign, m.utmContent, m.utmTerm,
            m.affiliateName, m.trackingCode,
          ]
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook', dbErr.message);
      }
    }

    // Responde OK agora — o dado já está seguro. O resto é enriquecimento (tag no
    // ActiveCampaign); falha nele não pode fazer a Digistore achar que perdeu o evento.
    res.status(200).send('OK');

    if (!data.email) {
      logger.warn(CTX, `No email found in DS24 ${eventType} — stored, enrichment skipped`, { orderId: data.orderId });
      await marcarEnriquecimento(logId, 'skipped', 'sem email no payload');
      return;
    }

    logger.info(CTX, `Processing DS24 ${eventType} for ${data.email}`, {
      orderId: data.orderId, client: store.clientId,
    });

    try {
      const kit = await upsertProduct(store.clientId, 'digistore24', externalId, data.productName);

      if (!METRICS_ONLY) {
        if (store.acApiUrl && store.acApiKey) {
          const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);
          const contact = await ac.syncContact({ email: data.email });

          if (kit?.enabled) {
            const tagName = isChargeback
              ? `[${kit.name}] Chargeback`
              : `[${kit.name}] Reembolso`;

            const storedTagId = isChargeback ? kit.ac_tag_chargeback_id : kit.ac_tag_reembolso_id;

            if (storedTagId) {
              await ac.addTagToContact(contact.id, storedTagId);
            } else {
              const tag = await ac.findTagByName(tagName);
              if (tag) await ac.addTagToContact(contact.id, tag.id);
              else logger.warn(CTX, `Tag not found: ${tagName}`);
            }
          } else {
            logger.info(CTX, `Product "${data.productName}" not enabled — contact synced only`);
          }
        } else {
          logger.warn(CTX, 'ActiveCampaign credentials not configured — stored, enrichment skipped');
        }
      } else {
        logger.info(CTX, 'METRICS_ONLY — skipping AC/SlickText side effects');
      }

      await marcarEnriquecimento(logId, 'processed', null);
      logger.info(CTX, `✅ DS24 ${eventType} processed for ${data.email}`);
    } catch (enrichErr: any) {
      // O reembolso já está gravado (logId). Isso aqui é "a tag não foi posta", não "o dinheiro
      // sumiu" — grava o motivo NA LINHA CERTA e segue, sem 5xx pra Digistore reagir.
      logger.error(CTX, 'Enrichment failed (refund already stored)', enrichErr.message);
      await marcarEnriquecimento(logId, 'failed', enrichErr.message);
    }
  } catch (error: any) {
    // Só cai aqui erro ANTES da gravação (resolução de loja, assinatura) — response ainda não
    // foi enviada. Isso sim é "não sabemos nem de quem é o evento", e um 5xx genuíno.
    logger.error(CTX, 'Failed to process DS24 refund', error.message);
    res.status(500).json({ error: 'Internal processing error' });
  }
}
