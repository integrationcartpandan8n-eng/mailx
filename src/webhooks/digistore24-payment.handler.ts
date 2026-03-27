/**
 * Digistore24 Payment Handler
 * Endpoint: POST /webhook/digistore24/payment
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { validateSignature, normalizePayload } from '../services/digistore24';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractDS24Identifier } from './store-lookup';
import { upsertProduct, extractDS24ProductId } from './product-upsert';

const CTX = 'Webhook:DS24:Payment';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function handleDS24Payment(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const params = { ...req.body, ...req.query };

  try {
    // 1. Identify store
    const identifier = extractDS24Identifier(params);
    const store = await lookupStore('digistore24', identifier);

    // 2. Validate signature
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

    // 3. Normalize
    const data = normalizePayload(params);

    if (!data.email) {
      logger.warn(CTX, 'No email found in DS24 payload', { orderId: data.orderId });
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    const externalId = extractDS24ProductId(params);

    logger.info(CTX, `Processing DS24 payment ${data.orderId} for ${data.email}`, {
      product: data.productName,
      externalId,
      client: store.clientId,
    });

    // 4. Log to DB
    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const result = await query(
          `INSERT INTO webhook_logs (client_id, event_type, source, payload, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [store.clientId, 'order.paid', 'digistore24', JSON.stringify(data.rawPayload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    if (!store.acApiUrl || !store.acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    // 5. Upsert product (auto-discovery)
    const kit = await upsertProduct(store.clientId, 'digistore24', externalId, data.productName);

    const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);

    // 6. Sync contact (always)
    const contact = await ac.syncContact({
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
    });

    // 7. Tags, list, automation — only if enabled
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

    if (isDatabaseReady() && logId) {
      try {
        await query(`UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`, [logId]);
      } catch (_) {}
    }

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
      } catch (_) {}
    }
    res.status(500).json({ error: 'Internal processing error' });
  }
}
