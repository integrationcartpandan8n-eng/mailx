/**
 * Metrics Extraction — Fase A
 *
 * Normalizes gateway-specific payloads into flat metric fields
 * stored as dedicated columns in webhook_logs. Each gateway has
 * its own payload shape; this module is the ONLY place that
 * knows about those differences for metrics purposes.
 *
 * IMPORTANT: extraction must NEVER throw. On any unexpected
 * structure, return nulls — the raw payload is always preserved
 * in the JSONB column for later reprocessing.
 */

export interface ExtractedMetrics {
  totalPrice: number | null;
  currency: string | null;
  productName: string | null;
  productExternalId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  affiliateName: string | null;
  trackingCode: string | null;
}

const EMPTY: ExtractedMetrics = {
  totalPrice: null,
  currency: null,
  productName: null,
  productExternalId: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  affiliateName: null,
  trackingCode: null,
};

/** Parse money that may arrive as "1,234.56", "1234,56", number, etc. */
function parseMoney(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const cleaned = String(value).replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function str(value: any): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * CartPanda — nested structure.
 * order.paid:       payload.order.{total_price, checkout_params, line_items}
 * abandoned_cart:   payload.data.* (sometimes) or payload.order.*
 * card.declined:    same family of shapes
 * checkout_params may live at order.checkout_params, data.checkout_params
 * or (legacy) payload.checkout_params.
 */
export function extractCartPandaMetrics(payload: any): ExtractedMetrics {
  try {
    const order = payload?.order || payload?.data || payload || {};
    const cp =
      payload?.order?.checkout_params ||
      payload?.data?.checkout_params ||
      payload?.checkout_params ||
      {};

    const lineItem =
      order?.line_items?.[0] ||
      order?.cart_line_items?.[0]?.variant ||
      order?.cart_line_items?.[0] ||
      {};

    return {
      totalPrice: parseMoney(order?.total_price ?? payload?.total_price),
      currency: str(order?.currency ?? payload?.currency),
      productName: str(lineItem?.title ?? lineItem?.name ?? lineItem?.sku),
      productExternalId: str(lineItem?.product_id ?? lineItem?.sku),
      utmSource: str(cp?.utm_source),
      utmMedium: str(cp?.utm_medium),
      utmCampaign: str(cp?.utm_campaign),
      utmContent: str(cp?.utm_content),
      utmTerm: str(cp?.utm_term),
      affiliateName: null,
      trackingCode: null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Digistore24 — flat structure (rawPayload = IPN form params).
 * Confirmed real payload fields: amount_brutto, currency, product_name,
 * product_id, utm_source/medium/campaign/content/term (root level),
 * affiliate_name.
 */
export function extractDS24Metrics(payload: any): ExtractedMetrics {
  try {
    return {
      totalPrice: parseMoney(payload?.amount_brutto ?? payload?.transaction_amount),
      currency: str(payload?.currency ?? payload?.transaction_currency),
      productName: str(payload?.product_name),
      productExternalId: str(payload?.product_id),
      utmSource: str(payload?.utm_source),
      utmMedium: str(payload?.utm_medium),
      utmCampaign: str(payload?.utm_campaign),
      utmContent: str(payload?.utm_content),
      utmTerm: str(payload?.utm_term),
      affiliateName: str(payload?.affiliate_name),
      trackingCode: null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * ClickBank — decrypted INS payload.
 * Value at totalOrderAmount; product at lineItems[0]; tracking at
 * trackingCodes[] (array of TID strings — stored RAW, joined by comma;
 * TID→UTM parsing intentionally deferred).
 */
export function extractClickBankMetrics(payload: any): ExtractedMetrics {
  try {
    const item = payload?.lineItems?.[0] || {};
    const codes = Array.isArray(payload?.trackingCodes) ? payload.trackingCodes : [];
    return {
      totalPrice: parseMoney(payload?.totalOrderAmount),
      currency: str(payload?.currency),
      productName: str(item?.productTitle),
      productExternalId: str(item?.itemNo),
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      affiliateName: null,
      trackingCode: codes.length ? str(codes.join(',')) : null,
    };
  } catch {
    return { ...EMPTY };
  }
}
