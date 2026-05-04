/**
 * ClickBank Payment Handler
 * Handles SALE, BILL, and ABANDONED_ORDER events from ClickBank INS.
 * Endpoint: POST /webhook/clickbank/payment
 *
 * Flow:
 *   1. Decrypt INS payload (AES-256-CBC)
 *   2. Route by transactionType (SALE/BILL → purchase, ABANDONED_ORDER → abandonment)
 *   3. Lookup store by vendor nickname
 *   4. Upsert product
 *   5. Sync to ActiveCampaign (tags + list)
 *   6. Sync to SlickText SMS (contact + list)
 */

import { Request, Response, NextFunction } from 'express';
import { ActiveCampaignClient } from '../services/activecampaign';
import {
  decryptINS,
  normalizePayload,
  isPurchase,
  isAbandonedOrder,
  isTestEvent,
  extractVendor,
} from '../services/clickbank';
import { query, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { lookupStore } from './store-lookup';
import { upsertProduct } from './product-upsert';
import { syncSlickTextOrderPaid, syncSlickTextAbandonedCart } from './slicktext-sync';

const CTX = 'Webhook:ClickBank';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function handleClickBankPayment(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const rawBody = req.body;

  try {
    // 1. Lookup store to get the INS secret key
    //    ClickBank sends vendor in the encrypted payload, but we need the key to decrypt.
    //    Strategy: try all clickbank store_integrations until one decrypts successfully.
    let data: ReturnType<typeof normalizePayload> | null = null;
    let store: Awaited<ReturnType<typeof lookupStore>> | null = null;

    if (!rawBody.notification || !rawBody.iv) {
      logger.warn(CTX, 'Missing notification/iv in body — not a ClickBank INS request');
      res.status(400).json({ error: 'Invalid ClickBank INS payload' });
      return;
    }

    // Try decrypting with known ClickBank integrations
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

    // If no store matched, try with a fallback env key
    if (!data) {
      const fallbackKey = process.env.CLICKBANK_INS_SECRET || '';
      if (fallbackKey) {
        try {
          const decrypted = decryptINS(fallbackKey, rawBody);
          data = normalizePayload(decrypted);
          store = await lookupStore('clickbank', extractVendor(decrypted));
        } catch (err: any) {
          logger.error(CTX, `Decryption failed with fallback key: ${err.message}`);
        }
      }
    }

    if (!data || !store) {
      logger.error(CTX, 'Could not decrypt ClickBank INS — no matching secret key found');
      res.status(403).json({ error: 'Decryption failed' });
      return;
    }

    // 2. Handle test events
    if (isTestEvent(data.transactionType)) {
      logger.info(CTX, `Test event received: ${data.transactionType} — acknowledged`);
      res.status(200).json({ ok: true, test: true });
      return;
    }

    // 3. Determine event type
    const isPurchaseEvent = isPurchase(data.transactionType);
    const isAbandonedEvent = isAbandonedOrder(data.transactionType);

    if (!isPurchaseEvent && !isAbandonedEvent) {
      // Not a purchase or abandonment — pass to refund handler or ignore
      logger.info(CTX, `Ignoring ${data.transactionType} event (handled by refund endpoint)`);
      res.status(200).json({ ok: true, ignored: data.transactionType });
      return;
    }

    const eventType = isPurchaseEvent ? 'order.paid' : 'abandoned_cart';

    // 4. Log webhook
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

    // 5. Validate email
    if (!data.email) {
      logger.warn(CTX, `No email in ClickBank payload`, { receipt: data.orderId });
      res.status(400).json({ error: 'Missing email in payload' });
      return;
    }

    logger.info(CTX, `Processing ${data.transactionType} ${data.orderId} for ${data.email}`, {
      product: data.productName,
      productId: data.productId,
      client: store.clientId,
      vendor: data.vendor,
    });

    // 6. Upsert product
    const kit = await upsertProduct(store.clientId, 'clickbank', data.productId, data.productName);

    // 7. ActiveCampaign sync
    if (store.acApiUrl && store.acApiKey) {
      const ac = new ActiveCampaignClient(store.acApiUrl, store.acApiKey);
      const contact = await ac.syncContact({
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
      });

      if (kit?.enabled) {
        if (isPurchaseEvent) {
          const tagName = `[${kit.name}] Compra Aprovada`;
          if (kit.ac_tag_compra_id) {
            await ac.addTagToContact(contact.id, kit.ac_tag_compra_id);
          } else {
            const tag = await ac.findTagByName(tagName);
            if (tag) await ac.addTagToContact(contact.id, tag.id);
          }
        } else {
          const tagName = `[${kit.name}] Abandono`;
          if (kit.ac_tag_abandono_id) {
            await ac.addTagToContact(contact.id, kit.ac_tag_abandono_id);
          } else {
            const tag = await ac.findTagByName(tagName);
            if (tag) await ac.addTagToContact(contact.id, tag.id);
          }
        }

        if (kit.ac_list_id) {
          await ac.addContactToList(contact.id, kit.ac_list_id);
        }

        // Automation — only for kits > 1 week old
        if (isPurchaseEvent) {
          const kitAge = Date.now() - new Date(kit.created_at).getTime();
          if (kitAge >= ONE_WEEK_MS) {
            const automationId = process.env.AC_AUTOMATION_COMPRA_APROVADA;
            if (automationId) await ac.addContactToAutomation(contact.id, automationId);
          }
        }
      } else {
        logger.info(CTX, `Product "${data.productName}" not yet enabled — contact synced only`);
      }
    }

    // 8. SlickText SMS sync (non-blocking)
    const stSync = isPurchaseEvent ? syncSlickTextOrderPaid : syncSlickTextAbandonedCart;
    stSync(store, kit, {
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      address: data.address,
    }).then((r) => {
      if (r.synced) logger.info(CTX, `SlickText synced: ${r.contactId} → list ${r.listId}`);
      else logger.debug(CTX, `SlickText skipped: ${r.reason}`);
    }).catch((err) => {
      logger.warn(CTX, `SlickText error (non-blocking): ${err.message}`);
    });

    // 9. Update webhook log
    if (isDatabaseReady() && logId) {
      try {
        await query(`UPDATE webhook_logs SET status = 'processed', processed_at = NOW() WHERE id = $1`, [logId]);
      } catch (_) {}
    }

    // Auto-activate store
    if (store.storeId && store.resolvedFromDb) {
      try {
        await query(`UPDATE store_integrations SET status = 'active', updated_at = NOW() WHERE id = $1`, [store.storeId]);
      } catch (_) {}
    }

    logger.info(CTX, `✅ ClickBank ${data.transactionType} ${data.orderId} processed for ${data.email}`);
    res.status(200).json({ ok: true, receipt: data.orderId });
  } catch (error: any) {
    logger.error(CTX, `Failed to process ClickBank payment: ${error.message}`);
    res.status(500).json({ error: 'Internal processing error' });
  }
}
