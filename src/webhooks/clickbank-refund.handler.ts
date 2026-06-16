/**
 * ClickBank Refund/Chargeback Handler
 * Handles RFND, CGBK, INSF events from ClickBank INS.
 * Endpoint: POST /webhook/clickbank/refund
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import {
  decryptINS,
  normalizePayload,
  isRefund,
  isTestEvent,
  extractVendor,
} from '../services/clickbank';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore } from './store-lookup';
import { upsertProduct } from './product-upsert';

const CTX = 'Webhook:ClickBank:Refund';

export async function handleClickBankRefund(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const rawBody = req.body;

  try {
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      res.status(400).json({ error: 'Invalid ClickBank INS payload' });
      return;
    }

    if (!rawBody.notification || !rawBody.iv) {
      res.status(400).json({ error: 'Invalid ClickBank INS payload' });
      return;
    }

    // Try decrypting with known ClickBank integrations
    let data: ReturnType<typeof normalizePayload> | null = null;
    let store: Awaited<ReturnType<typeof lookupStore>> | null = null;

    const cbStores = await query<{ shop_slug: string; api_token: string }>(
      `SELECT shop_slug, api_token FROM store_integrations WHERE platform = 'clickbank' AND api_token != ''`
    );

    for (const cbStore of cbStores) {
      try {
        const decrypted = decryptINS(cbStore.api_token, rawBody);
        data = normalizePayload(decrypted);
        store = await lookupStore('clickbank', extractVendor(decrypted));
        break;
      } catch {
        // Wrong key — try next
      }
    }

    if (!data) {
      const fallbackKey = process.env.CLICKBANK_INS_SECRET || '';
      if (fallbackKey) {
        try {
          const decrypted = decryptINS(fallbackKey, rawBody);
          data = normalizePayload(decrypted);
          store = await lookupStore('clickbank', extractVendor(decrypted));
        } catch (_) {}
      }
    }

    if (!data || !store) {
      res.status(403).json({ error: 'Decryption failed' });
      return;
    }

    if (isTestEvent(data.transactionType)) {
      res.status(200).json({ ok: true, test: true });
      return;
    }

    if (!isRefund(data.transactionType)) {
      res.status(200).json({ ok: true, ignored: data.transactionType });
      return;
    }

    const isChargeback = data.transactionType === 'CGBK' || data.transactionType === 'INSF';
    const eventType = isChargeback ? 'order.chargeback' : 'order.refunded';

    if (!data.email) {
      res.status(400).json({ error: 'Missing email' });
      return;
    }

    logger.info(CTX, `Processing ClickBank ${eventType} for ${data.email}`, {
      receipt: data.orderId,
      client: store.clientId,
    });

    let logId: number | null = null;
    if (isDatabaseReady()) {
      try {
        const result = await query(
          `INSERT INTO webhook_logs (client_id, event_type, source, payload, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [store.clientId, eventType, 'clickbank', JSON.stringify(data.rawPayload), 'processing']
        );
        logId = result[0]?.id || null;
      } catch (dbErr: any) {
        logger.warn(CTX, 'Failed to log webhook', dbErr.message);
      }
    }

    if (store.acApiUrl && store.acApiKey) {
      const kit = await upsertProduct(store.clientId, 'clickbank', data.productId, data.productName);

      const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);
      const contact = await ac.syncContact({ email: data.email });

      if (kit?.enabled) {
        const tagName = isChargeback
          ? `[${kit.name}] Chargeback`
          : `[${kit.name}] Reembolso`;

        const storedTagId = isChargeback ? kit.ac_tag_chargeback_id : kit.ac_tag_reembolso_id;

        if (storedTagId) {
          await ac.addTagToContact(contact.id, storedTagId);
        } else {
          const tag = await ac.findTagByName(tagName);
          if (tag) await ac.addTagToContact(contact.id, tag.id);
        }
      }
    }

    if (isDatabaseReady() && logId) {
      try {
        await query(`UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`, [logId]);
      } catch (_) {}
    }

    logger.info(CTX, `✅ ClickBank ${eventType} processed for ${data.email}`);
    res.status(200).json({ ok: true });
  } catch (error: any) {
    logger.error(CTX, `Failed to process ClickBank refund: ${error.message}`);
    res.status(500).json({ error: 'Internal processing error' });
  }
}
