import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { env } from '../config/env';

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

/**
 * Semáforo por marca: limita requests simultâneos à SlickText por brand. Achado da
 * auditoria: várias contagens por período disparadas juntas (cada uma com ~35 sondas)
 * disputavam o rate limit de 8 req/s — 429s em cascata, linhas levando 30-90s. Com o
 * gate, as sondas fluem de forma ordenada mesmo com várias contagens em paralelo.
 */
const brandGates = new Map<string, { active: number; queue: (() => void)[] }>();
const MAX_CONCURRENT_PER_BRAND = 4;

async function acquireBrandSlot(brandId: string): Promise<() => void> {
  let gate = brandGates.get(brandId);
  if (!gate) {
    gate = { active: 0, queue: [] };
    brandGates.set(brandId, gate);
  }
  if (gate.active >= MAX_CONCURRENT_PER_BRAND) {
    await new Promise<void>((resolve) => gate!.queue.push(resolve));
  }
  gate.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate!.active--;
    const next = gate!.queue.shift();
    if (next) next();
  };
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

    // Semáforo por marca — ver acquireBrandSlot (achado da auditoria: sondas em paralelo
    // esgotavam o rate limit e travavam contagens por 30-90s).
    this.http.interceptors.request.use(async (config: any) => {
      config.__releaseSlot = await acquireBrandSlot(numericId);
      return config;
    });

    // Rate limit: 8 req/s for V2 — retry com backoff em 429 (até 3 tentativas; a única
    // tentativa de antes não bastava quando várias contagens rodavam juntas).
    this.http.interceptors.response.use(
      (res) => {
        (res.config as any).__releaseSlot?.();
        return res;
      },
      async (error) => {
        error.config?.__releaseSlot?.();
        const attempt = (error.config.__retry429 || 0) + 1;
        if (error.response?.status === 429 && attempt <= 3) {
          const waitMs = 1000 * attempt;
          logger.warn(CTX, `Rate limited — retry ${attempt}/3 em ${waitMs}ms`);
          await new Promise((r) => setTimeout(r, waitMs));
          error.config.__retry429 = attempt;
          delete error.config.__releaseSlot; // o retry adquire um slot novo no interceptor
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
   * Contagem de contatos de uma lista. Retorna null (não 0) quando a falha NÃO é o 404 esperado
   * de "esta lista pertence a outra conta" — 0 de verdade e "não consegui checar" são coisas
   * diferentes, e até aqui as duas viravam 0 do mesmo jeito. Achado ao auditar a aba SMS: um
   * timeout ou token vencido bem na hora de alguém abrir o painel fazia uma lista de 30 mil
   * contatos aparecer como "0" — indistinguível de a lista estar realmente vazia. Quem chama
   * decide o que fazer com null (normalmente: não deixar entrar como se fosse zero real).
   */
  async getListContactCount(listId: number): Promise<number | null> {
    try {
      const res = await this.http.get(`/lists/${listId}/contacts/count`);
      // Endpoint returns a bare number (e.g. 228), not an object
      if (typeof res.data === 'number') return res.data;
      return res.data?.count ?? res.data?.total ?? 0;
    } catch (err: any) {
      if (err.response?.status === 404) return 0; // lista não existe nesta conta — esperado
      logger.warn(CTX, `getListContactCount falhou pra lista ${listId} (não é 404 — pode ser falha real, não lista vazia): ${err.message}`);
      return null;
    }
  }

  // ── Analytics ──

  /**
   * Get contact analytics (total, by status, by source) — total do BRAND INTEIRO.
   * `listId` NÃO FUNCIONA — confirmado via probe em produção: com `list_id`, `_list_id` ou
   * sem filtro nenhum, /analytics/contacts sempre devolve o mesmo total do brand (66.774 nos
   * três casos testados). Pra contagem POR LISTA, use getListContactCount (GET
   * /lists/{id}/contacts/count), que é o endpoint certo — mas vitalício, sem filtro de período.
   */
  async getContactAnalytics(start?: string, end?: string, listId?: number): Promise<any> {
    const params: any = {};
    if (start) params.start = start;
    if (end) params.end = end;
    if (listId) params.list_id = listId; // mantido só por compat — não filtra nada, ver acima

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
   * ENVIOS (e créditos exatos) de UMA mensagem de workflow num PERÍODO, via GET /messages cru.
   * Fatos confirmados por probes em produção:
   * - filtro `_sub_source_id` (node) funciona; cada item tem `created` e `message_credits`;
   * - paginação é por `offset`+`limit` (`page` exige pageSize; limit máx aceito: 100);
   * - a listagem vem em ordem CRESCENTE de `created` (mais antigo primeiro) e não há filtro
   *   de data — varrer tudo custaria centenas de requests pra mensagens de alto volume.
   * Estratégia: BUSCA BINÁRIA por offset nas duas bordas do período (cada sonda busca 1 item):
   * count = primeiroOffset(created > end) - primeiroOffset(created >= start). ~2×log2(N)+galope
   * ≈ 30-40 requests de 1 item por mensagem — poucos segundos, independente do volume.
   * Créditos exatos: só quando o intervalo é pequeno (varre a fatia); senão credits=null e o
   * chamador usa 1 envio ≈ 1 crédito como estimativa.
   */
  async countWorkflowNodeMessages(
    workflowId: number,
    nodeId: number,
    startYmd: string,
    endYmd: string,
    opts: { creditsScanLimit?: number; approxTotal?: number } = {}
  ): Promise<{ count: number; credits: number | null; capped: boolean; pages: number }> {
    const creditsScanLimit = opts.creditsScanLimit ?? 500;
    const startKey = `${startYmd} 00:00:00`;
    const endKey = `${endYmd} 23:59:59`;
    const baseParams = { source: 'Workflow', source_id: workflowId, _sub_source_id: nodeId };
    let requests = 0;

    const fetchAt = async (offset: number, limit = 1): Promise<any[]> => {
      requests++;
      const res = await this.http.get('/messages', { params: { ...baseParams, offset, limit } });
      return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    };

    const first = await fetchAt(0);
    if (first.length === 0) return { count: 0, credits: 0, capped: false, pages: requests };

    // Teto pra busca binária: se o chamador já sabe o total vitalício do node (via node
    // analytics), usa com margem — poupa o galope (~6-10 requests por contagem). Senão,
    // galope dobrando o offset até vir vazio.
    let total: number;
    if (opts.approxTotal && opts.approxTotal > 0) {
      total = Math.ceil(opts.approxTotal * 1.2) + 200; // margem: mensagens continuam chegando
    } else {
      let hi = 1024;
      while ((await fetchAt(hi)).length > 0) {
        hi *= 2;
        if (hi > 1_000_000) break; // trava de segurança
      }
      total = hi;
    }

    // Primeiro offset cujo item satisfaz pred(created); itens além do fim contam como "satisfaz"
    // (created vazio = fim da lista). Ordem crescente confirmada — verificada de leve no galope.
    const lowerBound = async (pred: (created: string) => boolean): Promise<number> => {
      let lo = 0;
      let high = total;
      while (lo < high) {
        const mid = Math.floor((lo + high) / 2);
        const items = await fetchAt(mid);
        const created: string = items[0]?.created || '';
        if (!created || pred(created)) high = mid;
        else lo = mid + 1;
      }
      return lo;
    };

    const startIdx = await lowerBound(c => c >= startKey);
    const endIdx = await lowerBound(c => c > endKey);
    const count = Math.max(0, endIdx - startIdx);

    // Créditos exatos varrendo a fatia — só quando ela é pequena o bastante.
    let credits: number | null = null;
    if (count > 0 && count <= creditsScanLimit) {
      credits = 0;
      for (let off = startIdx; off < endIdx; off += 100) {
        const batch = await fetchAt(off, Math.min(100, endIdx - off));
        for (const item of batch) {
          credits += typeof item?.message_credits === 'number' ? item.message_credits : 1;
        }
        if (batch.length === 0) break;
      }
    } else if (count === 0) {
      credits = 0;
    }

    return { count, credits, capped: false, pages: requests };
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
   * timezone = env.APP_TZ (Brasília) aqui e nos demais métodos de analytics com período: o dia do
   * painel começa e termina nesse fuso dos DOIS lados da razão — o corte das vendas (nosso banco)
   * e a janela pedida aqui. Pedir UTC de um lado e cortar o dia em Brasília do outro faria
   * envios/venda comparar janelas diferentes, que é a classe de erro mais recorrente nesta base.
   * Era UTC antes; trocado junto com o corte de dia das vendas, nunca só de um lado.
   */
  async getWorkflowAnalytics(workflowId: number, start: string, end: string, timezone = env.APP_TZ): Promise<any> {
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
   * TODOS os links da marca, paginados (offset+limit, sem filtro de source). Necessário pros
   * links "manuais" — criados direto no encurtador (slk1.io) e colados na mensagem do workflow,
   * como os disparos N8N: eles têm source='manual' e _source_id/_sub_source_id nulos, então o
   * filtro source=Workflow nunca os enxerga (diagnóstico confirmado via dump em produção).
   */
  async getAllLinks(maxPages = 40): Promise<any[]> {
    const all: any[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.http.get('/links', { params: { offset, limit: 100 } });
      const items: any[] = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      if (items.length === 0) break;
      all.push(...items);
      if (items.length < 100) break;
      offset += 100;
    }
    return all;
  }

  /**
   * Cliques POR LINK de um workflow, filtrados por PERÍODO — endpoint do gráfico "Click
   * Performance" do painel, confirmado por captura real:
   * GET /analytics/links/clicks?link_source=Workflow&_link_source_id={id}&group=_link_id
   * devolve {totals:{total,average}, groups:[{name: <nome do link>, total, period:{...}}]}.
   * Como cada link tem a URL com o utm_campaign, dá pra somar cliques do período por
   * mensagem casando os nomes dos links (via getLinks) com os groups daqui.
   */
  async getLinkClicksGrouped(workflowId: number, start: string, end: string, timezone = env.APP_TZ): Promise<any> {
    const res = await this.http.get('/analytics/links/clicks', {
      params: { link_source: 'Workflow', _link_source_id: workflowId, group: '_link_id', start, end, compare: '', frequency: '', timezone, noCache: 0 },
    });
    return res.data;
  }

  // Nota (probes v1/v2 em produção): NÃO existe cliques-por-período pra link MANUAL —
  // /analytics/links/clicks ignora links manuais (groups nunca os incluem, filtrado ou não)
  // e /links/{id}/clicks|stats|analytics são 404. O que há é o total vitalício nos campos
  // clicks/unique_clicks/bot_clicks do registro do link (via getLinks/getAllLinks).

  /**
   * Total de mensagens enviadas de um source (Workflow/Campaign) no PERÍODO — endpoint do
   * gráfico "Messages Sent" do painel, confirmado por captura: devolve
   * {totals:{total,average},groups:[{name:'Messages',period:{...}}]}.
   * start/end "YYYY-MM-DD HH:mm:ss".
   */
  async getMessageAnalyticsForSource(source: 'Workflow' | 'Campaign', sourceId: number, start: string, end: string, timezone = env.APP_TZ): Promise<any> {
    const res = await this.http.get('/analytics/messages', {
      params: { source, _source_id: sourceId, attempted: 1, start, end, compare: '', frequency: '', timezone, noCache: 0 },
    });
    return res.data;
  }

  /**
   * Total de mensagens de AUTOMAÇÃO da marca inteira no período — mesmo número do gráfico
   * "Workflow Messages Sent" do painel. CONFERIDO contra o painel na marca 30571 em 01–29/07:
   * 13.116 aqui contra 13.081 lá, 0,27% de desvio (fuso — o painel fecha o dia em Nova York e a
   * gente em UTC). É a única validação externa que a plataforma permite, porque o painel só
   * agrega por marca e não quebra por mensagem. É o
   * denominador honesto pra saber quanto dos envios de automação da conta está coberto pelas
   * mensagens que temos vinculadas: sem ele, a soma dos vínculos não tem com o que ser comparada.
   * Sem _source_id — o filtro é só `source=Workflow`.
   */
  async getWorkflowMessagesTotalForBrand(start: string, end: string, timezone = env.APP_TZ): Promise<number | null> {
    const res = await this.http.get('/analytics/messages', {
      params: { source: 'Workflow', attempted: 1, start, end, compare: '', frequency: '', timezone, noCache: 0 },
    });
    const total = res.data?.totals?.total;
    return typeof total === 'number' ? total : null;
  }

  /**
   * Chamada crua de /messages com params livres — pra sondar quais FILTROS o endpoint aceita.
   * Achado que motivou: cada registro de /messages traz `_link_ids` (os links contidos naquela
   * mensagem). Se o endpoint aceitar filtro por link, dá pra contar envios das mensagens que usam
   * link MANUAL, que é o único caso sem contagem hoje — e sem precisar do node.
   */
  async rawMessages(params: Record<string, any>): Promise<any[]> {
    const res = await this.http.get('/messages', { params });
    return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
  }

  /**
   * Um registro cru de /messages de um workflow — pra descobrir QUAIS CAMPOS existem, em especial
   * se o corpo/texto da mensagem vem na resposta. Disso depende recuperar os envios das mensagens
   * que usam link manual (ver /diagnostico/probe-link-manual).
   */
  async rawMessagesSample(workflowId: number): Promise<any> {
    const res = await this.http.get('/messages', {
      params: { source: 'Workflow', source_id: workflowId, offset: 0, limit: 1 },
    });
    const items = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    return items[0] ?? null;
  }

  /**
   * Registros crus de /lists/{id}/contacts — pra descobrir se a SlickText devolve, por contato, a
   * data em que ele ENTROU NA LISTA (não a data de criação do contato em geral, que pode ser bem
   * anterior). Se esse campo existir, dá pra contar leads exatos de qualquer período sem depender
   * de retrato diário — inclusive retroativo, cobrindo período de antes de o retrato existir.
   *
   * offset/limit livres de propósito: primeira chamada é só pra ver os NOMES dos campos; depois
   * o diagnóstico decide se vale paginar a lista inteira.
   */
  async rawListContacts(listId: number, params: Record<string, any> = {}): Promise<any[]> {
    const res = await this.http.get(`/lists/${listId}/contacts`, { params });
    return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
  }

  /**
   * Procura pedaços de texto (ex: o slug de um link slk1.io criado à mão) no corpo das mensagens
   * de um workflow, e devolve o `_sub_source_id` — o node — de cada acerto. É o caminho para
   * recuperar envios por período de mensagem com link manual: o link não tem node, mas a MENSAGEM
   * que o contém tem.
   *
   * Amostra as duas pontas da lista (primeiras e últimas mensagens) em vez de paginar tudo: o
   * corpo de uma mensagem de automação não muda ao longo do tempo, então achar uma ocorrência já
   * resolve, e varrer dezenas de milhares de registros para confirmar o óbvio custaria minutos.
   */
  /**
   * Amostra as mensagens MAIS RECENTES da marca SEM filtrar por source, e devolve os valores
   * distintos de `source` junto das mensagens que contêm algum dos link_ids pedidos.
   *
   * Por que sem filtro de source: os links manuais se chamam "Lost Cart N8N", e se o n8n dispara
   * pela API da SlickText em vez de por workflow, essas mensagens não pertencem a workflow nenhum —
   * varrer os 13 fluxos um a um nunca acharia, por mais fluxos que se varra. Listar os `source` que
   * de fato existem responde de uma vez se há disparo fora de workflow.
   *
   * Lê as últimas páginas: a lista vem em ordem crescente de data (confirmado), e os links manuais
   * são de junho — o que interessa está no fim.
   */
  async amostrarMensagensRecentes(
    linkIds: number[],
    paginas = 5
  ): Promise<{
    fontes: Record<string, number>;
    total_aproximado: number;
    com_link_manual: Array<{ link_id: number; source: string | null; _source_id: number | null; node: number | null; created: string }>;
  }> {
    const pegar = async (offset: number, limit: number): Promise<any[]> => {
      const res = await this.http.get('/messages', { params: { offset, limit } });
      return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    };

    // Galope com limit=1 pra achar o fim sem baixar conteúdo.
    let hi = 1000;
    while (hi < 2_000_000 && (await pegar(hi, 1)).length > 0) hi *= 4;
    let lo = Math.floor(hi / 4);
    while (lo + 1000 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await pegar(mid, 1)).length > 0) lo = mid; else hi = mid;
    }
    const total = lo;

    const alvo = new Set(linkIds.map(Number));
    const fontes: Record<string, number> = {};
    const achados: Array<{ link_id: number; source: string | null; _source_id: number | null; node: number | null; created: string }> = [];

    for (let p = 0; p < paginas; p++) {
      const offset = Math.max(0, total - (p + 1) * 100);
      const itens = await pegar(offset, 100);
      for (const m of itens) {
        const src = m?.source == null ? '(null)' : String(m.source);
        fontes[src] = (fontes[src] ?? 0) + 1;
        const ids: number[] = Array.isArray(m?._link_ids) ? m._link_ids.map(Number) : [];
        for (const id of ids) {
          if (!alvo.has(id)) continue;
          achados.push({
            link_id: id,
            source: m?.source ?? null,
            _source_id: m?._source_id ?? null,
            node: m?._sub_source_id != null ? Number(m._sub_source_id) : null,
            created: String(m?.created ?? ''),
          });
        }
      }
      if (offset === 0) break;
    }

    return { fontes, total_aproximado: total, com_link_manual: achados };
  }

  /**
   * Procura link_ids dentro do campo `_link_ids` das mensagens de um workflow. Mais confiável que
   * casar texto do corpo: `_link_ids` é o vínculo que a própria SlickText registra entre mensagem e
   * link, sem depender de o encurtador aparecer escrito de determinada forma (o corpo traz
   * `slk1.io/41a3/247840517`, com sufixo por contato, então casar string exigiria adivinhar o
   * prefixo).
   *
   * Amostra as duas pontas da lista em vez de paginar tudo: o conjunto de links de uma mensagem de
   * automação não muda ao longo do tempo, então uma ocorrência já responde qual workflow é.
   */
  async acharLinksEmMensagens(
    workflowId: number,
    linkIds: number[]
  ): Promise<Array<{ link_id: number; node: number | null; created: string }>> {
    const pegar = async (offset: number, limit = 100): Promise<any[]> => {
      const res = await this.http.get('/messages', {
        params: { source: 'Workflow', source_id: workflowId, offset, limit },
      });
      return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    };

    const inicio = await pegar(0);
    if (inicio.length === 0) return [];
    // Galope com limit=1: só interessa SE existe registro naquele offset, não o conteúdo. Com
    // limit=100 cada passo trazia 100 registros completos (corpo da mensagem incluso) só pra
    // descobrir onde a lista termina — foi isso que estourou o timeout do nginx em produção.
    let hi = 100;
    while (hi < 200_000 && (await pegar(hi, 1)).length > 0) hi *= 4;
    const fim = hi > 100 ? await pegar(Math.max(0, Math.floor(hi / 4))) : [];

    const alvo = new Set(linkIds.map(Number));
    const achados: Array<{ link_id: number; node: number | null; created: string }> = [];
    const vistos = new Set<number>();
    for (const item of [...inicio, ...fim]) {
      const ids: number[] = Array.isArray(item?._link_ids) ? item._link_ids.map(Number) : [];
      for (const id of ids) {
        if (!alvo.has(id) || vistos.has(id)) continue;
        vistos.add(id);
        achados.push({
          link_id: id,
          node: item?._sub_source_id != null ? Number(item._sub_source_id) : null,
          created: String(item?.created ?? ''),
        });
      }
    }
    return achados;
  }

  async procurarTextoEmMensagens(
    workflowId: number,
    trechos: string[]
  ): Promise<Array<{ trecho: string; node: number | null; amostra_do_corpo: string }>> {
    const pegar = async (offset: number, limit = 100): Promise<any[]> => {
      const res = await this.http.get('/messages', {
        params: { source: 'Workflow', source_id: workflowId, offset, limit },
      });
      return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    };

    const inicio = await pegar(0);
    if (inicio.length === 0) return [];
    // Galope com limit=1 — ver nota em acharLinksEmMensagens.
    let hi = 100;
    while (hi < 200_000 && (await pegar(hi, 1)).length > 0) hi *= 4;
    const fim = hi > 100 ? await pegar(Math.max(0, Math.floor(hi / 4))) : [];

    const achados: Array<{ trecho: string; node: number | null; amostra_do_corpo: string }> = [];
    const vistos = new Set<string>();
    for (const item of [...inicio, ...fim]) {
      // Sem assumir nome de campo: concatena todo valor de texto do registro.
      const texto = Object.values(item ?? {}).filter(v => typeof v === 'string').join(' ');
      for (const t of trechos) {
        if (!texto.includes(t)) continue;
        const node = item?._sub_source_id ?? item?.sub_source_id ?? null;
        const chave = `${t}:${node}`;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        achados.push({ trecho: t, node: node != null ? Number(node) : null, amostra_do_corpo: texto.slice(0, 300) });
      }
    }
    return achados;
  }

  /**
   * Chamada crua de /analytics/messages com os params que o chamador quiser — usada pela sonda que
   * decidiu a SEMÂNTICA do endpoint (ver /diagnostico/probe-envios).
   *
   * RESOLVIDO: o total é MENSAGEM ENVIADA, não crédito. A sonda variou attempted (1, 0, ausente),
   * source e direction: todas as variantes com source=Workflow devolvem o mesmo número, attempted
   * não altera nada e attempted=0 devolve vazio. Existe um único total por marca e ele é mensagem.
   *
   * Houve um susto no meio do caminho que vale registrar pra não se repetir: comparou-se o 38.191
   * da marca 27972 com o 13.081 lido do painel e a razão deu 2,9x, o que parecia indicar contagem
   * em trechos. Eram MARCAS DIFERENTES — o painel aberto era o da 30571, cujo total pela API é
   * 13.116 contra 13.081 do painel (0,27%, fuso horário). Ao conferir contra o painel, confirme
   * primeiro de qual brand a tela é.
   */
  async rawMessageAnalytics(params: Record<string, any>): Promise<any> {
    const res = await this.http.get('/analytics/messages', { params });
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
  async getWorkflowNodeAnalytics(workflowId: number, nodeId: number, start: string, end: string, timezone = env.APP_TZ): Promise<any> {
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
