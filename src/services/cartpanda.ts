import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

const CTX = 'CartPanda';

export interface WebhookRegistrationResult {
  created: string[];
  skipped: string[];
  errors: Array<{ endpoint: string; error: string }>;
}

export class CartPandaClient {
  private http: AxiosInstance;
  private storeSlug: string;
  private apiToken: string;

  constructor(storeSlug: string, apiToken: string) {
    this.storeSlug = storeSlug;
    this.apiToken = apiToken;

    // Default to .cartpanda.com — will be overridden if probe finds .mycartpanda.com
    this.http = axios.create({
      baseURL: `https://${storeSlug}.cartpanda.com/api/v3`,
      headers: { Authorization: `Bearer ${apiToken}` },
      timeout: 15000,
    });
  }

  async getOrders(params?: { page?: number; limit?: number }) {
    const res = await this.http.get('/orders', { params });
    logger.debug(CTX, `Fetched ${res.data.length ?? 0} orders`);
    return res.data;
  }

  async getOrder(orderId: string) {
    const res = await this.http.get(`/orders/${orderId}`);
    return res.data;
  }

  async getProducts(params?: { page?: number; limit?: number }) {
    const res = await this.http.get('/products', { params });
    logger.debug(CTX, `Fetched ${res.data.length ?? 0} products`);
    return res.data;
  }

  /**
   * Register webhooks on CartPanda using the Accounts API.
   * 
   * CartPanda Webhook API:
   *   POST https://accounts.cartpanda.com/api/{shop-slug}/webhooks
   *   — OR —
   *   POST https://accounts.mycartpanda.com/api/{shop-slug}/webhooks
   *   Authorization: Bearer {api_token}
   *   Body: { endpoint: string, events: string[] }
   */
  async registerWebhooks(callbackBaseUrl: string): Promise<WebhookRegistrationResult> {
    const result: WebhookRegistrationResult = {
      created: [],
      skipped: [],
      errors: [],
    };

    // Normalize base URL (remove trailing slash)
    const base = callbackBaseUrl.replace(/\/+$/, '');

    // Define all webhooks to register — one per MailX endpoint with all relevant events
    const webhooksToRegister = [
      {
        endpoint: `${base}/webhook/cartpanda/order-paid`,
        events: ['order.paid'],
      },
      {
        endpoint: `${base}/webhook/cartpanda/abandoned-cart`,
        events: ['order.created'],
      },
      {
        endpoint: `${base}/webhook/cartpanda/card-declined`,
        events: ['order.updated'],
      },
      {
        endpoint: `${base}/webhook/cartpanda/order-paid`,
        events: ['order.refunded'],
      },
    ];

    // CartPanda has two possible accounts API domains — probe both
    const ACCOUNTS_URLS = [
      `https://accounts.cartpanda.com/api/${this.storeSlug}`,
      `https://accounts.mycartpanda.com/api/${this.storeSlug}`,
    ];

    // Try to determine the correct accounts base URL
    let accountsBaseUrl = '';
    for (const url of ACCOUNTS_URLS) {
      try {
        logger.debug(CTX, `Probing Accounts API: ${url}/webhooks`);
        const probeRes = await axios.get(`${url}/webhooks`, {
          headers: { Authorization: `Bearer ${this.apiToken}`, Accept: 'application/json' },
          timeout: 10000,
          validateStatus: (s) => s < 500, // Accept 2xx, 3xx, 4xx as "found"
        });
        const status = probeRes.status;
        // If we get any response that isn't a 404, this is likely the right URL
        if (status !== 404) {
          accountsBaseUrl = url;
          logger.info(CTX, `✅ CartPanda Accounts API found at: ${url} (HTTP ${status})`);
          break;
        }
      } catch (err: any) {
        logger.debug(CTX, `Probe failed for ${url}: ${err.message}`);
      }
    }

    if (!accountsBaseUrl) {
      // Fallback: use the first URL if both probes failed
      accountsBaseUrl = ACCOUNTS_URLS[0];
      logger.warn(CTX, `⚠️ Could not probe Accounts API, defaulting to: ${accountsBaseUrl}`);
    }

    logger.info(CTX, `Using CartPanda Accounts API: ${accountsBaseUrl}`);

    const accountsHttp = axios.create({
      baseURL: accountsBaseUrl,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 20000,
    });

    // First, try to get existing webhooks to avoid duplicates
    let existingEndpoints: string[] = [];
    try {
      const listRes = await accountsHttp.get('/webhooks');
      const webhooks = listRes.data?.data || listRes.data || [];
      if (Array.isArray(webhooks)) {
        existingEndpoints = webhooks.map((w: any) => w.endpoint || w.url || '');
      }
      logger.debug(CTX, `Found ${existingEndpoints.length} existing webhooks on CartPanda`);
    } catch (err: any) {
      // If listing fails, proceed anyway — we'll try to create all
      logger.warn(CTX, `Could not list existing webhooks: ${err.message}`);
    }

    for (const webhook of webhooksToRegister) {
      // Check if endpoint already exists
      if (existingEndpoints.includes(webhook.endpoint)) {
        result.skipped.push(webhook.endpoint);
        logger.info(CTX, `⏭️ Webhook already exists: ${webhook.endpoint}`);
        continue;
      }

      try {
        logger.debug(CTX, `POST ${accountsBaseUrl}/webhooks → endpoint=${webhook.endpoint}, events=${webhook.events.join(',')}`);
        await accountsHttp.post('/webhooks', {
          endpoint: webhook.endpoint,
          events: webhook.events,
        });

        result.created.push(webhook.endpoint);
        logger.info(CTX, `✅ Webhook registered: ${webhook.endpoint} → [${webhook.events.join(', ')}]`);
      } catch (err: any) {
        const status = err.response?.status || 'unknown';
        const errorMsg = err.response?.data?.message || err.response?.data?.error || JSON.stringify(err.response?.data) || err.message;
        result.errors.push({ endpoint: webhook.endpoint, error: `${status}: ${errorMsg}` });
        logger.error(CTX, `❌ Failed to register webhook: ${webhook.endpoint}`, { status, error: errorMsg, requestUrl: `${accountsBaseUrl}/webhooks` });
      }
    }

    logger.info(CTX, `Webhook registration complete: ${result.created.length} created, ${result.skipped.length} skipped, ${result.errors.length} errors`);
    return result;
  }
}
