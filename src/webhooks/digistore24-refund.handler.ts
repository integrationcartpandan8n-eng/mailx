/**
 * Digistore24 Refund/Chargeback Handler
 *
 * Processes IPN notifications for 'refund' and 'chargeback' events.
 * Tags the contact in ActiveCampaign: [Product] Reembolso or [Product] Chargeback.
 *
 * Endpoint: POST /webhook/digistore24/refund
 *
 * Multi-tenant: Uses store_integrations to find per-client credentials.
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { validateSignature, normalizePayload } from '../services/digistore24';
import { query, queryOne, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractDS24Identifier } from './store-lookup';

const CTX = 'Webhook:DS24:Refund';

interface KitRow {
  id: number;
  name: string;
  slug: string;
  ac_tag_reembolso_id: string | null;
  ac_tag_chargeback_id: string | null;
}

export async function handleDS24Refund(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const params = { ...req.body, ...req.query };

  try {
    // 1. Identify the store
    const identifier = extractDS24Identifier(params);
    const store = await lookupStore('digistore24', identifier);

    // 2. Validate signature using per-client passphrase
    const passphrase = store.apiToken || process.env.DS24_IPN_PASSPHRASE || '';
    if (passphrase) {
      if (!validateSignature(params, passphrase)) {
        logger.warn(CTX, 'Invalid IPN signature — rejecting');
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
    }

    // 3. Normalize
    const data = normalizePayload(params);
    const isChargeback = params.event === 'chargeback';
    const eventType = isChargeback ? 'order.chargeback' : 'order.refunded';

    if (!data.email) {
      res.status(400).json({ error: 'Missing email' });
      return;
    }

    logger.info(CTX, `Processing DS24 ${eventType} for ${data.email}`, {
      orderId: data.orderId,
      client: store.clientId,
    });

    // 4. Log to DB
    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const result = await query(
          `INSERT INTO webhook_logs (client_id, event_type, source, payload, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [store.clientId, eventType, 'digistore24', JSON.stringify(data.rawPayload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook', dbErr.message);
      }
    }

    // 5. Tag contact in AC (per-client credentials)
    if (store.acApiUrl && store.acApiKey) {
      // Look up kit in DB
      const kit = store.clientId ? await queryOne<KitRow>(
        `SELECT id, name, slug, ac_tag_reembolso_id, ac_tag_chargeback_id FROM kits WHERE client_id = $1 AND slug = $2`,
        [store.clientId, data.productSlug]
      ) : null;

      const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);
      const contact = await ac.syncContact({ email: data.email });

      const tagName = isChargeback
        ? `[${kit?.name || data.productName}] Chargeback`
        : `[${kit?.name || data.productName}] Reembolso`;

      const storedTagId = isChargeback ? kit?.ac_tag_chargeback_id : kit?.ac_tag_reembolso_id;

      if (storedTagId) {
        await ac.addTagToContact(contact.id, storedTagId);
      } else {
        const tag = await ac.findTagByName(tagName);
        if (tag) {
          await ac.addTagToContact(contact.id, tag.id);
        } else {
          logger.warn(CTX, `Tag not found: ${tagName}`);
        }
      }
    }

    // 6. Update log
    if (isDatabaseReady() && logId) {
      try {
        await query(
          `UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`,
          [logId]
        );
      } catch (_) {}
    }

    logger.info(CTX, `✅ DS24 ${eventType} processed for ${data.email}`);
    res.status(200).json({ ok: true });
  } catch (error: any) {
    logger.error(CTX, `Failed to process DS24 refund`, error.message);

    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = 'failed', error = $1
           WHERE id = (SELECT id FROM webhook_logs WHERE source = 'digistore24' ORDER BY created_at DESC LIMIT 1)`,
          [error.message]
        );
      } catch (_) {}
    }

    res.status(500).json({ error: 'Internal processing error' });
  }
}
