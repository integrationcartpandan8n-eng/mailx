import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';

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
    // Log webhook to DB (non-critical)
    if (isDatabaseReady()) {
      try {
        await query(
          `INSERT INTO webhook_logs (event_type, source, payload, status) VALUES ($1, $2, $3, $4)`,
          ['abandoned_cart', 'cartpanda', JSON.stringify(payload), 'processing']
        );
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    const email = payload.email || payload.customer?.email;
    const firstName = payload.first_name || payload.customer?.first_name || '';
    const cartItems = payload.cart_items || payload.line_items || payload.items || [];
    const checkoutUrl = payload.checkout_url || payload.abandoned_checkout_url || '';

    if (!email) {
      logger.warn(CTX, 'No email found in abandoned cart payload');
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    const productName = cartItems[0]?.title || cartItems[0]?.name || 'produto';
    const productSlug = slugify(productName);

    logger.info(CTX, `Processing abandoned cart for ${email}`, { product: productName });

    const acApiUrl = process.env.AC_API_URL;
    const acApiKey = process.env.AC_API_KEY;

    if (!acApiUrl || !acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    const ac = new ActiveCampaignClient(acApiUrl, acApiKey);

    // 1. Sync contact
    const contact = await ac.syncContact({ email, firstName });

    // 2. Add abandonment tag
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

    // 3. Add to abandoned cart list
    const list = await ac.findListByName('Carrinho Abandonado');
    if (list) {
      await ac.addContactToList(contact.id, list.id);
    }

    // 4. Trigger abandoned cart automation
    const automationId = process.env.AC_AUTOMATION_CARRINHO_ABANDONADO;
    if (automationId) {
      await ac.addContactToAutomation(contact.id, automationId);
    }

    // Update webhook log
    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = $1, processed_at = NOW() 
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = $2 ORDER BY created_at DESC LIMIT 1)`,
          ['processed', 'abandoned_cart']
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
          `UPDATE webhook_logs SET status = $1, error = $2 
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = $3 ORDER BY created_at DESC LIMIT 1)`,
          ['failed', error.message, 'abandoned_cart']
        );
      } catch (_) { /* best-effort */ }
    }

    res.status(500).json({ error: 'Internal processing error' });
  }
}
