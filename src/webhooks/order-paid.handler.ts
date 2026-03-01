import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';

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
    // Log webhook to DB (non-critical — don't fail if DB is down)
    if (isDatabaseReady()) {
      try {
        await query(
          `INSERT INTO webhook_logs (event_type, source, payload, status) VALUES ($1, $2, $3, $4)`,
          ['order.paid', 'cartpanda', JSON.stringify(payload), 'processing']
        );
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook to DB', dbErr.message);
      }
    }

    // Extract data from CartPanda payload
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

    logger.info(CTX, `Processing order ${orderId} for ${email}`, { product: productName });

    // Get AC credentials
    const acApiUrl = process.env.AC_API_URL;
    const acApiKey = process.env.AC_API_KEY;

    if (!acApiUrl || !acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    const ac = new ActiveCampaignClient(acApiUrl, acApiKey);

    // 1. Sync contact
    const contact = await ac.syncContact({
      email,
      firstName,
      lastName,
      phone,
    });

    // 2. Add purchase tag
    const tagName = `comprou-kit-${productSlug}`;
    const tag = await ac.findTagByName(tagName);
    if (tag) {
      await ac.addTagToContact(contact.id, tag.id);
    } else {
      logger.warn(CTX, `Tag not found: ${tagName} — skipping tag assignment`);
    }

    // 3. Add to buyers list
    const listName = `Compradores - ${productName}`;
    const list = await ac.findListByName(listName);
    if (list) {
      await ac.addContactToList(contact.id, list.id);
    } else {
      const genericList = await ac.findListByName('Newsletter Geral');
      if (genericList) {
        await ac.addContactToList(contact.id, genericList.id);
      }
      logger.warn(CTX, `List not found: ${listName} — tried Newsletter Geral`);
    }

    // 4. Trigger purchase automation
    const automationId = process.env.AC_AUTOMATION_COMPRA_APROVADA;
    if (automationId) {
      await ac.addContactToAutomation(contact.id, automationId);
    }

    // Update webhook log
    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = $1, processed_at = NOW() 
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = $2 ORDER BY created_at DESC LIMIT 1)`,
          ['processed', 'order.paid']
        );
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to update webhook log', dbErr.message);
      }
    }

    logger.info(CTX, `✅ Order ${orderId} processed successfully for ${email}`);
    res.status(200).json({ ok: true, contactId: contact.id });
  } catch (error: any) {
    logger.error(CTX, 'Failed to process order', error.message);

    if (isDatabaseReady()) {
      try {
        await query(
          `UPDATE webhook_logs SET status = $1, error = $2 
           WHERE id = (SELECT id FROM webhook_logs WHERE event_type = $3 ORDER BY created_at DESC LIMIT 1)`,
          ['failed', error.message, 'order.paid']
        );
      } catch (_) { /* best-effort */ }
    }

    res.status(500).json({ error: 'Internal processing error' });
  }
}
