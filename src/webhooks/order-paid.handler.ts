import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractCartPandaSlug } from './store-lookup';

const CTX = 'Webhook:OrderPaid';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function handleOrderPaid(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const payload = req.body;

  try {
    // 1. Identify the store from the payload
    const slug = extractCartPandaSlug(payload);
    const store = await lookupStore('cartpanda', slug);

    // Log webhook to DB with client association
    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const result = await query(
          `INSERT INTO webhook_logs (event_type, source, payload, status) VALUES ($1, $2, $3, $4) RETURNING id`,
          ['order.paid', 'cartpanda', JSON.stringify(payload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    // 2. Extract data from CartPanda payload
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
    const productSlug = slugify(productName);

    logger.info(CTX, `Processing order ${orderId} for ${email}`, {
      product: productName,
      client: store.clientId,
      resolvedFromDb: store.resolvedFromDb,
    });

    // 3. Get AC credentials (per-client from store lookup)
    if (!store.acApiUrl || !store.acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured for this client');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);

    // 4. Sync contact
    const contact = await ac.syncContact({ email, firstName, lastName, phone });

    // 5. Add purchase tag
    const tagName = `comprou-kit-${productSlug}`;
    const tag = await ac.findTagByName(tagName);
    if (tag) {
      await ac.addTagToContact(contact.id, tag.id);
    } else {
      logger.warn(CTX, `Tag not found: ${tagName} — skipping tag assignment`);
    }

    // 6. Add to buyers list
    const listName = `Compradores - ${productName}`;
    const list = await ac.findListByName(listName);
    if (list) {
      await ac.addContactToList(contact.id, list.id);
    } else {
      const genericList = await ac.findListByName('Todos os contatos');
      if (genericList) {
        await ac.addContactToList(contact.id, genericList.id);
      }
      logger.warn(CTX, `List not found: ${listName} — tried Todos os contatos`);
    }

    // 7. Trigger purchase automation
    const automationId = process.env.AC_AUTOMATION_COMPRA_APROVADA;
    if (automationId) {
      await ac.addContactToAutomation(contact.id, automationId);
    }

    // Update webhook log
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

    // Auto-activate store integration on first successful webhook
    if (store.storeId && store.resolvedFromDb) {
      try {
        await query(`UPDATE store_integrations SET status = 'active', updated_at = NOW() WHERE id = $1`, [store.storeId]);
      } catch (_) {}
    }

    logger.info(CTX, `✅ Order ${orderId} processed successfully for ${email}`);
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
      } catch (_) { /* best-effort */ }
    }

    res.status(500).json({ error: 'Internal processing error' });
  }
}
