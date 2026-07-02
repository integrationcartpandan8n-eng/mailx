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

import { queryOne, query } from '../db/database';
import { validateSignature } from '../services/digistore24';
import { logger } from '../utils/logger';

const CTX = 'StoreLookup';

export interface StoreContext {
  /** store_integrations.id */
  storeId: number | null;
  /** clients.id */
  clientId: number | null;
  /** Platform: 'cartpanda' | 'digistore24' | 'clickbank' */
  platform: string;
  /** Shop slug / vendor ID */
  shopSlug: string;
  /** Store-specific API token (CartPanda Bearer token or DS24 IPN passphrase) */
  apiToken: string;
  /** Per-client ActiveCampaign API URL */
  acApiUrl: string;
  /** Per-client ActiveCampaign API Key */
  acApiKey: string;
  /** Per-client SlickText API Token */
  stApiToken: string;
  /** Per-client SlickText Brand ID */
  stBrandId: string;
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
  st_api_token: string;
  st_brand_id: string;
}

/**
 * Look up a store integration by platform and slug/identifier.
 * Returns per-client AC credentials if found.
 * Falls back to global env vars if no match in DB.
 */
export async function lookupStore(
  platform: 'cartpanda' | 'digistore24' | 'clickbank',
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
        COALESCE(c.ac_api_key, '') as ac_api_key,
        COALESCE(c.st_api_token, '') as st_api_token,
        COALESCE(c.st_brand_id, '') as st_brand_id
      FROM store_integrations si
      LEFT JOIN clients c ON c.id = si.client_id
      WHERE si.platform = $1 AND LOWER(si.shop_slug) = LOWER($2)
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
        stApiToken: row.st_api_token || '',
        stBrandId: row.st_brand_id || '',
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
    stApiToken: '',
    stBrandId: '',
    resolvedFromDb: false,
  };
}

/**
 * Extract the shop slug from a CartPanda webhook payload.
 * CartPanda wraps the actual order in `payload.order` and the shop
 * metadata in `payload.order.shop` (with `slug` and `name` fields).
 * Supports both cartpanda.com and mycartpanda.com domains.
 */
export function extractCartPandaSlug(payload: any): string {
  // CartPanda real structure: payload.order.shop.{slug,name}
  const orderShop = payload?.order?.shop;
  if (orderShop?.slug) return String(orderShop.slug).toLowerCase();
  if (orderShop?.name) return String(orderShop.name).toLowerCase();

  // Legacy / alternative top-level fields
  if (payload.store_slug) return String(payload.store_slug).toLowerCase();
  if (payload.shop && typeof payload.shop === 'string') return payload.shop.toLowerCase();
  if (payload?.shop?.slug) return String(payload.shop.slug).toLowerCase();
  if (payload?.shop?.name) return String(payload.shop.name).toLowerCase();

  // From store URL — supports both cartpanda.com and mycartpanda.com
  const storeUrl = payload.store_url || payload.shop_url || payload.domain
    || payload?.order?.store_url || payload?.order?.shop_url || '';
  if (storeUrl) {
    const match = storeUrl.match(/https?:\/\/([^.]+)\.(?:my)?cartpanda\.com/);
    if (match) return match[1].toLowerCase();
    const domainMatch = storeUrl.match(/https?:\/\/([^./]+)/);
    if (domainMatch) return domainMatch[1].toLowerCase();
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

/**
 * Resolve a Digistore24 store by testing the IPN signature against
 * every registered client's passphrase. This avoids depending on
 * product_id/vendor_id being present or pre-registered in the payload.
 *
 * Returns null if no passphrase matches (caller should fall back to
 * the identifier-based lookupStore()).
 */
export async function resolveDS24StoreBySignature(
  params: Record<string, any>
): Promise<StoreContext | null> {
  let candidates: StoreRow[];
  try {
    candidates = await query<StoreRow>(`
      SELECT
        si.id as store_id,
        si.client_id,
        si.platform,
        si.shop_slug,
        si.api_token,
        COALESCE(c.ac_api_url, '') as ac_api_url,
        COALESCE(c.ac_api_key, '') as ac_api_key,
        COALESCE(c.st_api_token, '') as st_api_token,
        COALESCE(c.st_brand_id, '') as st_brand_id
      FROM store_integrations si
      LEFT JOIN clients c ON c.id = si.client_id
      WHERE si.platform = 'digistore24'
        AND si.api_token IS NOT NULL
        AND si.api_token != ''
    `);
  } catch (err: any) {
    logger.warn(CTX, `Signature-based candidate query failed: ${err.message}`);
    return null;
  }

  // Dedupe by api_token — a client may have multiple store_integrations
  // rows (legacy per-product rows) sharing the same passphrase.
  const seen = new Set<string>();
  for (const row of candidates) {
    if (seen.has(row.api_token)) continue;
    seen.add(row.api_token);

    if (validateSignature(params, row.api_token)) {
      logger.info(CTX, `✅ Resolved DS24 store by signature → client #${row.client_id}`);
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
        stApiToken: row.st_api_token || '',
        stBrandId: row.st_brand_id || '',
        resolvedFromDb: true,
      };
    }
  }

  logger.warn(CTX, '⚠️ No DS24 store matched by signature — falling back to identifier lookup');
  return null;
}
