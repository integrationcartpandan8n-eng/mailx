import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

const CTX = 'ActiveCampaign';

export class ActiveCampaignClient {
  private http: AxiosInstance;

  constructor(apiUrl: string, apiKey: string) {
    this.http = axios.create({
      baseURL: `${apiUrl}/api/3`,
      headers: { 'Api-Token': apiKey },
      timeout: 15000,
    });

    // Rate limit: 5 req/s — exponential backoff, max 3 retries (1s, 2s, 4s)
    this.http.interceptors.response.use(
      (res) => res,
      async (error) => {
        if (error.response?.status === 429) {
          const attempt = (error.config.__retryCount || 0) + 1;
          if (attempt > 3) {
            logger.warn(CTX, 'Rate limited — max retries reached, giving up');
            throw error;
          }
          const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
          logger.warn(CTX, `Rate limited — retry ${attempt}/3 in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          error.config.__retryCount = attempt;
          return this.http.request(error.config);
        }
        throw error;
      }
    );
  }

  // ── Contacts ──

  async syncContact(data: {
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
  }): Promise<{ id: string }> {
    const res = await this.http.post('/contact/sync', { contact: data });
    logger.info(CTX, `Contact synced: ${data.email}`, { id: res.data.contact.id });
    return res.data.contact;
  }

  async updateContactCustomField(
    contactId: string,
    fieldId: string,
    value: string
  ): Promise<void> {
    await this.http.post('/fieldValues', {
      fieldValue: { contact: contactId, field: fieldId, value },
    });
    logger.debug(CTX, `Custom field ${fieldId} updated for contact ${contactId}`);
  }

  // ── Lists ──

  async createList(data: {
    name: string;
    stringid: string;
    senderUrl?: string;
    senderReminder?: string;
  }): Promise<{ id: string }> {
    const res = await this.http.post('/lists', {
      list: {
        name: data.name,
        stringid: data.stringid,
        sender_url: data.senderUrl ?? 'https://mailxgroup.com',
        sender_reminder: data.senderReminder ?? 'Você recebe este email pois interagiu com nossa loja.',
      },
    });
    logger.info(CTX, `List created: ${data.name}`, { id: res.data.list.id });
    return res.data.list;
  }

  async findListByName(name: string): Promise<{ id: string } | null> {
    const res = await this.http.get('/lists', { params: { 'filters[name]': name } });
    return res.data.lists[0] ?? null;
  }

  async addContactToList(contactId: string, listId: string): Promise<void> {
    await this.http.post('/contactLists', {
      contactList: { list: listId, contact: contactId, status: 1 },
    });
    logger.debug(CTX, `Contact ${contactId} added to list ${listId}`);
  }

  // ── Tags ──

  async createTag(data: {
    tag: string;
    description?: string;
  }): Promise<{ id: string }> {
    const res = await this.http.post('/tags', {
      tag: { tag: data.tag, tagType: 'contact', description: data.description ?? '' },
    });
    logger.info(CTX, `Tag created: ${data.tag}`, { id: res.data.tag.id });
    return res.data.tag;
  }

  async findTagByName(name: string): Promise<{ id: string } | null> {
    const res = await this.http.get('/tags', { params: { search: name } });
    const exact = res.data.tags.find((t: any) => t.tag === name);
    return exact ?? null;
  }

  async addTagToContact(contactId: string, tagId: string): Promise<void> {
    await this.http.post('/contactTags', {
      contactTag: { contact: contactId, tag: tagId },
    });
    logger.debug(CTX, `Tag ${tagId} added to contact ${contactId}`);
  }

  // ── Automations ──

  async listAutomations(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.http.get('/automations');
    return res.data.automations;
  }

  async addContactToAutomation(contactId: string, automationId: string): Promise<void> {
    await this.http.post('/contactAutomations', {
      contactAutomation: { contact: contactId, automation: automationId },
    });
    logger.info(CTX, `Contact ${contactId} added to automation ${automationId}`);
  }

  // ── Reporting ──

  /**
   * Aggregates send/open/click totals across all campaigns sent in the last `daysBack` days.
   * Iterates campaigns in DESC sdate order, stops once a campaign older than the window is seen.
   * Status 5 = sent (per AC docs).
   */
  async getCampaignsAggregate(daysBack: number = 30): Promise<{
    campaigns: number;
    send_amt: number;
    opens: number;
    uniqueopens: number;
    linkclicks: number;
    uniquelinkclicks: number;
  }> {
    const sinceMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    const totals = { campaigns: 0, send_amt: 0, opens: 0, uniqueopens: 0, linkclicks: 0, uniquelinkclicks: 0 };
    let offset = 0;

    for (let page = 0; page < 10; page++) {
      const res = await this.http.get('/campaigns', {
        params: { limit: 100, offset, 'orders[sdate]': 'DESC' },
      });
      const items: any[] = res.data?.campaigns ?? [];
      if (items.length === 0) break;

      let stop = false;
      for (const c of items) {
        const sdate = c.sdate ? new Date(c.sdate).getTime() : NaN;
        if (Number.isNaN(sdate)) continue;
        if (sdate < sinceMs) {
          stop = true;
          break;
        }
        if (String(c.status) !== '5') continue;
        totals.campaigns++;
        totals.send_amt += parseInt(c.send_amt || '0', 10);
        totals.opens += parseInt(c.opens || '0', 10);
        totals.uniqueopens += parseInt(c.uniqueopens || '0', 10);
        totals.linkclicks += parseInt(c.linkclicks || '0', 10);
        totals.uniquelinkclicks += parseInt(c.uniquelinkclicks || '0', 10);
      }

      if (stop || items.length < 100) break;
      offset += 100;
    }

    return totals;
  }

  /**
   * Count contacts created in the last `daysBack` days.
   * AC supports `filters[created_after]=YYYY-MM-DD` on the contacts endpoint.
   * Falls back to total contact count if the filter is rejected.
   */
  async getNewContactsCount(daysBack: number = 30): Promise<number> {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    try {
      const res = await this.http.get('/contacts', {
        params: { limit: 1, 'filters[created_after]': since },
      });
      return parseInt(res.data?.meta?.total || '0', 10);
    } catch (err: any) {
      logger.warn(CTX, `getNewContactsCount filter failed (${err.message}) — falling back to total`);
      const res = await this.http.get('/contacts', { params: { limit: 1 } });
      return parseInt(res.data?.meta?.total || '0', 10);
    }
  }

  /**
   * Todas as tags da conta, paginadas. Necessário pro auto-vínculo por FAMÍLIA de produto:
   * as tags são nomeadas "[Glyco Pulse] Compra Aprovada" (família) e os produtos chegam do
   * gateway por SKU ("M2 - Glyco Pulse (3 Bottles)"), então não dá pra buscar por nome exato —
   * é preciso ler a lista e casar por substring.
   */
  async listTags(maxPages = 10): Promise<Array<{ id: string; tag: string }>> {
    const all: Array<{ id: string; tag: string }> = [];
    for (let page = 0; page < maxPages; page++) {
      const res = await this.http.get('/tags', { params: { limit: 100, offset: page * 100 } });
      const items: any[] = res.data?.tags ?? [];
      if (items.length === 0) break;
      all.push(...items.map((t: any) => ({ id: String(t.id), tag: String(t.tag) })));
      if (items.length < 100) break;
    }
    return all;
  }

  /**
   * Total de contatos com uma TAG específica (equivalente às listas de segmento do SlickText,
   * usado com kits.ac_tag_compra_id/ac_tag_abandono_id). limit:1 pra só ler meta.total sem
   * paginar os registros. Vitalício — a API de contatos por tag não filtra por período.
   */
  async getContactCountByTag(tagId: string): Promise<number> {
    const res = await this.http.get('/contacts', {
      params: { limit: 1, 'filters[tagid]': tagId },
    });
    return parseInt(res.data?.meta?.total || '0', 10);
  }
}
