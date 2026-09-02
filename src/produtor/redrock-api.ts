/**
 * Cliente da Client Financial API da Red Rock Labs.
 *
 * É a API de LEITURA da própria empresa: só GET, escopo `client:read`, e o que ela devolve é o que
 * o fornecedor já cobrou. Não é a Fulfillment API — aquela serve para CRIAR pedido, e o
 * `/orders/costs` dela nem tem resposta documentada. Esta tem schema para tudo que a gente lê.
 *
 * O que ela resolve, em uma frase: o custo real deixa de ser um número por semana num PDF e passa
 * a ser um número por pedido, quebrado em produto / fulfillment / frete / embalagem.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Três decisões que estão aqui porque errar nelas é caro:
 *
 * 1. A token NUNCA sai deste módulo. Toda falha vira `ErroRedRock`, com mensagem passada por um
 *    scrub. Um erro do axios carrega `config.headers.Authorization` dentro dele, então basta
 *    alguém dar `logger.error(ctx, String(err))` num lugar distraído para a credencial ir parar no
 *    arquivo de log — que é justamente o que a gente combinou de não deixar acontecer.
 *
 * 2. Paginação tem teto. `/orders` pagina por `has_more` e NÃO devolve total; um bug do outro lado
 *    que deixe `has_more` preso em true vira laço infinito puxando a mesma página. O teto
 *    transforma isso num aviso na tela em vez de um processo comendo o servidor.
 *
 * 3. 429 é esperado, não excepcional. O limite é 120 req/min por token, e uma sincronização de
 *    três meses passa perto disso. O cliente se auto-limita antes e respeita `Retry-After` quando
 *    mesmo assim bater.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { logger } from '../utils/logger';

const CTX = 'RedRockAPI';

export const REDROCK_BASE_URL =
  process.env.REDROCK_API_URL || 'https://redrocklabsinc.com/api/v1/client';

/** Teto de páginas por recurso. 100 páginas × 100 por página = 10 mil pedidos numa sincronização. */
const MAX_PAGINAS = 100;
/** O limite documentado é 120/min. 100 deixa folga para outra aba do painel puxando ao mesmo tempo. */
const REQ_POR_MINUTO = 100;
const INTERVALO_MS = Math.ceil(60_000 / REQ_POR_MINUTO);
const TIMEOUT_MS = 30_000;
const MAX_TENTATIVAS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Tipos — copiados do schema publicado, com nullable onde a doc diz nullable.
//
// O `| null` não é decoração: `total` vem null em pedido não faturado e `country_code` vem null em
// pedido sem endereço. Tipar tudo como number faria o TypeScript garantir uma coisa que a API não
// garante, e o null chegaria no banco como 0 ou 'null' sem ninguém reclamar no caminho.
// ─────────────────────────────────────────────────────────────────────────────

export interface RRTotais {
  product: number | null;
  fulfillment: number | null;
  shipping: number | null;
  packaging: number | null;
  other: number | null;
}

export interface RRChargeLine {
  date: string | null;
  activity: string | null;
  charge: string | null;
  description: string | null;
  quantity: number | null;
  amount: number | null;
  invoice_number: string | null;
}

export interface RROrderCost {
  order: string;
  order_number: string | null;
  customer_name: string | null;
  country_code: string | null;
  order_created_at: string | null;
  invoiced: boolean;
  total: number | null;
  totals: RRTotais | null;
  awaiting_freight: boolean;
  invoice_numbers: string[] | null;
  charges: RRChargeLine[] | null;
}

export interface RRInvoice {
  id: string;
  invoice_number: string | null;
  invoiced_at: string | null;
  due_at: string | null;
  is_overdue: boolean;
  currency: string;
  total: number | null;
  amount_paid: number | null;
  outstanding: number | null;
  payment_status: string;
  charge_count: number | null;
  last_activity_date: string | null;
}

export interface RRPaisEntrega {
  country_code: string | null;
  charge_line_count: number | null;
  order_count: number | null;
  total_shipping_cost: number | null;
  avg_shipping_per_order: number | null;
}

export interface RREntregas {
  date_from: string | null;
  date_to: string | null;
  total_shipping_cost: number | null;
  total_charge_lines: number | null;
  total_orders: number | null;
  avg_shipping_per_order: number | null;
  countries: RRPaisEntrega[];
}

export interface RRIdentidade {
  empresa_id: string | null;
  empresa_nome: string | null;
  usuario_nome: string | null;
  usuario_email: string | null;
}

/**
 * Erro de chamada à Red Rock, já higienizado.
 *
 * `permanente` separa "não adianta tentar de novo" (token errada, token revogada, empresa errada)
 * de "tenta mais tarde" (rede, 5xx, limite). A tela usa isso para saber se manda o usuário
 * conferir a credencial ou só esperar — dizer "erro ao sincronizar" para os dois casos faria a
 * pessoa recadastrar a token toda vez que a internet do fornecedor oscilasse.
 */
export class ErroRedRock extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly permanente: boolean
  ) {
    super(message);
    this.name = 'ErroRedRock';
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function esperar(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Tira do texto qualquer coisa com cara de credencial.
 *
 * Recebe a token para apagar por igualdade — que é o caso que importa — e ainda passa uma regra
 * genérica por cima, porque a mensagem pode trazer uma token que não é a que está em mãos (um
 * `Bearer` ecoado pelo servidor do outro lado, por exemplo).
 */
export function limparSegredo(texto: string, token?: string): string {
  let s = texto;
  if (token && token.length >= 8) s = s.split(token).join('***');
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer ***');
  return s;
}

/** Mensagem em português para os códigos que têm significado próprio nesta API. */
function descreverStatus(status: number, corpo: any): { msg: string; permanente: boolean } {
  const detalhe =
    (corpo && typeof corpo === 'object' && (corpo.message || corpo.error)) || '';
  switch (status) {
    case 401:
      return {
        msg: 'A Red Rock recusou a token (401). Ela pode ter sido revogada, ter expirado ou ter ' +
          'sido copiada incompleta. Gere uma nova em API Tokens e cadastre de novo.',
        permanente: true,
      };
    case 403:
      return {
        msg: 'A token foi aceita mas não tem permissão para esta leitura (403). Confira se ela ' +
          'foi criada com a permissão "client:read".',
        permanente: true,
      };
    case 404:
      return { msg: 'A Red Rock respondeu que o recurso não existe (404).', permanente: true };
    case 422:
      return {
        msg: `A Red Rock recusou os parâmetros da consulta (422)${detalhe ? `: ${detalhe}` : '.'}`,
        permanente: true,
      };
    case 429:
      return { msg: 'Limite de requisições da Red Rock atingido (429).', permanente: false };
    default:
      if (status >= 500) {
        return { msg: `A Red Rock respondeu com erro interno (${status}).`, permanente: false };
      }
      return {
        msg: `A Red Rock respondeu ${status}${detalhe ? `: ${detalhe}` : '.'}`,
        permanente: status < 500,
      };
  }
}

export class RedRockClient {
  private readonly http: AxiosInstance;
  private proximaJanela = 0;

  constructor(private readonly token: string, baseURL: string = REDROCK_BASE_URL) {
    if (!token || token.trim().length < 8) {
      throw new ErroRedRock('Token da Red Rock não cadastrada ou curta demais.', null, true);
    }
    this.http = axios.create({
      baseURL: baseURL.replace(/\/+$/, ''),
      timeout: TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/json',
      },
      // Deixa o próprio código decidir o que é erro, para 429 e 5xx virarem retentativa em vez de
      // exceção do axios com a config (e a token) dentro.
      validateStatus: () => true,
    });
  }

  /** Auto-limitação: espaça as chamadas para nunca encostar nos 120/min do outro lado. */
  private async respeitarRitmo(): Promise<void> {
    const agora = Date.now();
    const espera = Math.max(0, this.proximaJanela - agora);
    this.proximaJanela = Math.max(agora, this.proximaJanela) + INTERVALO_MS;
    if (espera > 0) await esperar(espera);
  }

  private async get<T>(caminho: string, params: Record<string, any> = {}): Promise<T> {
    let ultimoErro: ErroRedRock | null = null;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      await this.respeitarRitmo();

      let resp: AxiosResponse<any>;
      try {
        resp = await this.http.get(caminho, { params });
      } catch (err: any) {
        // Rede, DNS, timeout. Nunca repassa o erro original: ele carrega a config com o header.
        ultimoErro = new ErroRedRock(
          limparSegredo(
            `Não foi possível falar com a Red Rock (${err?.code || 'falha de rede'}).`,
            this.token
          ),
          null,
          false
        );
        if (tentativa < MAX_TENTATIVAS) { await esperar(1000 * 2 ** (tentativa - 1)); continue; }
        throw ultimoErro;
      }

      if (resp.status >= 200 && resp.status < 300) return resp.data as T;

      const { msg, permanente } = descreverStatus(resp.status, resp.data);
      ultimoErro = new ErroRedRock(limparSegredo(msg, this.token), resp.status, permanente);
      if (permanente || tentativa === MAX_TENTATIVAS) throw ultimoErro;

      // Retry-After vem em segundos no 429. Teto de 30s para a requisição do painel não ficar
      // pendurada: melhor a tela dizer "tente de novo" do que o navegador esperar dois minutos.
      const retryAfter = parseInt(String(resp.headers?.['retry-after'] ?? ''), 10);
      const espera = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, 30_000)
        : 1000 * 2 ** (tentativa - 1);
      logger.warn(CTX, `${resp.status} em ${caminho}; nova tentativa em ${espera}ms`);
      await esperar(espera);
    }

    throw ultimoErro ?? new ErroRedRock('Falha desconhecida ao consultar a Red Rock.', null, false);
  }

  /** Confere de quem é a token. Usado no "testar conexão" e antes de gravar a credencial. */
  async identidade(): Promise<RRIdentidade> {
    const r = await this.get<{ data?: any }>('/me');
    const d = r?.data ?? {};
    return {
      empresa_id: d.company?.id ?? null,
      empresa_nome: d.company?.name ?? null,
      usuario_nome: d.user?.name ?? null,
      usuario_email: d.user?.email ?? null,
    };
  }

  /**
   * Pedidos com o custo apurado, no período.
   *
   * `invoiced: 'all'` de propósito. O default da API é 'yes', que devolveria só o que já foi
   * cobrado — e aí o pedido recente, que é exatamente o que a previsão precisa enxergar, ficaria
   * de fora sem nenhum sinal de que ficou.
   */
  async pedidos(
    de: string,
    ate: string,
    onPagina?: (pagina: number, itens: number) => void
  ): Promise<{ pedidos: RROrderCost[]; paginas: number; truncado: boolean }> {
    const pedidos: RROrderCost[] = [];
    let pagina = 1;
    let truncado = false;

    for (;;) {
      const r = await this.get<{ data?: RROrderCost[]; meta?: any }>('/orders', {
        from: de, to: ate, invoiced: 'all', per_page: 100, page: pagina,
        sort: 'order_created_at', dir: 'asc',
      });
      const lote = Array.isArray(r?.data) ? r.data : [];
      pedidos.push(...lote);
      onPagina?.(pagina, lote.length);

      const temMais = r?.meta?.has_more === true;
      // Página vazia com has_more=true é o cenário de laço infinito. Parar aqui é o certo mesmo
      // que a API insista que tem mais: sem itens não há progresso possível.
      if (!temMais || lote.length === 0) break;
      if (pagina >= MAX_PAGINAS) { truncado = true; break; }
      pagina++;
    }

    return { pedidos, paginas: pagina, truncado };
  }

  /** Faturas do período. Aqui a paginação é a clássica, com total em meta. */
  async faturas(de?: string, ate?: string): Promise<{ faturas: RRInvoice[]; paginas: number; truncado: boolean }> {
    const faturas: RRInvoice[] = [];
    let pagina = 1;
    let truncado = false;

    for (;;) {
      const params: Record<string, any> = { per_page: 100, page: pagina };
      if (de) params.from = de;
      if (ate) params.to = ate;
      const r = await this.get<{ data?: RRInvoice[]; meta?: any }>('/invoices', params);
      const lote = Array.isArray(r?.data) ? r.data : [];
      faturas.push(...lote);

      const ultima = Number(r?.meta?.last_page);
      if (lote.length === 0) break;
      if (Number.isFinite(ultima) && pagina >= ultima) break;
      if (!Number.isFinite(ultima) && lote.length < 100) break;
      if (pagina >= MAX_PAGINAS) { truncado = true; break; }
      pagina++;
    }

    return { faturas, paginas: pagina, truncado };
  }

  /**
   * Frete agregado por país.
   *
   * A janela máxima aceita é de um ano e o default é 90 dias. Passar as duas datas sempre, mesmo
   * quando são as do default, evita descobrir depois que o número na tela era de uma janela
   * diferente da que a tela dizia.
   */
  async entregas(de: string, ate: string): Promise<RREntregas> {
    const r = await this.get<{ data?: any }>('/deliveries', { from: de, to: ate });
    const d = r?.data ?? {};
    return {
      date_from: d.date_from ?? null,
      date_to: d.date_to ?? null,
      total_shipping_cost: d.total_shipping_cost ?? null,
      total_charge_lines: d.total_charge_lines ?? null,
      total_orders: d.total_orders ?? null,
      avg_shipping_per_order: d.avg_shipping_per_order ?? null,
      countries: Array.isArray(d.countries) ? d.countries : [],
    };
  }
}
