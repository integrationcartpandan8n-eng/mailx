import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

const CTX = 'CartPanda';

export class CartPandaClient {
  private http: AxiosInstance;

  constructor(storeSlug: string, apiToken: string) {
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
}
