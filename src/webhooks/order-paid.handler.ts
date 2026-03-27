import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractCartPandaSlug } from './store-lookup';
import { upsertProduct, extractCartPandaProductId } from './product-upsert';

const CTX = 'Webhook:OrderPaid';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function handleOrderPaid(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const payload = req.body;

  try {
    // 1. Identify the store
    const slug = extractCartPandaSlug(payload);
    const store = await lookupStore('cartpanda', slug);

    // Log webhook to DB
    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const result = await query(
          `INSERT INTO webhook_logs (client_id, event_type, source, payload, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [store.clientId, 'order.paid', 'cartpanda', JSON.stringify(payload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    // 2. Extract data
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

    logger.info(CTX, `Processing order ${orderId} for ${email}`, {
      product: productName,
      externalId,
      client: store.clientId,
    });

    // 3. Validate AC credentials
    if (!store.acApiUrl || !store.acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured for this client');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    // 4. Upsert product (auto-discovery)
    const kit = await upsertProduct(store.clientId, 'cartpanda', externalId, productName);

    const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);

    // 5. Sync contact (always)
    const contact = await ac.syncContact({ email, firstName, lastName, phone });

    // 6. Tags, list, automation — only if product is enabled by admin
    if (kit?.enabled) {
      // Tag: [Product] Compra Aprovada
      const tagName = `[${kit.name}] Compra Aprovada`;
      if (kit.ac_tag_compra_id) {
        await ac.addTagToContact(contact.id, kit.ac_tag_compra_id);
      } else {
        const tag = await ac.findTagByName(tagName);
        if (tag) await ac.addTagToContact(contact.id, tag.id);
        else logger.warn(CTX, `Tag not found: ${tagName}`);
      }

      // List: Todos os contatos
      if (kit.ac_list_id) {
        await ac.addContactToList(contact.id, kit.ac_list_id);
      } else {
        const list = await ac.findListByName('Todos os contatos');
        if (list) await ac.addContactToList(contact.id, list.id);
      }

      // Automation: only if kit > 1 week old
      const kitAge = Date.now() - new Date(kit.created_at).getTime();
      if (kitAge >= ONE_WEEK_MS) {
        const automationId = process.env.AC_AUTOMATION_COMPRA_APROVADA;
        if (automationId) await ac.addContactToAutomation(contact.id, automationId);
      } else {
        logger.info(CTX, `Kit "${kit.name}" < 7 days old — automation skipped`);
      }
    } else {
      logger.info(CTX, `Product "${productName}" not yet enabled by admin — contact synced only`);
    }

    // Update webhook log
    if (isDatabaseReady() && logId) {
      try {
        await query(`UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`, [logId]);
      } catch (_) {}
    }

    // Auto-activate store integration
    if (store.storeId && store.resolvedFromDb) {
      try {
        await query(`UPDATE store_integrations SET status = 'active', updated_at = NOW() WHERE id = $1`, [store.storeId]);
      } catch (_) {}
    }

    logger.info(CTX, `✅ Order ${orderId} processed for ${email}`);
    res.status(200).json({ ok: true, contactId: contact.id });
  } catch (error: any) {
    logger.error(CTX, 'Failed to process order', error.message);
    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = 'failed', error = $1
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = 'order.paid' ORDER BY created_at DESC LIMIT 1)`,
          [error.message]
        );
      } catch (_) {}
    }
    res.status(500).json({ error: 'Internal processing error' });
  }
}
