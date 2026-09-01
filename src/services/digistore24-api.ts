import axios from 'axios';
import { logger } from '../utils/logger';

const CTX = 'DS24API';
const BASE = 'https://www.digistore24.com/api/call';

/**
 * Cliente da API REST da Digistore24 — coisa diferente do IPN (que vive em digistore24.ts).
 * O IPN é a Digistore falando com a gente; esta API é a gente perguntando pra ela.
 *
 * Por que existe: em 03/08/2026 21:34 o banco caiu, os webhooks passaram a devolver erro e a
 * Digistore DESATIVOU as duas conexões de IPN sozinha ("MailX - Payment" e "MailX - Refund").
 * Ficaram 4 dias sem gravar — 1.023 pagamentos e 384 reembolsos.
 *
 * O painel exporta CSV, mas o CSV NÃO traz UTM: a coluna "Tracking key" vem vazia em 100% das
 * 34.696 linhas do arquivo inteiro. Sem utm_campaign não se sabe de qual mensagem de automação a
 * venda veio, e é justamente isso que alimenta desempenho por mensagem e conversão por segmento.
 * A API é a única chance de recuperar essa parte, porque os parâmetros custom ficam guardados no
 * pedido — o CSV só não os exporta.
 *
 * A chave NÃO fica no repositório: vem de DS24_API_KEY no .env do servidor.
 */

export function ds24KeyConfigurada(): boolean {
  return !!(process.env.DS24_API_KEY || '').trim();
}

export interface DS24Resposta {
  http: number;
  ok: boolean;
  data: any;
  erro?: string;
}

/**
 * Chama uma função da API. `pathArg` é o argumento posicional que algumas funções recebem na
 * própria URL (ex: getPurchase/<id>); `params` vai na query string.
 *
 * Nunca lança por status HTTP — devolve código e corpo crus, porque a sonda precisa DISTINGUIR
 * "função não existe" (404) de "chave sem permissão" (401/403) de "existe e respondeu". Lançar
 * exceção apagaria exatamente a informação que a sonda foi buscar.
 */
export async function ds24Call(
  fn: string,
  params: Record<string, any> = {},
  pathArg?: string
): Promise<DS24Resposta> {
  const key = (process.env.DS24_API_KEY || '').trim();
  if (!key) {
    return { http: 0, ok: false, data: null, erro: 'DS24_API_KEY não configurada no .env do servidor' };
  }

  const url = pathArg ? `${BASE}/${fn}/${encodeURIComponent(pathArg)}` : `${BASE}/${fn}`;

  try {
    const r = await axios.get(url, {
      headers: { 'X-DS-API-KEY': key, Accept: 'application/json' },
      params,
      timeout: 30_000,
      validateStatus: () => true,
    } as any);

    // A Digistore devolve HTTP 200 com {result:"error"} em erro de aplicação — então 200 não é
    // prova de sucesso e a sonda tem que olhar o result do corpo também.
    const resultado = r.data?.result;
    return {
      http: r.status,
      ok: r.status >= 200 && r.status < 300 && resultado !== 'error',
      data: r.data,
      erro: resultado === 'error' ? String(r.data?.message ?? 'erro sem mensagem') : undefined,
    };
  } catch (err: any) {
    logger.warn(CTX, `Falha chamando ${fn}: ${err.message}`);
    return { http: err.response?.status ?? 0, ok: false, data: err.response?.data ?? null, erro: err.message };
  }
}

/** Onde o utm_campaign moraria, se existir. */
export const PADRAO_CHAVE_INTERESSANTE = /utm|tracking|custom|campaign|source|medium|sub_?id|tid/i;

/** Campo existe mas não carrega nada: string vazia, null, undefined, array/objeto vazio. */
export function valorVazio(v: any): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/**
 * Varre um objeto (até `profundidade` níveis) e devolve caminho→valor de tudo que casa com o
 * padrão acima. Sem isso a sonda obrigaria a ler no olho um JSON de dezenas de campos — e foi
 * assim que uma sonda anterior deu falso negativo: procurou um campo pelo nome que eu imaginei
 * (short_url) em vez de listar os nomes existentes. O dado estava lá, chamado _link_ids.
 *
 * `apenasComValor` separa as duas perguntas que a primeira versão desta sonda misturou:
 * "o campo EXISTE?" e "o campo TEM CONTEÚDO?". Ela respondeu a primeira e reportou como se fosse
 * a segunda — declarou "SIM, achei atribuição" com campaignkey, custom e tracking_param todos "".
 * Nome de campo não é dado; só valor é.
 */
export function acharChavesInteressantes(
  obj: any,
  profundidade = 4,
  prefixo = '',
  apenasComValor = false
): Record<string, any> {
  const achado: Record<string, any> = {};
  if (!obj || typeof obj !== 'object' || profundidade < 0) return achado;

  for (const [k, v] of Object.entries(obj)) {
    const caminho = prefixo ? `${prefixo}.${k}` : k;
    if (PADRAO_CHAVE_INTERESSANTE.test(k) && !(apenasComValor && valorVazio(v))) {
      achado[caminho] = v && typeof v === 'object' ? v : (v ?? null);
    }
    if (v && typeof v === 'object') {
      Object.assign(achado, acharChavesInteressantes(v, profundidade - 1, caminho, apenasComValor));
    }
  }
  return achado;
}
