/**
 * Digistore24 Service
 * Utilities for IPN signature validation and payload normalization.
 *
 * Digistore24 sends IPN (Instant Payment Notification) webhooks as HTTP POST
 * with data in the request body (form-encoded) or query string.
 *
 * Key differences from CartPanda:
 * - Data comes as form fields or query params, not JSON
 * - Includes sha_sign for authenticity verification
 * - Field names use billing_ prefix for customer data
 *
 * IPN Setup in DS24:
 *   Settings → Integrations (IPN) → Add new connection → Webhook
 *   URL: https://api.mailxgroup.com/webhook/digistore24/payment
 *   Events: payment, refund, chargeback
 *
 * @see https://dev.digistore24.com
 */

import crypto from 'crypto';
import { logger } from '../utils/logger';

const CTX = 'Digistore24';

/**
 * Normalized webhook payload — platform-agnostic format
 * used by both CartPanda and Digistore24 handlers.
 */
export interface NormalizedPayload {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  productName: string;
  productSlug: string;
  orderId: string;
  totalPrice: number;
  currency: string;
  source: 'cartpanda' | 'digistore24';
  rawPayload: Record<string, any>;
}

/**
 * Validate the sha_sign from a Digistore24 IPN request.
 *
 * DS24 generates the signature by:
 * 1. Sorting all parameters alphabetically (excluding sha_sign itself)
 * 2. Concatenating key=value pairs
 * 3. Appending the IPN passphrase
 * 4. Computing SHA512 hash
 *
 * @param params - All received query/form parameters
 * @param passphrase - IPN passphrase from DS24 dashboard (stored in .env)
 * @returns true if signature is valid
 */
export function validateSignature(
  params: Record<string, any>,
  passphrase: string
): boolean {
  const receivedSign = params.sha_sign;
  if (!receivedSign) {
    logger.warn(CTX, 'No sha_sign found in request');
    return false;
  }

  // Build signature string: sort keys, exclude sha_sign, concatenate
  const keys = Object.keys(params)
    .filter((k) => k !== 'sha_sign')
    .sort();

  const signString = keys.map((k) => `${k}=${params[k]}`).join('') + passphrase;

  const computedSign = crypto
    .createHash('sha512')
    .update(signString, 'utf8')
    .digest('hex')
    .toUpperCase();

  const isValid = computedSign === receivedSign.toUpperCase();

  if (!isValid) {
    logger.warn(CTX, 'Invalid sha_sign — possible tampering', {
      received: receivedSign.substring(0, 16) + '...',
      computed: computedSign.substring(0, 16) + '...',
    });
  }

  return isValid;
}

/**
 * Slugify a string for use as tag/list identifiers.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Normalize a Digistore24 IPN payload into our standard format.
 *
 * DS24 parameter mapping:
 *   email               → email
 *   billing_first_name  → firstName
 *   billing_last_name   → lastName
 *   billing_phone_no    → phone
 *   product_name        → productName
 *   order_id            → orderId
 *   amount_brutto       → totalPrice
 *   currency            → currency
 */
export function normalizePayload(params: Record<string, any>): NormalizedPayload {
  const productName = params.product_name || 'produto';

  return {
    email: params.email || '',
    firstName: params.billing_first_name || '',
    lastName: params.billing_last_name || '',
    phone: params.billing_phone_no || '',
    productName,
    productSlug: slugify(productName),
    orderId: params.order_id || '',
    totalPrice: parseFloat(params.amount_brutto || '0'),
    currency: params.currency || 'BRL',
    source: 'digistore24',
    rawPayload: params,
  };
}
