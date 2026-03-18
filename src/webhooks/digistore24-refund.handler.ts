/**
 * Digistore24 Refund/Chargeback Handler
 *
 * Processes IPN notifications for 'refund' and 'chargeback' events.
 * Tags the contact in ActiveCampaign with a refund tag.
 *
 * Endpoint: POST /webhook/digistore24/refund
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { validateSignature, normalizePayload } from '../services/digistore24';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const CTX = 'Webhook:DS24:Refund';

export async function handleDS24Refund(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const params = { ...req.body, ...req.query };

  try {
    // 1. Validate signature
    if (env.DS24_IPN_PASSPHRASE) {
      if (!validateSignature(params, env.DS24_IPN_PASSPHRASE)) {
        logger.warn(CTX, 'Invalid IPN signature — rejecting');
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
    }

    // 2. Normalize
    const data = normalizePayload(params);
    const eventType = params.event === 'chargeback' ? 'order.chargeback' : 'order.refunded';

    if (!data.email) {
      res.status(400).json({ error: 'Missing email' });
      return;
    }

    logger.info(CTX, `Processing DS24 ${eventType} for ${data.email}`, { orderId: data.orderId });

    // 3. Log to DB
    if (isDatabaseReady()) {
      try {
        await query(
          `INSERT INTO webhook_logs (event_type, source, payload, status) VALUES ($1, $2, $3, $4)`,
          [eventType, 'digistore24', JSON.stringify(data.rawPayload), 'processing']
        );
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook', dbErr.message);
      }
    }

    // 4. Tag contact in AC
    const acApiUrl = process.env.AC_API_URL;
    const acApiKey = process.env.AC_API_KEY;

    if (acApiUrl && acApiKey) {
      const ac = new ActiveCampaignClient(acApiUrl, acApiKey);

      // Sync contact (if exists)
      const contact = await ac.syncContact({ email: data.email });

      // Add refund tag
      const tagName = `reembolso-kit-${data.productSlug}`;
      const tag = await ac.findTagByName(tagName);
      if (tag) {
        await ac.addTagToContact(contact.id, tag.id);
      } else {
        // Try generic refund tag
        const genericTag = await ac.findTagByName('reembolso');
        if (genericTag) {
          await ac.addTagToContact(contact.id, genericTag.id);
        }
        logger.warn(CTX, `Tag not found: ${tagName}`);
      }
    }

    // 5. Update log
    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = 'processed', processed_at = NOW()
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = $1 AND source = 'digistore24' ORDER BY created_at DESC LIMIT 1)`,
          [eventType]
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
