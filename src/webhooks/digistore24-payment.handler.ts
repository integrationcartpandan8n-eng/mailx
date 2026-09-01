/**
 * Digistore24 Payment Handler
 * Endpoint: POST /webhook/digistore24/payment
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { validateSignature, normalizePayload } from '../services/digistore24';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { METRICS_ONLY } from '../config/env';
import { lookupStore, extractDS24Identifier, resolveDS24StoreBySignature } from './store-lookup';
import { upsertProduct, extractDS24ProductId } from './product-upsert';
import { syncSlickTextOrderPaid, extractDS24Address } from './slicktext-sync';
import { extractDS24Metrics } from './metrics-extract';
import { marcarEnriquecimento } from './webhook-status';

const CTX = 'Webhook:DS24:Payment';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function handleDS24Payment(req: Request, res: Response, _next: NextFunction): Promise<void> {
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

    // 3. Normalize — normalizePayload nunca lança (mesmo padrão de extractDS24Metrics), então
    // pode rodar antes da gravação sem risco de perder o evento por exceção aqui.
    const data = normalizePayload(params);
    const externalId = extractDS24ProductId(params);

    // 4. GRAVA PRIMEIRO, PROCESSA DEPOIS.
    //
    // Achado ao investigar por que 44% dos reembolsos e 19 dias inteiros de eventos sumiram:
    // o código antigo rejeitava (400 sem email, 500 sem AC configurado) ou lançava (AC fora do
    // ar, produto não resolvido) ANTES de gravar em webhook_logs — e cada 4xx/5xx é a Digistore
    // reenviando e, se persistir, DESLIGANDO a conexão de IPN inteira (foi o que aconteceu em
    // 03/08, documentado em janelas_sem_coleta). Um evento financeiro nunca pode depender de um
    // efeito colateral (ActiveCampaign, SlickText) pra ser considerado recebido.
    //
    // A partir daqui: assinatura já validada = evento é nosso e vai ser gravado, ponto. Falha em
    // qualquer enriquecimento vira aviso na própria linha (via logId, nunca "a mais recente" —
    // era esse re-SELECT que carimbava status errado numa linha de OUTRO pedido quando duas
    // vendas corriam em paralelo), não um 5xx pra Digistore reagir.
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
            store.clientId, 'order.paid', 'digistore24', JSON.stringify(data.rawPayload), 'processing',
            m.totalPrice, m.currency, m.productName, m.productExternalId,
            m.utmSource, m.utmMedium, m.utmCampaign, m.utmContent, m.utmTerm,
            m.affiliateName, m.trackingCode,
          ]
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    // Responde OK agora — o dado já está seguro. Tudo daqui pra baixo é enriquecimento
    // (ActiveCampaign, SlickText, tags): importante, mas nenhuma falha nele pode fazer a
    // Digistore achar que PERDEU o evento e reenviar/desabilitar a conexão.
    res.status(200).send('OK');

    if (!data.email) {
      logger.warn(CTX, 'No email found in DS24 payload — payment stored, enrichment skipped', { orderId: data.orderId });
      await marcarEnriquecimento(logId, 'skipped', 'sem email no payload');
      return;
    }

    logger.info(CTX, `Processing DS24 payment ${data.orderId} for ${data.email}`, {
      product: data.productName, externalId, client: store.clientId,
    });

    try {
      const kit = await upsertProduct(store.clientId, 'digistore24', externalId, data.productName);

      let contact: { id: string } | null = null;
      if (!METRICS_ONLY) {
        if (!store.acApiUrl || !store.acApiKey) {
          logger.warn(CTX, 'ActiveCampaign credentials not configured — payment stored, enrichment skipped');
          await marcarEnriquecimento(logId, 'skipped', 'AC não configurado');
          return;
        }

        const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);

        contact = await ac.syncContact({
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
        });

        if (kit?.enabled) {
          const tagName = `[${kit.name}] Compra Aprovada`;
          if (kit.ac_tag_compra_id) {
            await ac.addTagToContact(contact.id, kit.ac_tag_compra_id);
          } else {
            const tag = await ac.findTagByName(tagName);
            if (tag) await ac.addTagToContact(contact.id, tag.id);
            else logger.warn(CTX, `Tag not found: ${tagName}`);
          }

          if (kit.ac_list_id) {
            await ac.addContactToList(contact.id, kit.ac_list_id);
          } else {
            const list = await ac.findListByName('Todos os contatos');
            if (list) await ac.addContactToList(contact.id, list.id);
          }

          const kitAge = Date.now() - new Date(kit.created_at).getTime();
          if (kitAge >= ONE_WEEK_MS) {
            const automationId = process.env.AC_AUTOMATION_COMPRA_APROVADA;
            if (automationId) await ac.addContactToAutomation(contact.id, automationId);
          } else {
            logger.info(CTX, `Kit "${kit.name}" < 7 days old — automation skipped`);
          }
        } else {
          logger.info(CTX, `Product "${data.productName}" not yet enabled — contact synced only`);
        }

        const address = extractDS24Address(params);
        syncSlickTextOrderPaid(store, kit, {
          phone: data.phone,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          address,
        }).then((stResult) => {
          if (stResult.synced) {
            logger.info(CTX, `SlickText synced: contact ${stResult.contactId} → list ${stResult.listId}`);
          } else {
            logger.debug(CTX, `SlickText skipped: ${stResult.reason}`);
          }
        }).catch((err) => {
          logger.warn(CTX, `SlickText sync error (non-blocking): ${err.message}`);
        });
      } else {
        logger.info(CTX, 'METRICS_ONLY — skipping AC/SlickText side effects');
      }

      await marcarEnriquecimento(logId, 'processed', null);

      if (store.storeId && store.resolvedFromDb) {
        try {
          await query(`UPDATE store_integrations SET status = 'active', updated_at = NOW() WHERE id = $1`, [store.storeId]);
        } catch (_) {}
      }

      logger.info(CTX, `✅ DS24 payment ${data.orderId} processed for ${data.email}`);
    } catch (enrichErr: any) {
      // O dinheiro já está gravado (logId). Isso aqui é "a tag não foi posta", não "a venda
      // sumiu" — grava o motivo NA LINHA CERTA e segue, sem 5xx pra Digistore reagir.
      logger.error(CTX, 'Enrichment failed (payment already stored)', enrichErr.message);
      await marcarEnriquecimento(logId, 'failed', enrichErr.message);
    }
  } catch (error: any) {
    // Só cai aqui erro ANTES da gravação (resolução de loja, assinatura) — response ainda não
    // foi enviada. Isso sim é "não sabemos nem de quem é o evento", e um 5xx genuíno.
    logger.error(CTX, 'Failed to process DS24 payment', error.message);
    res.status(500).json({ error: 'Internal processing error' });
  }
}
