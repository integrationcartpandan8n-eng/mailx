/**
 * Digistore24 Payment Handler
 *
 * Processes IPN notifications for the 'payment' and 'rebilling' events.
 * Pipeline: Validate → Normalize → Log to DB → Sync to ActiveCampaign
 *
 * Endpoint: POST /webhook/digistore24/payment
 *
 * The Digistore24 admin sends IPN data as form-encoded POST body.
 * This handler:
 *   1. Validates the sha_sign to ensure authenticity
 *   2. Normalizes DS24 fields to our standard format
 *   3. Logs the webhook to webhook_logs with source='digistore24'
 *   4. Syncs the contact to ActiveCampaign
 *   5. Adds purchase tag and list membership
 *   6. Triggers the purchase automation
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { validateSignature, normalizePayload } from '../services/digistore24';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const CTX = 'Webhook:DS24:Payment';

export async function handleDS24Payment(req: Request, res: Response, _next: NextFunction): Promise<void> {
  // DS24 sends data as form-encoded body (express.urlencoded parses this)
  const params = { ...req.body, ...req.query };

  try {
    // 1. Validate signature (skip in dev if no passphrase configured)
    if (env.DS24_IPN_PASSPHRASE) {
      if (!validateSignature(params, env.DS24_IPN_PASSPHRASE)) {
        logger.warn(CTX, 'Invalid IPN signature — rejecting');
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
    } else {
      logger.warn(CTX, '⚠️ DS24_IPN_PASSPHRASE not set — skipping signature validation');
    }

    // 2. Normalize payload
    const data = normalizePayload(params);

    if (!data.email) {
      logger.warn(CTX, 'No email found in DS24 payload', { orderId: data.orderId });
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    logger.info(CTX, `Processing DS24 payment ${data.orderId} for ${data.email}`, {
      product: data.productName,
      amount: data.totalPrice,
    });

    // 3. Log to DB
    if (isDatabaseReady()) {
      try {
        await query(
          `INSERT INTO webhook_logs (event_type, source, payload, status) VALUES ($1, $2, $3, $4)`,
          ['order.paid', 'digistore24', JSON.stringify(data.rawPayload), 'processing']
        );
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    // 4. Sync to ActiveCampaign
    const acApiUrl = process.env.AC_API_URL;
    const acApiKey = process.env.AC_API_KEY;

    if (!acApiUrl || !acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    const ac = new ActiveCampaignClient(acApiUrl, acApiKey);

    // 4a. Sync contact
    const contact = await ac.syncContact({
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
    });

    // 4b. Add purchase tag
    const tagName = `comprou-kit-${data.productSlug}`;
    const tag = await ac.findTagByName(tagName);
    if (tag) {
      await ac.addTagToContact(contact.id, tag.id);
    } else {
      logger.warn(CTX, `Tag not found: ${tagName} — skipping`);
    }

    // 4c. Add to "Todos os contatos" list
    const mainList = await ac.findListByName('Todos os contatos');
    if (mainList) {
      await ac.addContactToList(contact.id, mainList.id);
    }

    // 4d. Trigger automation
    const automationId = process.env.AC_AUTOMATION_COMPRA_APROVADA;
    if (automationId) {
      await ac.addContactToAutomation(contact.id, automationId);
    }

    // 5. Update webhook log
    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = $1, processed_at = NOW() 
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = $2 AND source = 'digistore24' ORDER BY created_at DESC LIMIT 1)`,
          ['processed', 'order.paid']
        );
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to update webhook log', dbErr.message);
      }
    }

    logger.info(CTX, `✅ DS24 payment ${data.orderId} processed for ${data.email}`);
    res.status(200).json({ ok: true, contactId: contact.id });
  } catch (error: any) {
    logger.error(CTX, 'Failed to process DS24 payment', error.message);

    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = $1, error = $2 
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = $3 AND source = 'digistore24' ORDER BY created_at DESC LIMIT 1)`,
          ['failed', error.message, 'order.paid']
        );
      } catch (_) { /* best-effort */ }
    }

    res.status(500).json({ error: 'Internal processing error' });
  }
}
