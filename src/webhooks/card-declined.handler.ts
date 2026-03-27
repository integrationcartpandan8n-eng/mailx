import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import { query, queryOne, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore, extractCartPandaSlug } from './store-lookup';

const CTX = 'Webhook:CardDeclined';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface KitRow {
  id: number;
  name: string;
  slug: string;
  ac_list_id: string | null;
  ac_tag_cartao_recusado_id: string | null;
}

export async function handleCardDeclined(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const payload = req.body;

  try {
    // 1. Identify the store from the payload
    const slug = extractCartPandaSlug(payload);
    const store = await lookupStore('cartpanda', slug);

    // Log webhook to DB
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
    const productSlug = slugify(productName);

    logger.info(CTX, `Processing card declined for ${email}`, {
      product: productName,
      client: store.clientId,
    });

    // 3. Get AC credentials
    if (!store.acApiUrl || !store.acApiKey) {
      logger.error(CTX, 'ActiveCampaign credentials not configured for this client');
      res.status(500).json({ error: 'AC not configured' });
      return;
    }

    // 4. Look up kit in DB
    const kit = store.clientId ? await queryOne<KitRow>(
      `SELECT id, name, slug, ac_list_id, ac_tag_cartao_recusado_id FROM kits WHERE client_id = $1 AND slug = $2`,
      [store.clientId, productSlug]
    ) : null;

    const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);

    // 5. Sync contact
    const contact = await ac.syncContact({ email, firstName, lastName, phone });

    // 6. Add "Cartão Recusado" tag
    const tagName = `[${kit?.name || productName}] Cartão Recusado`;
    if (kit?.ac_tag_cartao_recusado_id) {
      await ac.addTagToContact(contact.id, kit.ac_tag_cartao_recusado_id);
    } else {
      const tag = await ac.findTagByName(tagName);
      if (tag) {
        await ac.addTagToContact(contact.id, tag.id);
      } else {
        logger.warn(CTX, `Tag not found: ${tagName} — skipping tag assignment`);
      }
    }

    // 7. Add to "Todos os contatos" list (not newsletter)
    const listId = kit?.ac_list_id ?? null;
    if (listId) {
      await ac.addContactToList(contact.id, listId);
    } else {
      const list = await ac.findListByName('Todos os contatos');
      if (list) {
        await ac.addContactToList(contact.id, list.id);
      }
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
      } catch (_) { /* best-effort */ }
    }

    res.status(500).json({ error: 'Internal processing error' });
  }
}
