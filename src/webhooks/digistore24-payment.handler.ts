/**
 * Digistore24 Payment Handler
 *
 * Processes IPN notifications for the 'payment' and 'rebilling' events.
 * Pipeline: Identify Store → Validate Signature → Normalize → Log to DB → Sync to ActiveCampaign
 *
 * Endpoint: POST /webhook/digistore24/payment
 *
 * Multi-tenant: Uses store_integrations to find per-client credentials.
 * The api_token field in store_integrations stores the DS24 IPN passphrase.
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { validateSignature, normalizePayload } from '../services/digistore24';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractDS24Identifier } from './store-lookup';

const CTX = 'Webhook:DS24:Payment';

export async function handleDS24Payment(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const params = { ...req.body, ...req.query };

  try {
    // 1. Identify the store from the payload
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
    } else {
      logger.warn(CTX, '⚠️ No IPN passphrase configured — skipping signature validation');
    }

    // 3. Normalize payload
    const data = normalizePayload(params);

    if (!data.email) {
      logger.warn(CTX, 'No email found in DS24 payload', { orderId: data.orderId });
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    logger.info(CTX, `Processing DS24 payment ${data.orderId} for ${data.email}`, {
      product: data.productName,
      amount: data.totalPrice,
      client: store.clientId,
    });

    // 4. Log to DB
    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const result = await query(
          `INSERT INTO webhook_logs (event_type, source, payload, status) VALUES ($1, $2, $3, $4) RETURNING id`,
          ['order.paid', 'digistore24', JSON.stringify(data.rawPayload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    // 5. Sync to ActiveCampaign (per-client credentials)
    if (!store.acApiUrl || !store.acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured for this client');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);

    // 5a. Sync contact
    const contact = await ac.syncContact({
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
    });

    // 5b. Add purchase tag
    const tagName = `comprou-kit-${data.productSlug}`;
    const tag = await ac.findTagByName(tagName);
    if (tag) {
      await ac.addTagToContact(contact.id, tag.id);
    } else {
      logger.warn(CTX, `Tag not found: ${tagName} — skipping`);
    }

    // 5c. Add to "Todos os contatos" list
    const mainList = await ac.findListByName('Todos os contatos');
    if (mainList) {
      await ac.addContactToList(contact.id, mainList.id);
    }

    // 5d. Trigger automation
    const automationId = process.env.AC_AUTOMATION_COMPRA_APROVADA;
    if (automationId) {
      await ac.addContactToAutomation(contact.id, automationId);
    }

    // 6. Update webhook log
    if (isDatabaseReady() && logId) {
      try {
        await query(
          `UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`,
          [logId]
        );
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to update webhook log', dbErr.message);
      }
    }

    // Auto-activate store on first successful webhook
    if (store.storeId && store.resolvedFromDb) {
      try {
        await query(`UPDATE store_integrations SET status = 'active', updated_at = NOW() WHERE id = $1`, [store.storeId]);
      } catch (_) {}
    }

    logger.info(CTX, `✅ DS24 payment ${data.orderId} processed for ${data.email}`);
    res.status(200).json({ ok: true, contactId: contact.id });
  } catch (error: any) {
    logger.error(CTX, 'Failed to process DS24 payment', error.message);

    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = 'failed', error = $1 
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = 'order.paid' AND source = 'digistore24' ORDER BY created_at DESC LIMIT 1)`,
          [error.message]
        );
      } catch (_) { /* best-effort */ }
    }

    res.status(500).json({ error: 'Internal processing error' });
  }
}
