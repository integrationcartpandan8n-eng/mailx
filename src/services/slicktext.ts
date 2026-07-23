import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

const CTX = 'SlickText';

export interface SlickTextContact {
  contact_id: number;
  mobile_number: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  opt_in_status?: string;
}

export interface SlickTextList {
  contact_list_id: number;
  name: string;
  description?: string;
  created?: string;
}

export interface SlickTextAnalytics {
  contacts?: any;
  messages?: any;
  credits?: any;
  campaigns?: any;
}

export class SlickTextClient {
  private http: AxiosInstance;
  private brandId: string;

  constructor(apiToken: string, brandId: string) {
    // SlickText UI shows brand id with a leading letter (e.g. "b26136"),
    // but the API path expects the numeric id only.
    const numericId = String(brandId).replace(/\D/g, '');
    this.brandId = numericId;

    this.http = axios.create({
      baseURL: `https://dev.slicktext.com/v1/brands/${numericId}`,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 20000,
    });

    // Rate limit: 8 req/s for V2 — retry on 429
    this.http.interceptors.response.use(
      (res) => res,
      async (error) => {
        if (error.response?.status === 429) {
          logger.warn(CTX, 'Rate limited — retrying in 1s');
          await new Promise((r) => setTimeout(r, 1000));
          return this.http.request(error.config);
        }
        throw error;
      }
    );
  }

  // ── Contacts ──

  /**
   * Create or update a contact in SlickText.
   * Phone must be in E.164 format: +1XXXXXXXXXX
   */
  async createContact(data: {
    mobile_number: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    address?: string;
    opt_in_status?: string;
  }): Promise<SlickTextContact> {
    const body: any = {
      mobile_number: data.mobile_number,
      opt_in_status: data.opt_in_status || 'subscribed',
    };

    if (data.first_name) body.first_name = data.first_name;
    if (data.last_name) body.last_name = data.last_name;
    if (data.email) body.email = data.email;
    if (data.address) body.address = data.address;

    const res = await this.http.post('/contacts', body);
    const contact = res.data;

    logger.info(CTX, `Contact created: ${data.mobile_number}`, { contact_id: contact.contact_id });
    return contact;
  }

  /**
   * Find a contact by phone number.
   */
  async findContactByPhone(phone: string): Promise<SlickTextContact | null> {
    try {
      const res = await this.http.get('/contacts', {
        params: { mobile_number: phone },
      });
      const contacts = res.data?.data || res.data || [];
      if (Array.isArray(contacts) && contacts.length > 0) {
        return contacts[0];
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Lists ──

  /**
   * Get all lists for this brand.
   */
  async getLists(): Promise<SlickTextList[]> {
    const res = await this.http.get('/lists');
    return res.data?.data || res.data || [];
  }

  /**
   * Create a new list.
   */
  async createList(name: string, description?: string): Promise<SlickTextList> {
    const res = await this.http.post('/lists', {
      name,
      description: description || '',
    });

    const list = res.data;
    logger.info(CTX, `List created: "${name}"`, { list_id: list.contact_list_id });
    return list;
  }

  /**
   * Find a list by exact name.
   */
  async findListByName(name: string): Promise<SlickTextList | null> {
    const lists = await this.getLists();
    return lists.find((l) => l.name === name) || null;
  }

  /**
   * Find or create a list by name.
   */
  async findOrCreateList(name: string, description?: string): Promise<SlickTextList> {
    const existing = await this.findListByName(name);
    if (existing) {
      logger.debug(CTX, `List already exists: "${name}" (ID: ${existing.contact_list_id})`);
      return existing;
    }
    return this.createList(name, description);
  }

  /**
   * Add a contact to one or more lists.
   */
  async addContactToLists(contactId: number, listIds: number[]): Promise<void> {
    await this.http.post('/lists/contacts', [
      { contact_id: contactId, lists: listIds },
    ]);
    logger.debug(CTX, `Contact ${contactId} added to lists: [${listIds.join(', ')}]`);
  }

  /**
   * Remove a contact from a specific list.
   * Note: uses a different URL structure (not under /brands/)
   */
  async removeContactFromList(contactId: number, listId: number): Promise<void> {
    try {
      await axios.delete(
        `https://dev.slicktext.com/v1/contacts/${contactId}/lists/${listId}`,
        {
          headers: this.http.defaults.headers as any,
          timeout: 20000,
        }
      );
      logger.debug(CTX, `Contact ${contactId} removed from list ${listId}`);
    } catch (err: any) {
      // 404 means contact wasn't in the list — that's fine
      if (err.response?.status === 404) {
        logger.debug(CTX, `Contact ${contactId} was not in list ${listId} (already removed)`);
        return;
      }
      throw err;
    }
  }

  /**
   * Get contact count for a list.
   */
  async getListContactCount(listId: number): Promise<number> {
    try {
      const res = await this.http.get(`/lists/${listId}/contacts/count`);
      // Endpoint returns a bare number (e.g. 228), not an object
      if (typeof res.data === 'number') return res.data;
      return res.data?.count ?? res.data?.total ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Analytics ──

  /**
   * Get contact analytics (total, by status, by source).
   */
  async getContactAnalytics(start?: string, end?: string): Promise<any> {
    const params: any = {};
    if (start) params.start = start;
    if (end) params.end = end;

    const res = await this.http.get('/analytics/contacts', { params });
    return res.data;
  }

  /**
   * Get message analytics (total, credits, by status/direction).
   */
  async getMessageAnalytics(start?: string, end?: string): Promise<any> {
    const params: any = {};
    if (start) params.start = start;
    if (end) params.end = end;

    const res = await this.http.get('/analytics/messages', { params });
    return res.data;
  }

  /**
   * Conta o total de mensagens enviadas por uma campanha específica, paginando
   * GET /messages?source=Campaign&source_id={campaignId}. A API não tem um campo de
   * "total" pronto — só um booleano hasMore por página — então soma o tamanho de
   * cada página até acabar ou até o limite de segurança (evita loop infinito/rate
   * limit caso a paginação real use outro parâmetro do que o esperado aqui).
   *
   * IMPORTANTE: os nomes de parâmetro de paginação (page/limit) são um best-effort
   * baseado em convenção REST comum — ainda não testado contra a API real da
   * SlickText em produção. Validar com uma campanha pequena antes de confiar no
   * número em campanhas grandes.
   */
  async countCampaignMessages(
    campaignId: number,
    opts: { status?: string; maxPages?: number } = {}
  ): Promise<{ count: number; capped: boolean; pages: number }> {
    const maxPages = opts.maxPages ?? 40;
    let page = 1;
    let count = 0;
    let capped = false;

    while (page <= maxPages) {
      const params: any = { source: 'Campaign', source_id: campaignId, page, limit: 100 };
      if (opts.status) params.status = opts.status;

      const res = await this.http.get('/messages', { params });
      const items = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      count += items.length;

      const hasMore = res.data?.hasMore ?? res.data?.has_more ?? false;
      if (!hasMore || items.length === 0) {
        return { count, capped: false, pages: page };
      }
      page++;
    }
    capped = true;
    logger.warn(CTX, `countCampaignMessages: atingiu o limite de ${maxPages} páginas pra campaign_id=${campaignId} — número pode estar incompleto`);
    return { count, capped, pages: page - 1 };
  }

  /**
   * Message credit analytics — endpoint /analytics/message/credits returns 404.
   * Use getBrandUsage() instead for credit totals.
   */
  async getCreditAnalytics(_start?: string, _end?: string): Promise<any> {
    return null;
  }

  /**
   * Get campaign analytics (all campaigns).
   */
  async getCampaignAnalytics(): Promise<any> {
    const res = await this.http.get('/analytics/campaigns');
    return res.data;
  }

  /**
   * Get specific campaign analytics.
   */
  async getCampaignAnalyticsById(campaignId: number): Promise<any> {
    const res = await this.http.get(`/analytics/campaigns/${campaignId}`);
    return res.data;
  }

  /**
   * Get brand usage (credits available/used).
   */
  async getBrandUsage(): Promise<{
    total_credits: number;
    credits_used: number;
    credits_available: number;
  }> {
    const res = await this.http.get('/usage');
    return res.data;
  }

  // ── Helpers ──

  /**
   * Format a phone number for SlickText.
   * Strips non-digits, takes last 10, adds +1 prefix.
   * Returns null if phone is invalid.
   */
  static formatPhone(raw: string): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) return null;
    return `+1${digits}`;
  }

  /**
   * Validate that a phone number is suitable for SlickText.
   */
  static isValidPhone(raw: string): boolean {
    return SlickTextClient.formatPhone(raw) !== null;
  }
}
