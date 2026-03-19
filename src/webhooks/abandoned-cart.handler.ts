import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractCartPandaSlug } from './store-lookup';

const CTX = 'Webhook:AbandonedCart';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function handleAbandonedCart(req: Request, res: Response, _next: NextFunction): Promise<void> {
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
          `INSERT INTO webhook_logs (event_type, source, payload, status) VALUES ($1, $2, $3, $4) RETURNING id`,
          ['abandoned_cart', 'cartpanda', JSON.stringify(payload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    // 2. Extract data
    const email = payload.email || payload.customer?.email;
    const firstName = payload.first_name || payload.customer?.first_name || '';
    const cartItems = payload.cart_items || payload.line_items || payload.items || [];

    if (!email) {
      logger.warn(CTX, 'No email found in abandoned cart payload');
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    const productName = cartItems[0]?.title || cartItems[0]?.name || 'produto';
    const productSlug = slugify(productName);

    logger.info(CTX, `Processing abandoned cart for ${email}`, {
      product: productName,
      client: store.clientId,
    });

    // 3. Get AC credentials (per-client)
    if (!store.acApiUrl || !store.acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured for this client');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);

    // 4. Sync contact
    const contact = await ac.syncContact({ email, firstName });

    // 5. Add abandonment tag
    const tagName = `carrinho-abandonado-kit-${productSlug}`;
    const tag = await ac.findTagByName(tagName);
    if (tag) {
      await ac.addTagToContact(contact.id, tag.id);
    } else {
      const genericTag = await ac.findTagByName('carrinho-abandonado');
      if (genericTag) {
        await ac.addTagToContact(contact.id, genericTag.id);
      }
      logger.warn(CTX, `Tag not found: ${tagName}`);
    }

    // 6. Add to abandoned cart list
    const list = await ac.findListByName('Carrinho Abandonado');
    if (list) {
      await ac.addContactToList(contact.id, list.id);
    }

    // 7. Trigger abandoned cart automation
    const automationId = process.env.AC_AUTOMATION_CARRINHO_ABANDONADO;
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
      } catch (_) { /* best-effort */ }
    }

    res.status(500).json({ error: 'Internal processing error' });
  }
}
