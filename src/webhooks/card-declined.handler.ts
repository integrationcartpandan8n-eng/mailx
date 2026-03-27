import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractCartPandaSlug } from './store-lookup';
import { upsertProduct, extractCartPandaProductId } from './product-upsert';

const CTX = 'Webhook:CardDeclined';

export async function handleCardDeclined(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const payload = req.body;

  try {
    const slug = extractCartPandaSlug(payload);
    const store = await lookupStore('cartpanda', slug);

    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const result = await query(
          `INSERT INTO webhook_logs (client_id, event_type, source, payload, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [store.clientId, 'card.declined', 'cartpanda', JSON.stringify(payload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    const email = payload.email || payload.customer?.email;
    const firstName = payload.first_name || payload.customer?.first_name || '';
    const lastName = payload.last_name || payload.customer?.last_name || '';
    const phone = payload.phone || payload.customer?.phone || '';
    const lineItems = payload.line_items || payload.items || [];
    const orderId = payload.id || payload.order_id;

    if (!email) {
      logger.warn(CTX, 'No email found in payload', { orderId });
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    const productName = lineItems[0]?.title || lineItems[0]?.name || 'produto';
    const externalId = extractCartPandaProductId(lineItems[0]);

    logger.info(CTX, `Processing card declined for ${email}`, { product: productName, client: store.clientId });

    if (!store.acApiUrl || !store.acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    const kit = await upsertProduct(store.clientId, 'cartpanda', externalId, productName);

    const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);
    const contact = await ac.syncContact({ email, firstName, lastName, phone });

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

    if (isDatabaseReady() && logId) {
      try {
        await query(`UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`, [logId]);
      } catch (_) {}
    }

    logger.info(CTX, `✅ Card declined processed for ${email}`);
    res.status(200).json({ ok: true, contactId: contact.id });
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
