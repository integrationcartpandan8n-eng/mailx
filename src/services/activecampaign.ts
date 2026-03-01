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

    // Rate limit: 5 req/s — add small delay between calls
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
}
