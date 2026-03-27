/**
 * Product auto-discovery utility.
 *
 * When a webhook arrives, the product is upserted into the kits table.
 * New products start as enabled=false — admin must enable them explicitly,
 * which triggers a mini-bootstrap to create AC tags.
 */

import { query, queryOne } from '../db/database';
import { logger } from '../utils/logger';

const CTX = 'ProductUpsert';

export interface KitRecord {
  id: number;
  client_id: number;
  name: string;
  slug: string;
  price: number | null;
  external_id: string | null;
  platform: string;
  enabled: boolean;
  ac_list_id: string | null;
  ac_tag_compra_id: string | null;
  ac_tag_abandono_id: string | null;
  ac_tag_cartao_recusado_id: string | null;
  ac_tag_reembolso_id: string | null;
  ac_tag_chargeback_id: string | null;
  created_at: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Extract the CartPanda product ID from a webhook line item.
 * Priority: product_id → variant_id → id (all as strings).
 */
export function extractCartPandaProductId(item: Record<string, any>): string {
  return String(item?.product_id || item?.variant_id || item?.id || '');
}

/**
 * Extract the Digistore24 product ID from raw IPN params.
 */
export function extractDS24ProductId(params: Record<string, any>): string {
  return String(params?.product_id || params?.order_product_id || '');
}

/**
 * Find or create a kit record for an incoming webhook product.
 * - Looks up by (client_id, platform, external_id).
 * - If found: updates name if changed.
 * - If not found: inserts with enabled=false.
 * Returns null if clientId or externalId is missing.
 */
export async function upsertProduct(
  clientId: number | null,
  platform: 'cartpanda' | 'digistore24',
  externalId: string,
  productName: string
): Promise<KitRecord | null> {
  if (!clientId || !externalId || !productName) return null;

  const slug = slugify(productName);

  try {
    // Try find by external_id
    const existing = await queryOne<KitRecord>(
      `SELECT * FROM kits WHERE client_id = $1 AND platform = $2 AND external_id = $3`,
      [clientId, platform, externalId]
    );

    if (existing) {
      if (existing.name !== productName) {
        await query(`UPDATE kits SET name = $1, slug = $2 WHERE id = $3`, [productName, slug, existing.id]);
        existing.name = productName;
        existing.slug = slug;
      }
      return existing;
    }

    // Not found — insert new product (enabled=false, admin must enable)
    const rows = await query<KitRecord>(
      `INSERT INTO kits (client_id, name, slug, external_id, platform, enabled)
       VALUES ($1, $2, $3, $4, $5, false)
       ON CONFLICT (client_id, platform, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug
       RETURNING *`,
      [clientId, productName, slug, externalId, platform]
    );

    const kit = rows[0] ?? null;
    if (kit) {
      logger.info(CTX, `New product discovered: [${platform}] "${productName}" (${externalId}) → client #${clientId}`);
    }
    return kit;
  } catch (err: any) {
    logger.warn(CTX, `Failed to upsert product "${productName}": ${err.message}`);
    return null;
  }
}
