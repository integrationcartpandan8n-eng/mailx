/**
 * Digistore24 Refund/Chargeback Handler
 *
 * Processes IPN notifications for 'refund' and 'chargeback' events.
 * Tags the contact in ActiveCampaign with a refund tag.
 *
 * Endpoint: POST /webhook/digistore24/refund
 *
 * Multi-tenant: Uses store_integrations to find per-client credentials.
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { validateSignature, normalizePayload } from '../services/digistore24';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractDS24Identifier } from './store-lookup';

const CTX = 'Webhook:DS24:Refund';

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
    const eventType = params.event === 'chargeback' ? 'order.chargeback' : 'order.refunded';

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
          `INSERT INTO webhook_logs (event_type, source, payload, status) VALUES ($1, $2, $3, $4) RETURNING id`,
          [eventType, 'digistore24', JSON.stringify(data.rawPayload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook', dbErr.message);
      }
    }

    // 5. Tag contact in AC (per-client credentials)
    if (store.acApiUrl && store.acApiKey) {
      const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);

      const contact = await ac.syncContact({ email: data.email });

      const tagName = `reembolso-kit-${data.productSlug}`;
      const tag = await ac.findTagByName(tagName);
      if (tag) {
        await ac.addTagToContact(contact.id, tag.id);
      } else {
        const genericTag = await ac.findTagByName('reembolso');
        if (genericTag) {
          await ac.addTagToContact(contact.id, genericTag.id);
        }
        logger.warn(CTX, `Tag not found: ${tagName}`);
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
