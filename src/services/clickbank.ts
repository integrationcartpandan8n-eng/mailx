/**
 * ClickBank Service
 * Decrypts INS (Instant Notification Service) payloads and normalizes data.
 *
 * ClickBank INS sends an AES-256-CBC encrypted JSON payload.
 * The POST body contains: { notification: base64, iv: base64 }
 * Decryption uses SHA1(secretKey) truncated to 32 hex chars as the AES key.
 *
 * INS Setup in ClickBank:
 *   Accounts → Vendor Settings → My Site → Advanced Tools → Edit
 *   1. Request Access for Instant Notification URL
 *   2. Set Secret Key (max 16 chars)
 *   3. Enter URL: https://api.mailxgroup.com/webhook/clickbank/payment
 *   4. Test URL → Save
 *
 * Transaction Types:
 *   SALE              — Initial purchase
 *   BILL              — Recurring rebill
 *   RFND              — Refund
 *   CGBK              — Chargeback
 *   INSF              — eCheck chargeback
 *   CANCEL-REBILL     — Subscription cancellation
 *   UNCANCEL-REBILL   — Cancellation reversal
 *   ABANDONED_ORDER   — Cart abandonment (v6.0+)
 *   TEST / TEST_SALE  — Test notifications
 *
 * Tracking:
 *   ClickBank uses "tid" (tracking ID) instead of UTMs.
 *   v8 payloads also include affiliateTrackingParameters with
 *   traffic_source, campaign, aff_sub1-5, etc.
 *
 * @see https://support.clickbank.com/en/articles/10535147-instant-notification-service-ins
 */

import crypto from 'crypto';
import { logger } from '../utils/logger';

const CTX = 'ClickBank';

/** Supported ClickBank transaction types */
export type CBTransactionType =
  | 'SALE' | 'BILL' | 'RFND' | 'CGBK' | 'INSF'
  | 'CANCEL-REBILL' | 'UNCANCEL-REBILL' | 'SUBSCRIPTION-CHG'
  | 'ABANDONED_ORDER' | 'CUSTOMER_AUTH_FAILURE'
  | 'CUSTOMER_EMAIL_UPDATE' | 'CUSTOMER_UPDATE_CC_NOTIFICATION'
  | 'TEST' | 'TEST_SALE' | 'TEST_BILL' | 'TEST_RFND'
  | 'CANCEL-TEST-REBILL' | 'UNCANCEL-TEST-REBILL';

/** Decrypted ClickBank INS payload (v8) */
export interface CBPayload {
  transactionTime: string;
  receipt: string;
  transactionType: CBTransactionType;
  vendor: string;
  affiliate: string;
  role: string;
  totalAccountAmount: number;
  paymentMethod: string;
  totalOrderAmount: number;
  totalTaxAmount: number;
  totalShippingAmount: number;
  currency: string;
  orderLanguage: string;
  trackingCodes: string[];
  version: number;
  attemptCount: number;
  vendorVariables: Record<string, string>;
  lineItems: Array<{
    itemNo: string;
    productTitle: string;
    productPrice: number;
    productDiscount: number;
    accountAmount: number;
    quantity: number;
    recurring: boolean;
    shippable: boolean;
    lineItemType: string;
  }>;
  customer: {
    shipping?: {
      firstName: string;
      lastName: string;
      fullName: string;
      phoneNumber: string;
      email: string;
      address?: {
        address1: string;
        address2: string;
        city: string;
        county: string;
        state: string;
        postalCode: string;
        country: string;
      };
    };
    billing?: {
      firstName: string;
      lastName: string;
      fullName: string;
      phoneNumber: string;
      email: string;
      state: string;
      postalCode: string;
      country: string;
    };
  };
  affiliateTrackingParameters?: Array<{
    trafficType?: string;
    trafficSource?: string;
    offer?: string;
    campaign?: string;
    affSub1?: string;
    affSub2?: string;
    affSub3?: string;
    affSub4?: string;
    affSub5?: string;
  }>;
}

/** Normalized payload matching the shared pipeline format */
export interface CBNormalizedPayload {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  productName: string;
  productId: string;
  orderId: string;
  totalPrice: number;
  currency: string;
  transactionType: CBTransactionType;
  vendor: string;
  trackingCodes: string[];
  address: string;
  source: 'clickbank';
  rawPayload: CBPayload;
}

/**
 * Decrypt a ClickBank INS notification.
 *
 * Algorithm:
 * 1. SHA1(secretKey) → hex string
 * 2. Truncate to first 32 chars → AES-256-CBC key
 * 3. Base64-decode iv and notification
 * 4. AES-256-CBC decrypt
 * 5. Parse JSON
 *
 * @param secretKey - INS Secret Key from ClickBank dashboard (max 16 chars)
 * @param body - Raw POST body: { notification: string, iv: string }
 * @returns Decrypted payload object
 * @throws Error if decryption fails (invalid key or tampered payload)
 */
export function decryptINS(secretKey: string, body: { notification: string; iv: string }): CBPayload {
  if (!body.notification || !body.iv) {
    throw new Error('Missing notification or iv in ClickBank INS body');
  }

  // Derive key: SHA1(secret) truncated to 32 hex chars
  const keyHex = crypto
    .createHash('sha1')
    .update(secretKey, 'utf8')
    .digest('hex')
    .substring(0, 32);

  const iv = Buffer.from(body.iv, 'base64');
  const encrypted = Buffer.from(body.notification, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-cbc', keyHex, iv);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  const payload = JSON.parse(decrypted) as CBPayload;

  logger.debug(CTX, `INS decrypted: ${payload.transactionType} receipt=${payload.receipt} vendor=${payload.vendor}`);
  return payload;
}

/**
 * Normalize a decrypted ClickBank payload into the pipeline standard format.
 */
export function normalizePayload(payload: CBPayload): CBNormalizedPayload {
  const billing = payload.customer?.billing;
  const shipping = payload.customer?.shipping;

  // Prefer billing, fallback to shipping
  const email = billing?.email || shipping?.email || '';
  const firstName = billing?.firstName || shipping?.firstName || '';
  const lastName = billing?.lastName || shipping?.lastName || '';
  const phone = billing?.phoneNumber || shipping?.phoneNumber || '';

  // Product from first line item
  const item = payload.lineItems?.[0];
  const productName = item?.productTitle || 'produto';
  const productId = item?.itemNo || '';

  // Format address from shipping
  const addr = shipping?.address;
  const address = addr
    ? [addr.address1, addr.city, addr.state, addr.postalCode, addr.country]
        .filter(Boolean)
        .join(', ')
    : '';

  return {
    email,
    firstName,
    lastName,
    phone,
    productName,
    productId,
    orderId: payload.receipt || '',
    totalPrice: payload.totalOrderAmount || 0,
    currency: payload.currency || 'USD',
    transactionType: payload.transactionType,
    vendor: payload.vendor || '',
    trackingCodes: payload.trackingCodes || [],
    address,
    source: 'clickbank',
    rawPayload: payload,
  };
}

/**
 * Check if a transaction type is a purchase (SALE or BILL).
 */
export function isPurchase(type: CBTransactionType): boolean {
  return ['SALE', 'BILL', 'TEST_SALE', 'TEST_BILL'].includes(type);
}

/**
 * Check if a transaction type is a refund/chargeback.
 */
export function isRefund(type: CBTransactionType): boolean {
  return ['RFND', 'CGBK', 'INSF', 'TEST_RFND'].includes(type);
}

/**
 * Check if a transaction type is an abandoned cart.
 */
export function isAbandonedOrder(type: CBTransactionType): boolean {
  return type === 'ABANDONED_ORDER';
}

/**
 * Check if a transaction type is a test event.
 */
export function isTestEvent(type: CBTransactionType): boolean {
  return type === 'TEST' || type.startsWith('TEST_') || type.endsWith('TEST-REBILL');
}

/**
 * Extract the vendor identifier for store lookup.
 */
export function extractVendor(payload: CBPayload): string {
  return (payload.vendor || '').toLowerCase();
}
