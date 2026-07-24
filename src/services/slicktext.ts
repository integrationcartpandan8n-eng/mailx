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
      // encodeURIComponent estrito: o serializer default do axios manda espaço como "+"
      // (start=2026-07-24+00:00:00), e o backend da SlickText descarta a data SILENCIOSAMENTE
      // e devolve totais vitalícios — confirmado em produção ("Hoje" retornava o total de
      // sempre). O painel deles manda %20/%3A (start=2026-07-24%2000%3A00%3A00); replicamos.
      paramsSerializer: {
        serialize: (params: Record<string, any>) =>
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&'),
      },
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
   * `listId` escopa pra uma lista específica em vez do brand inteiro — NÃO confirmado
   * contra a API real (best-effort, mesma ressalva de countCampaignMessages). Validar
   * com uma lista pequena antes de confiar no número.
   */
  async getContactAnalytics(start?: string, end?: string, listId?: number): Promise<any> {
    const params: any = {};
    if (start) params.start = start;
    if (end) params.end = end;
    if (listId) params.list_id = listId;

    const res = await this.http.get('/analytics/contacts', { params });
    return res.data;
  }

  /**
   * Total de contatos novos (leads) de uma lista específica num período — usa
   * getContactAnalytics escopado por list_id. Retorna null se a API não aceitar o
   * escopo por lista (nesse caso o número viria errado, misturando outras listas).
   */
  extractContactAnalyticsTotal(analyticsResponse: any): number {
    return analyticsResponse?.totals?.total ?? analyticsResponse?.total ?? 0;
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
   * Uma mensagem individual tem clique registrado? Confirmado pelo Nicollas que o
   * clique vem junto do mesmo objeto de mensagem (GET /messages) usado pra contar
   * envios — mas o nome exato do campo não foi confirmado, então checa os
   * candidatos mais prováveis defensivamente. Se nenhum bater, undercounta cliques
   * silenciosamente (fica 0) em vez de quebrar — por isso `clicksFieldFound` no
   * retorno de countCampaignMessages, pra saber se algum campo foi de fato achado.
   */
  private static messageWasClicked(item: any): boolean {
    if (typeof item?.clicked === 'boolean') return item.clicked;
    if (typeof item?.link_clicked === 'boolean') return item.link_clicked;
    if (typeof item?.is_clicked === 'boolean') return item.is_clicked;
    if (typeof item?.click_count === 'number') return item.click_count > 0;
    if (typeof item?.clicks === 'number') return item.clicks > 0;
    if (Array.isArray(item?.links_clicked)) return item.links_clicked.length > 0;
    if (typeof item?.status === 'string') return /clicked/i.test(item.status);
    return false;
  }

  private static hasAnyClickField(item: any): boolean {
    return (
      item?.clicked !== undefined ||
      item?.link_clicked !== undefined ||
      item?.is_clicked !== undefined ||
      item?.click_count !== undefined ||
      item?.clicks !== undefined ||
      item?.links_clicked !== undefined ||
      (typeof item?.status === 'string' && /clicked/i.test(item.status))
    );
  }

  /**
   * Conta o total de mensagens enviadas (e cliques) de uma campanha OU workflow
   * específico, paginando GET /messages?source={sourceType}&source_id={id}. Confirmado
   * (inspecionando o painel da SlickText) que as automações do MailX são disparadas via
   * Workflow — Campaign é só pra disparos manuais em massa — por isso o source_type é
   * parametrizável em vez de fixo em 'Campaign'.
   *
   * A API não tem um campo de "total" pronto — só um booleano hasMore por página —
   * então soma o tamanho de cada página até acabar ou até o limite de segurança (evita
   * loop infinito/rate limit caso a paginação real use outro parâmetro do que o
   * esperado aqui).
   *
   * IMPORTANTE: os nomes de parâmetro de paginação (page/limit) e do campo de
   * clique são best-effort — não testados contra a API real da SlickText em
   * produção. Validar com uma campanha/workflow pequeno antes de confiar no número em
   * volumes grandes. `clicksFieldFound=false` no retorno avisa quando nenhum
   * campo de clique conhecido apareceu no payload (nesse caso `clicks` é só um
   * chute de 0, não um dado real).
   */
  async countCampaignMessages(
    sourceId: number,
    opts: { status?: string; maxPages?: number; sourceType?: 'Campaign' | 'Workflow' } = {}
  ): Promise<{ count: number; clicks: number; clicksFieldFound: boolean; capped: boolean; pages: number }> {
    const maxPages = opts.maxPages ?? 40;
    const sourceType = opts.sourceType ?? 'Campaign';
    let page = 1;
    let count = 0;
    let clicks = 0;
    let clicksFieldFound = false;
    let capped = false;

    while (page <= maxPages) {
      const params: any = { source: sourceType, source_id: sourceId, page, limit: 100 };
      if (opts.status) params.status = opts.status;

      const res = await this.http.get('/messages', { params });
      const items = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      count += items.length;
      for (const item of items) {
        if (SlickTextClient.hasAnyClickField(item)) clicksFieldFound = true;
        if (SlickTextClient.messageWasClicked(item)) clicks++;
      }

      const hasMore = res.data?.hasMore ?? res.data?.has_more ?? false;
      if (!hasMore || items.length === 0) {
        return { count, clicks, clicksFieldFound, capped: false, pages: page };
      }
      page++;
    }
    capped = true;
    logger.warn(CTX, `countCampaignMessages: atingiu o limite de ${maxPages} páginas pra ${sourceType.toLowerCase()}_id=${sourceId} — número pode estar incompleto`);
    return { count, clicks, clicksFieldFound, capped, pages: page - 1 };
  }

  /**
   * ENVIOS (e créditos exatos) de UMA mensagem de workflow num PERÍODO — paginando o
   * GET /messages cru. Confirmado via probe em produção:
   * - o filtro `_sub_source_id` (node) FUNCIONA no /messages (o analytics ignora, aqui não);
   * - cada item tem `created` ("YYYY-MM-DD HH:mm:ss") e `message_credits` (créditos reais).
   * Conta client-side os itens com created dentro de [start, end]. Se as páginas vierem em
   * ordem decrescente de created (detectado na 1ª página), para cedo ao passar do início do
   * período — barato pra "Hoje"/7d. Cap de segurança marca `capped` (número parcial).
   * startYmd/endYmd: "YYYY-MM-DD" (comparação lexicográfica com o prefixo de `created`).
   */
  async countWorkflowNodeMessages(
    workflowId: number,
    nodeId: number,
    startYmd: string,
    endYmd: string,
    opts: { maxPages?: number } = {}
  ): Promise<{ count: number; credits: number; capped: boolean; pages: number }> {
    const maxPages = opts.maxPages ?? 80;
    const startKey = `${startYmd} 00:00:00`;
    const endKey = `${endYmd} 23:59:59`;
    let page = 1;
    let count = 0;
    let credits = 0;
    let sortedDesc: boolean | null = null;

    while (page <= maxPages) {
      const params: any = { source: 'Workflow', source_id: workflowId, _sub_source_id: nodeId, page, limit: 100 };
      const res = await this.http.get('/messages', { params });
      const items: any[] = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      if (items.length === 0) return { count, credits, capped: false, pages: page };

      if (sortedDesc === null && items.length > 1) {
        const first = items[0]?.created || '';
        const last = items[items.length - 1]?.created || '';
        sortedDesc = first >= last;
      }

      let allOlderThanStart = true;
      for (const item of items) {
        const created: string = item?.created || '';
        if (!created) continue;
        if (created >= startKey) allOlderThanStart = false;
        if (created >= startKey && created <= endKey) {
          count++;
          credits += typeof item?.message_credits === 'number' ? item.message_credits : 1;
        }
      }

      // Ordem decrescente + página inteira antes do início do período = não vem mais nada útil.
      if (sortedDesc && allOlderThanStart) {
        return { count, credits, capped: false, pages: page };
      }

      const hasMore = res.data?.hasMore ?? res.data?.has_more ?? res.data?.pagingData?.hasMore ?? (items.length === 100);
      if (!hasMore) return { count, credits, capped: false, pages: page };
      page++;
    }
    logger.warn(CTX, `countWorkflowNodeMessages: cap de ${maxPages} páginas no node ${nodeId} (workflow ${workflowId}) — contagem parcial`);
    return { count, credits, capped: true, pages: page - 1 };
  }

  /**
   * Message credit analytics — endpoint /analytics/message/credits returns 404.
   * Use getBrandUsage() instead for credit totals.
   */
  async getCreditAnalytics(_start?: string, _end?: string): Promise<any> {
    return null;
  }

  /**
   * Lista as campanhas cadastradas na marca (id + nome), pra preencher o dropdown de
   * "Vincular campanha" no dashboard sem precisar caçar o campaign_id manualmente
   * dentro do painel da SlickText.
   */
  async getCampaigns(): Promise<{ campaign_id: number; name: string; status?: string; created?: string }[]> {
    const res = await this.http.get('/campaigns');
    return res.data?.data || res.data || [];
  }

  /**
   * Lista os workflows cadastrados na marca (id + nome) — confirmado que é onde as
   * automações do MailX (carrinho abandonado, upsell) realmente vivem, não em Campaigns.
   * Endpoint/formato ainda best-effort (por analogia a /campaigns) — não confirmado
   * contra a API real. Se retornar 404, o dropdown do dashboard cai pro modo manual.
   */
  async getWorkflows(): Promise<{ workflow_id: number; name: string; status?: string; created?: string }[]> {
    const res = await this.http.get('/workflows');
    const raw = res.data?.data || res.data || [];
    return raw.map((w: any) => ({
      workflow_id: w.workflow_id ?? w.id,
      name: w.name,
      status: w.status,
      created: w.created,
    }));
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
   * Série temporal de ENTRADAS de um workflow no período (gráfico "Workflow Entrances").
   * ATENÇÃO: apesar do nome do path, esse endpoint com `_workflow_id` na query devolve SÓ
   * {totals:{total,average},groups:[...]} — nada de messages/clicks/links (confirmado via
   * probe em produção com token; a resposta rica fica em getWorkflowAnalyticsById).
   *
   * timezone default UTC (aqui e nos demais métodos de analytics com período): as janelas de
   * data do dashboard vêm do CURRENT_DATE do Postgres (UTC) e as vendas são filtradas por
   * created_at em UTC — a SlickText precisa interpretar start/end no MESMO fuso, senão a razão
   * envios/venda compara janelas diferentes (o painel deles usa America/New_York, nós não).
   */
  async getWorkflowAnalytics(workflowId: number, start: string, end: string, timezone = 'UTC'): Promise<any> {
    const res = await this.http.get('/analytics/workflows', {
      params: { _workflow_id: workflowId, start, end, compare: '', frequency: '', timezone, noCache: 0 },
    });
    return res.data;
  }

  /**
   * Resumo VITALÍCIO de um workflow: {totals:{entrances,messages,clicks,...}, workflow,
   * links} — os `links` trazem a URL completa (com utm_campaign) e o `_sub_source_id`
   * (workflow_node_id da mensagem que contém o link). Formato confirmado pela captura do
   * painel; o probe v1 deu 404 só porque testamos o workflow na conta errada.
   * Não aceita filtro de período — pra números por período use os endpoints de node ou
   * getMessageAnalyticsForSource.
   */
  async getWorkflowAnalyticsById(workflowId: number): Promise<any> {
    const res = await this.http.get(`/analytics/workflows/${workflowId}`);
    return res.data;
  }

  /**
   * Lista os LINKS rastreados da marca — cada item tem url (com utm_campaign), source
   * ('Workflow'/'Campaign'), _source_id e _sub_source_id (node da mensagem). Filtro por
   * `_source_id` CONFIRMADO via probe em produção (voltou exatamente os links do
   * workflow). Retorna {data:[...], pagingData}.
   */
  async getLinks(params: { source?: string; _source_id?: number } = {}): Promise<any[]> {
    const res = await this.http.get('/links', { params });
    return res.data?.data || res.data || [];
  }

  /**
   * Cliques POR LINK de um workflow, filtrados por PERÍODO — endpoint do gráfico "Click
   * Performance" do painel, confirmado por captura real:
   * GET /analytics/links/clicks?link_source=Workflow&_link_source_id={id}&group=_link_id
   * devolve {totals:{total,average}, groups:[{name: <nome do link>, total, period:{...}}]}.
   * Como cada link tem a URL com o utm_campaign, dá pra somar cliques do período por
   * mensagem casando os nomes dos links (via getLinks) com os groups daqui.
   */
  async getLinkClicksGrouped(workflowId: number, start: string, end: string, timezone = 'UTC'): Promise<any> {
    const res = await this.http.get('/analytics/links/clicks', {
      params: { link_source: 'Workflow', _link_source_id: workflowId, group: '_link_id', start, end, compare: '', frequency: '', timezone, noCache: 0 },
    });
    return res.data;
  }

  /**
   * Total de mensagens enviadas de um source (Workflow/Campaign) no PERÍODO — endpoint do
   * gráfico "Messages Sent" do painel, confirmado por captura: devolve
   * {totals:{total,average},groups:[{name:'Messages',period:{...}}]}.
   * start/end "YYYY-MM-DD HH:mm:ss".
   */
  async getMessageAnalyticsForSource(source: 'Workflow' | 'Campaign', sourceId: number, start: string, end: string, timezone = 'UTC'): Promise<any> {
    const res = await this.http.get('/analytics/messages', {
      params: { source, _source_id: sourceId, attempted: 1, start, end, compare: '', frequency: '', timezone, noCache: 0 },
    });
    return res.data;
  }

  /**
   * Analytics de UMA mensagem específica (nó) dentro de um workflow, filtrado por
   * período — CONFIRMADO contra a API real (mesma origem do getWorkflowAnalytics).
   * `totals.messages` = envios dessa mensagem no período; `totals.clicks` = cliques;
   * `workflow_node.name` = nome legível da mensagem (ex: "[Produto] [Tipo] [01]").
   * Isso é o que resolve o caso de várias mensagens (MS0001A/02A/03A) dentro do MESMO
   * workflow — cada uma tem seu próprio workflow_node_id, com números separados de
   * verdade (não o total do workflow inteiro somado).
   *
   * start/end no formato "YYYY-MM-DD HH:mm:ss".
   */
  async getWorkflowNodeAnalytics(workflowId: number, nodeId: number, start: string, end: string, timezone = 'UTC'): Promise<any> {
    const res = await this.http.get(`/analytics/workflows/${workflowId}/nodes/${nodeId}`, {
      params: { start, end, compare: '', frequency: '', timezone, noCache: 0 },
    });
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
