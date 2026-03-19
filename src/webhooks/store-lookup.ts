/**
 * Store Lookup Utility
 *
 * Multi-tenant store resolution for webhook handlers.
 * Given a store identifier (shop_slug for CartPanda, vendor_id for DS24),
 * looks up the store_integration + client to get per-client credentials.
 *
 * Falls back to global env vars if no store_integration is found,
 * ensuring backward compatibility.
 */

import { queryOne } from '../db/database';
import { logger } from '../utils/logger';

const CTX = 'StoreLookup';

export interface StoreContext {
  /** store_integrations.id */
  storeId: number | null;
  /** clients.id */
  clientId: number | null;
  /** Platform: 'cartpanda' | 'digistore24' */
  platform: string;
  /** Shop slug / vendor ID */
  shopSlug: string;
  /** Store-specific API token (CartPanda Bearer token or DS24 IPN passphrase) */
  apiToken: string;
  /** Per-client ActiveCampaign API URL */
  acApiUrl: string;
  /** Per-client ActiveCampaign API Key */
  acApiKey: string;
  /** Whether we resolved from DB or fell back to env */
  resolvedFromDb: boolean;
}

interface StoreRow {
  store_id: number;
  client_id: number;
  platform: string;
  shop_slug: string;
  api_token: string;
  ac_api_url: string;
  ac_api_key: string;
}

/**
 * Look up a store integration by platform and slug/identifier.
 * Returns per-client AC credentials if found.
 * Falls back to global env vars if no match in DB.
 */
export async function lookupStore(
  platform: 'cartpanda' | 'digistore24',
  identifier: string
): Promise<StoreContext> {
  try {
    const row = await queryOne<StoreRow>(`
      SELECT 
        si.id as store_id,
        si.client_id,
        si.platform,
        si.shop_slug,
        si.api_token,
        COALESCE(c.ac_api_url, '') as ac_api_url,
        COALESCE(c.ac_api_key, '') as ac_api_key
      FROM store_integrations si
      LEFT JOIN clients c ON c.id = si.client_id
      WHERE si.platform = $1 AND si.shop_slug = $2
      LIMIT 1
    `, [platform, identifier]);

    if (row) {
      logger.info(CTX, `✅ Resolved store: ${platform}/${identifier} → client #${row.client_id}`);

      // Use per-client AC credentials, fall back to global if empty
      const acApiUrl = row.ac_api_url || process.env.AC_API_URL || '';
      const acApiKey = row.ac_api_key || process.env.AC_API_KEY || '';

      return {
        storeId: row.store_id,
        clientId: row.client_id,
        platform: row.platform,
        shopSlug: row.shop_slug,
        apiToken: row.api_token,
        acApiUrl,
        acApiKey,
        resolvedFromDb: true,
      };
    }
  } catch (err: any) {
    logger.warn(CTX, `DB lookup failed for ${platform}/${identifier}: ${err.message}`);
  }

  // Fallback to global env vars
  logger.warn(CTX, `⚠️ No store_integration found for ${platform}/${identifier} — using global env`);

  return {
    storeId: null,
    clientId: null,
    platform,
    shopSlug: identifier,
    apiToken: '',
    acApiUrl: process.env.AC_API_URL || '',
    acApiKey: process.env.AC_API_KEY || '',
    resolvedFromDb: false,
  };
}

/**
 * Extract the shop slug from a CartPanda webhook payload.
 * CartPanda may send `store_slug`, `shop` or the store URL domain.
 */
export function extractCartPandaSlug(payload: any): string {
  // Direct slug field
  if (payload.store_slug) return payload.store_slug;
  if (payload.shop) return payload.shop;

  // From store URL (https://minhaloja.cartpanda.com → minhaloja)
  const storeUrl = payload.store_url || payload.shop_url || '';
  if (storeUrl) {
    const match = storeUrl.match(/https?:\/\/([^.]+)\.cartpanda\.com/);
    if (match) return match[1];
  }

  return '';
}

/**
 * Extract the vendor/product identifier from a DS24 IPN payload.
 * Uses the vendor_id or product_id as identifier.
 */
export function extractDS24Identifier(params: Record<string, any>): string {
  return params.vendor_id || params.affiliate || params.product_id || '';
}
