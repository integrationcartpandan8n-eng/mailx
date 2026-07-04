import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { METRICS_ONLY } from '../config/env';
import { lookupStore, extractCartPandaSlug } from './store-lookup';
import { upsertProduct, extractCartPandaProductId } from './product-upsert';
import { syncSlickTextAbandonedCart, extractCartPandaAddress } from './slicktext-sync';
import { extractCartPandaMetrics } from './metrics-extract';

const CTX = 'Webhook:CardDeclined';

export async function handleCardDeclined(req: Request, res: Response, _next: NextFunction): Promise<void> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ error: 'Invalid payload: body must be a non-empty JSON object' });
    return;
  }
  const payload = req.body;
  const data = payload.order || payload;

  try {
    const slug = extractCartPandaSlug(payload);
    const store = await lookupStore('cartpanda', slug);

    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const m = extractCartPandaMetrics(payload);
        const result = await query(
          `INSERT INTO webhook_logs (
            client_id, event_type, source, payload, status,
            total_price, currency, product_name, product_external_id,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            affiliate_name, tracking_code
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [
            store.clientId, 'card.declined', 'cartpanda', JSON.stringify(payload), 'processing',
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

    const email = data.email || data.customer?.email;
    const firstName = data.first_name || data.customer?.first_name || '';
    const lastName = data.last_name || data.customer?.last_name || '';
    const phone = data.phone || data.customer?.phone || '';
    const lineItems = data.line_items || data.items || [];
    const orderId = data.id || data.order_id;

    if (!email) {
      logger.warn(CTX, 'No email found in payload', { orderId });
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    const productName = lineItems[0]?.title || lineItems[0]?.name || 'produto';
    const externalId = extractCartPandaProductId(lineItems[0]);

    logger.info(CTX, `Processing card declined for ${email}`, { product: productName, client: store.clientId });

    const kit = await upsertProduct(store.clientId, 'cartpanda', externalId, productName);

    let contact: { id: string } | null = null;
    if (!METRICS_ONLY) {
      if (!store.acApiUrl || !store.acApiKey) {
        logger.error(CTX, 'ActiveCampaign credentials not configured');
        res.status(500).json({ error: 'AC not configured' });
        return;
      }

      const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);
      contact = await ac.syncContact({ email, firstName, lastName, phone });

      if (kit?.enabled) {
        const tagName = `[${kit.name}] Cartão Recusado`;
        if (kit.ac_tag_cartao_recusado_id) {
          await ac.addTagToContact(contact.id, kit.ac_tag_cartao_recusado_id);
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
      } else {
        logger.info(CTX, `Product "${productName}" not yet enabled — contact synced only`);
      }

      const address = extractCartPandaAddress(payload);
      syncSlickTextAbandonedCart(store, kit, {
        phone,
        firstName,
        lastName,
        email,
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

    if (isDatabaseReady() && logId) {
      try {
        await query(`UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`, [logId]);
      } catch (_) {}
    }

    logger.info(CTX, `✅ Card declined processed for ${email}`);
    res.status(200).json(METRICS_ONLY ? { ok: true, mode: 'metrics_only' } : { ok: true, contactId: contact!.id });
  } catch (error: any) {
    logger.error(CTX, 'Failed to process card declined', error.message);
    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = 'failed', error = $1
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = 'card.declined' ORDER BY created_at DESC LIMIT 1)`,
          [error.message]
        );
      } catch (_) {}
    }
    res.status(500).json({ error: 'Internal processing error' });
  }
}
