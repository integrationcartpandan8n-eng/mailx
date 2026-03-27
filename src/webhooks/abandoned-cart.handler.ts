import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractCartPandaSlug } from './store-lookup';
import { upsertProduct, extractCartPandaProductId } from './product-upsert';

const CTX = 'Webhook:AbandonedCart';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function handleAbandonedCart(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const payload = req.body;

  try {
    const slug = extractCartPandaSlug(payload);
    const store = await lookupStore('cartpanda', slug);

    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const result = await query(
          `INSERT INTO webhook_logs (client_id, event_type, source, payload, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [store.clientId, 'abandoned_cart', 'cartpanda', JSON.stringify(payload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    const email = payload.email || payload.customer?.email;
    const firstName = payload.first_name || payload.customer?.first_name || '';
    const cartItems = payload.cart_items || payload.line_items || payload.items || [];

    if (!email) {
      logger.warn(CTX, 'No email found in abandoned cart payload');
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    const productName = cartItems[0]?.title || cartItems[0]?.name || 'produto';
    const externalId = extractCartPandaProductId(cartItems[0]);

    logger.info(CTX, `Processing abandoned cart for ${email}`, { product: productName, client: store.clientId });

    if (!store.acApiUrl || !store.acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    const kit = await upsertProduct(store.clientId, 'cartpanda', externalId, productName);

    const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);
    const contact = await ac.syncContact({ email, firstName });

    if (kit?.enabled) {
      const tagName = `[${kit.name}] Abandono`;
      if (kit.ac_tag_abandono_id) {
        await ac.addTagToContact(contact.id, kit.ac_tag_abandono_id);
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
        const automationId = process.env.AC_AUTOMATION_CARRINHO_ABANDONADO;
        if (automationId) await ac.addContactToAutomation(contact.id, automationId);
      } else {
        logger.info(CTX, `Kit "${kit.name}" < 7 days old — automation skipped`);
      }
    } else {
      logger.info(CTX, `Product "${productName}" not yet enabled — contact synced only`);
    }

    if (isDatabaseReady() && logId) {
      try {
        await query(`UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`, [logId]);
      } catch (_) {}
    }

    logger.info(CTX, `✅ Abandoned cart processed for ${email}`);
    res.status(200).json({ ok: true, contactId: contact.id });
  } catch (error: any) {
    logger.error(CTX, 'Failed to process abandoned cart', error.message);
    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = 'failed', error = $1
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = 'abandoned_cart' ORDER BY created_at DESC LIMIT 1)`,
          [error.message]
        );
      } catch (_) {}
    }
    res.status(500).json({ error: 'Internal processing error' });
  }
}
