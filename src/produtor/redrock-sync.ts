/**
 * Sincronização com a Red Rock: traz o custo real para dentro do banco.
 *
 * Antes disto, "custo real" era um PDF por semana e um campo digitado à mão. Depois disto, é o
 * custo por PEDIDO, com a quebra que o fornecedor usa para cobrar. A previsão continua existindo
 * — ela é o que responde antes de a cobrança sair — mas deixa de ser a única coisa que existe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Regras que sustentam o resto:
 *
 * 1. Sincronizar é idempotente. Rodar de novo o mesmo período reescreve as mesmas linhas, não
 *    empilha. Vale para pedido, para linha de cobrança e para fatura. Sem isso, "puxar de novo por
 *    garantia" — que é o que qualquer pessoa faz quando desconfia de um número — dobraria o custo.
 *
 * 2. Nada aqui apaga o que uma PESSOA lançou. Fatura com origem 'manual' nunca é sobrescrita pela
 *    API. Quando as duas discordam, as duas ficam e a tela mostra a diferença. Eleger a automática
 *    seria descartar a única versão que alguém conferiu olhando o papel.
 *
 * 3. Pedido não faturado entra com custo NULL, não com zero. Ele existe, ainda não foi cobrado, e
 *    é justamente ele que explica a diferença entre o que vendeu na semana e o que a fatura da
 *    semana traz. Zero ali entraria em média como pedido de graça e puxaria o custo médio para
 *    baixo sozinho, todo fim de período.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { query, queryOne } from '../db/database';
import { logger } from '../utils/logger';
import {
  ErroRedRock, RedRockClient, RRChargeLine, RREntregas, RRInvoice, RROrderCost, limparSegredo,
} from './redrock-api';

const CTX = 'RedRockSync';
export const PROVEDOR_REDROCK = 'redrock';
export const FORNECEDOR_REDROCK = 'Red Rock Labs';

// ─────────────────────────────────────────────────────────────────────────────
// Credencial
// ─────────────────────────────────────────────────────────────────────────────

export interface CredencialResumo {
  provedor: string;
  final: string;              // últimos 4 caracteres — só para conferência visual
  rotulo: string | null;
  referencia_externa: string | null;
  ultimo_ok: string | null;
  ultimo_erro: string | null;
  ultimo_erro_em: string | null;
  criada_em: string | null;
}

interface CredencialRow {
  token: string;
  rotulo: string | null;
  referencia_externa: string | null;
  ultimo_ok: Date | string | null;
  ultimo_erro: string | null;
  ultimo_erro_em: Date | string | null;
  created_at: Date | string | null;
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Coerção defensiva: a doc diz number, mas JSON de terceiro já veio como string antes. */
function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function dataSo(v: any): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function mascarar(token: string): string {
  const t = String(token ?? '');
  return t.length >= 4 ? t.slice(-4) : '';
}

export async function lerCredencial(clientId: number, provedor = PROVEDOR_REDROCK) {
  return queryOne<CredencialRow>(
    `SELECT token, rotulo, referencia_externa, ultimo_ok, ultimo_erro, ultimo_erro_em, created_at
       FROM produtor_credenciais WHERE client_id = $1 AND provedor = $2`,
    [clientId, provedor]
  );
}

export async function resumoCredencial(
  clientId: number, provedor = PROVEDOR_REDROCK
): Promise<CredencialResumo | null> {
  const r = await lerCredencial(clientId, provedor);
  if (!r) return null;
  return {
    provedor,
    final: mascarar(r.token),
    rotulo: r.rotulo,
    referencia_externa: r.referencia_externa,
    ultimo_ok: iso(r.ultimo_ok),
    ultimo_erro: r.ultimo_erro,
    ultimo_erro_em: iso(r.ultimo_erro_em),
    criada_em: iso(r.created_at),
  };
}

/**
 * Cadastra a token — depois de provar que ela funciona.
 *
 * A validação contra o /me antes de gravar é o que impede o modo de falha chato: token digitada
 * com um caractere a menos entra no banco, a sincronização falha de madrugada, e a tela mostra
 * dado velho até alguém reparar. Aqui a pessoa descobre na hora, com o nome da empresa na tela
 * para conferir que é a certa.
 */
export async function salvarCredencial(
  clientId: number, token: string, provedor = PROVEDOR_REDROCK
): Promise<CredencialResumo> {
  const cliente = new RedRockClient(token);
  const id = await cliente.identidade();

  await query(
    `INSERT INTO produtor_credenciais
       (client_id, provedor, token, rotulo, referencia_externa, ultimo_ok, ultimo_erro, ultimo_erro_em)
     VALUES ($1, $2, $3, $4, $5, NOW(), NULL, NULL)
     ON CONFLICT (client_id, provedor) DO UPDATE
       SET token = EXCLUDED.token,
           rotulo = EXCLUDED.rotulo,
           referencia_externa = EXCLUDED.referencia_externa,
           ultimo_ok = NOW(),
           ultimo_erro = NULL,
           ultimo_erro_em = NULL,
           updated_at = NOW()`,
    [clientId, provedor, token.trim(), id.empresa_nome, id.empresa_id]
  );

  logger.info(CTX, `Credencial ${provedor} cadastrada para cliente ${clientId} (${id.empresa_nome ?? 'sem nome'})`);
  return (await resumoCredencial(clientId, provedor))!;
}

export async function apagarCredencial(clientId: number, provedor = PROVEDOR_REDROCK): Promise<boolean> {
  const r = await query(
    `DELETE FROM produtor_credenciais WHERE client_id = $1 AND provedor = $2 RETURNING id`,
    [clientId, provedor]
  );
  return r.length > 0;
}

async function registrarFalhaDaCredencial(clientId: number, provedor: string, erro: string) {
  await query(
    `UPDATE produtor_credenciais SET ultimo_erro = $3, ultimo_erro_em = NOW(), updated_at = NOW()
      WHERE client_id = $1 AND provedor = $2`,
    [clientId, provedor, erro.slice(0, 500)]
  );
}

async function clienteDoBanco(clientId: number): Promise<RedRockClient> {
  const c = await lerCredencial(clientId);
  if (!c) {
    throw new ErroRedRock(
      'A token da Red Rock ainda não foi cadastrada para este cliente. Cadastre em Integrações.',
      null, true
    );
  }
  return new RedRockClient(c.token);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gravação
// ─────────────────────────────────────────────────────────────────────────────

/** Insere em lotes: uma instrução por lote, não uma por linha. */
function lotes<T>(itens: T[], tamanho: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) out.push(itens.slice(i, i + tamanho));
  return out;
}

async function gravarPedidos(clientId: number, pedidos: RROrderCost[]): Promise<number> {
  let gravados = 0;
  const COLUNAS = 14;

  for (const lote of lotes(pedidos, 200)) {
    const valores: any[] = [];
    const linhas: string[] = [];
    lote.forEach((p, i) => {
      const b = i * COLUNAS;
      linhas.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},` +
        `$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14})`
      );
      valores.push(
        clientId,
        p.order,
        p.order_number ?? null,
        p.customer_name ?? null,
        p.country_code ?? null,
        p.order_created_at ?? null,
        p.invoiced === true,
        p.awaiting_freight === true,
        num(p.total),
        num(p.totals?.product),
        num(p.totals?.fulfillment),
        num(p.totals?.shipping),
        num(p.totals?.packaging),
        num(p.totals?.other)
      );
    });

    const r = await query(
      `INSERT INTO produtor_redrock_pedidos
         (client_id, external_order_id, numero_pedido, cliente_nome, pais, criado_em,
          faturado, aguardando_frete, total, total_produto, total_fulfillment, total_frete,
          total_embalagem, total_outros)
       VALUES ${linhas.join(',')}
       ON CONFLICT (client_id, external_order_id) DO UPDATE SET
         numero_pedido = EXCLUDED.numero_pedido,
         cliente_nome = EXCLUDED.cliente_nome,
         pais = EXCLUDED.pais,
         criado_em = EXCLUDED.criado_em,
         faturado = EXCLUDED.faturado,
         aguardando_frete = EXCLUDED.aguardando_frete,
         total = EXCLUDED.total,
         total_produto = EXCLUDED.total_produto,
         total_fulfillment = EXCLUDED.total_fulfillment,
         total_frete = EXCLUDED.total_frete,
         total_embalagem = EXCLUDED.total_embalagem,
         total_outros = EXCLUDED.total_outros,
         sincronizado_em = NOW()
       RETURNING id`,
      valores
    );
    gravados += r.length;
  }

  // `invoice_numbers` é array e sai mais limpo numa instrução própria do que virando um
  // `$n::text[]` no meio de catorze posicionais repetidos por linha.
  for (const lote of lotes(pedidos, 500)) {
    await query(
      // NULLIF antes do string_to_array porque string_to_array('', '|') devolve {""} — um array
      // com uma string vazia dentro, que não é "sem fatura", é "uma fatura sem nome".
      `UPDATE produtor_redrock_pedidos p
          SET faturas = COALESCE(string_to_array(NULLIF(v.txt, ''), '|'), '{}')
         FROM (SELECT unnest($2::text[]) AS ext, unnest($3::text[]) AS txt) v
        WHERE p.client_id = $1 AND p.external_order_id = v.ext`,
      [
        clientId,
        lote.map(p => p.order),
        lote.map(p => (p.invoice_numbers ?? []).filter(Boolean).join('|')),
      ]
    );
  }

  return gravados;
}

/**
 * Grava as linhas de cobrança de cada pedido.
 *
 * Regravar precisa dar o mesmo resultado, e por isso a chave é a POSIÇÃO da linha dentro do
 * pedido: a API não dá id de linha, e casar por (data, atividade, valor) juntaria duas cobranças
 * legitimamente iguais numa só. Depois do upsert, corta o que sobrou de uma sincronização
 * anterior em que o pedido tinha mais linhas — nessa ordem, porque o estado intermediário passa a
 * ser "linha demais" e não "pedido sem custo nenhum".
 */
async function gravarCobrancas(clientId: number, pedidos: RROrderCost[]): Promise<number> {
  const linhas: Array<{ ext: string; i: number; c: RRChargeLine }> = [];
  for (const p of pedidos) {
    (p.charges ?? []).forEach((c, i) => linhas.push({ ext: p.order, i, c }));
  }
  if (linhas.length === 0) {
    // Pedido que perdeu todas as cobranças precisa ficar sem nenhuma, não com as antigas.
    await query(
      `DELETE FROM produtor_redrock_cobrancas
        WHERE client_id = $1 AND external_order_id = ANY($2::text[])`,
      [clientId, pedidos.map(p => p.order)]
    );
    return 0;
  }

  let gravadas = 0;
  const COLUNAS = 9;
  for (const lote of lotes(linhas, 300)) {
    const valores: any[] = [];
    const sql: string[] = [];
    lote.forEach((l, i) => {
      const b = i * COLUNAS;
      sql.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
      valores.push(
        clientId, l.ext, l.i,
        dataSo(l.c.date),
        l.c.activity ?? null,
        l.c.charge ?? null,
        l.c.description ?? null,
        num(l.c.quantity),
        num(l.c.amount)
      );
    });
    const r = await query(
      `INSERT INTO produtor_redrock_cobrancas
         (client_id, external_order_id, linha, data, atividade, cobranca, descricao, quantidade, valor)
       VALUES ${sql.join(',')}
       ON CONFLICT (client_id, external_order_id, linha) DO UPDATE SET
         data = EXCLUDED.data, atividade = EXCLUDED.atividade, cobranca = EXCLUDED.cobranca,
         descricao = EXCLUDED.descricao, quantidade = EXCLUDED.quantidade, valor = EXCLUDED.valor
       RETURNING id`,
      valores
    );
    gravadas += r.length;
  }

  // numero_fatura à parte, mesma razão do array de faturas: é o único campo que pode ser nulo em
  // metade das linhas e escrevê-lo junto encheria o lote de placeholders só para dizer NULL.
  for (const lote of lotes(linhas, 500)) {
    await query(
      `UPDATE produtor_redrock_cobrancas c
          SET numero_fatura = v.fatura
         FROM (SELECT unnest($2::text[]) AS ext, unnest($3::int[]) AS linha,
                      unnest($4::text[]) AS fatura) v
        WHERE c.client_id = $1 AND c.external_order_id = v.ext AND c.linha = v.linha`,
      [
        clientId,
        lote.map(l => l.ext),
        lote.map(l => l.i),
        lote.map(l => l.c.invoice_number ?? null),
      ]
    );
  }

  // Corta a sobra de uma sincronização anterior mais longa.
  const porPedido = new Map<string, number>();
  for (const p of pedidos) porPedido.set(p.order, (p.charges ?? []).length);
  await query(
    `DELETE FROM produtor_redrock_cobrancas c
      USING (SELECT unnest($2::text[]) AS ext, unnest($3::int[]) AS qtd) v
      WHERE c.client_id = $1 AND c.external_order_id = v.ext AND c.linha >= v.qtd`,
    [clientId, [...porPedido.keys()], [...porPedido.values()]]
  );

  return gravadas;
}

/**
 * Traz as faturas para produtor_faturas, sem encostar no que foi lançado à mão.
 *
 * A COMPETÊNCIA não vem no cabeçalho da fatura — lá só existe `invoiced_at`, que é quando ela foi
 * emitida. Período coberto e data de emissão são coisas diferentes, e usar uma pela outra foi
 * exatamente o erro que fez a tela dizer que a fatura veio abaixo do previsto quando ela tinha
 * vindo acima: comparava uma fatura de 01 a 22 contra a previsão do mês inteiro. Aqui a
 * competência sai do menor e do maior `date` das linhas daquela fatura, que é o intervalo que ela
 * de fato cobre.
 */
async function gravarFaturas(
  clientId: number, faturas: RRInvoice[]
): Promise<{ gravadas: number; conflitos: string[] }> {
  const conflitos: string[] = [];
  let gravadas = 0;

  for (const f of faturas) {
    const numero = (f.invoice_number ?? '').trim();
    if (!numero) continue;

    const periodo = await queryOne<{ inicio: string | null; fim: string | null }>(
      `SELECT MIN(data)::text AS inicio, MAX(data)::text AS fim
         FROM produtor_redrock_cobrancas
        WHERE client_id = $1 AND numero_fatura = $2 AND data IS NOT NULL`,
      [clientId, numero]
    );

    // Sem nenhuma linha de cobrança sincronizada, não dá para dizer o que a fatura cobre. Cair
    // para invoiced_at daria um período de um dia só, que casaria com a previsão de um dia e
    // mostraria uma diferença gigante inventada. Melhor pular e dizer por quê.
    if (!periodo?.inicio || !periodo?.fim) {
      conflitos.push(
        `Fatura ${numero}: nenhuma linha de cobrança dela foi encontrada no período sincronizado, ` +
        `então não dá para saber que intervalo ela cobre. Sincronize um período maior.`
      );
      continue;
    }

    const existente = await queryOne<{ id: number; origem: string; valor: string }>(
      `SELECT id, origem, valor FROM produtor_faturas
        WHERE client_id = $1 AND LOWER(fornecedor) = LOWER($2) AND numero = $3`,
      [clientId, FORNECEDOR_REDROCK, numero]
    );

    const valor = num(f.total);
    if (valor == null) {
      conflitos.push(`Fatura ${numero}: a Red Rock não devolveu o valor total. Não foi lançada.`);
      continue;
    }

    if (existente && existente.origem !== PROVEDOR_REDROCK) {
      const digitado = parseFloat(existente.valor);
      if (Number.isFinite(digitado) && Math.abs(digitado - valor) > 0.01) {
        conflitos.push(
          `Fatura ${numero}: lançada à mão como ${digitado.toFixed(2)} e a Red Rock diz ` +
          `${valor.toFixed(2)}. O lançamento manual foi mantido — confira qual está certo.`
        );
      }
      continue;
    }

    if (existente) {
      await query(
        `UPDATE produtor_faturas
            SET competencia_inicio = $2, competencia_fim = $3, emitida_em = $4,
                valor = $5, moeda = $6, origem_id = $7, updated_at = NOW()
          WHERE id = $1`,
        [existente.id, periodo.inicio, periodo.fim, dataSo(f.invoiced_at), valor,
         (f.currency || 'USD').slice(0, 3), f.id]
      );
    } else {
      await query(
        `INSERT INTO produtor_faturas
           (client_id, kit_id, fornecedor, numero, categoria, competencia_inicio, competencia_fim,
            emitida_em, valor, moeda, origem, origem_id, observacao)
         VALUES ($1, NULL, $2, $3, 'produto_frete', $4, $5, $6, $7, $8, $9, $10, $11)`,
        [clientId, FORNECEDOR_REDROCK, numero, periodo.inicio, periodo.fim,
         dataSo(f.invoiced_at), valor, (f.currency || 'USD').slice(0, 3), PROVEDOR_REDROCK, f.id,
         `Importada da Client Financial API. Situação de pagamento: ${f.payment_status}.`]
      );
    }
    gravadas++;
  }

  return { gravadas, conflitos };
}

async function gravarEntregas(
  clientId: number, de: string, ate: string, e: RREntregas
): Promise<number> {
  const linhas: Array<[string, number | null, number | null, number | null, number | null]> = [
    ['*', num(e.total_orders), num(e.total_charge_lines), num(e.total_shipping_cost),
      num(e.avg_shipping_per_order)],
  ];
  for (const p of e.countries) {
    const pais = (p.country_code ?? '').trim().toUpperCase();
    if (!pais) continue;
    linhas.push([
      pais.slice(0, 16), num(p.order_count), num(p.charge_line_count),
      num(p.total_shipping_cost), num(p.avg_shipping_per_order),
    ]);
  }

  // A janela gravada é a que a API DIZ ter usado, não a que foi pedida: ela recorta em 90 dias por
  // padrão e limita em um ano. Guardar a pedida faria a tela rotular como "últimos 12 meses" um
  // número que é de três.
  const inicio = dataSo(e.date_from) ?? de;
  const fim = dataSo(e.date_to) ?? ate;

  const valores: any[] = [];
  const sql: string[] = [];
  linhas.forEach((l, i) => {
    const b = i * 8;
    sql.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
    valores.push(clientId, l[0], inicio, fim, l[1], l[2], l[3], l[4]);
  });

  const r = await query(
    `INSERT INTO produtor_redrock_frete
       (client_id, pais, janela_inicio, janela_fim, pedidos, linhas_cobranca, frete_total, frete_medio_pedido)
     VALUES ${sql.join(',')}
     ON CONFLICT (client_id, pais, janela_inicio, janela_fim) DO UPDATE SET
       pedidos = EXCLUDED.pedidos, linhas_cobranca = EXCLUDED.linhas_cobranca,
       frete_total = EXCLUDED.frete_total, frete_medio_pedido = EXCLUDED.frete_medio_pedido,
       sincronizado_em = NOW()
     RETURNING id`,
    valores
  );
  return r.length;
}

async function anotarSync(
  clientId: number, recurso: string, de: string | null, ate: string | null,
  dados: { paginas?: number; registros?: number; gravados?: number; status: 'ok' | 'erro'; erro?: string; ms: number }
) {
  await query(
    `INSERT INTO produtor_redrock_sync
       (client_id, recurso, periodo_inicio, periodo_fim, paginas, registros, gravados, status, erro, duracao_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [clientId, recurso, de, ate, dados.paginas ?? 0, dados.registros ?? 0, dados.gravados ?? 0,
     dados.status, dados.erro ? dados.erro.slice(0, 1000) : null, Math.round(dados.ms)]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sincronização
// ─────────────────────────────────────────────────────────────────────────────

export interface ResultadoSync {
  periodo: { inicio: string; fim: string };
  pedidos: { lidos: number; gravados: number; paginas: number; truncado: boolean };
  cobrancas: { gravadas: number };
  faturas: { lidas: number; gravadas: number };
  entregas: { paises: number; janela: { inicio: string | null; fim: string | null } };
  avisos: string[];
}

/**
 * Puxa pedidos, faturas e frete de um período.
 *
 * A ordem importa: as linhas de cobrança precisam estar gravadas ANTES das faturas, porque é
 * delas que sai a competência de cada fatura.
 *
 * Cada recurso é anotado separado em produtor_redrock_sync, inclusive quando falha. Uma falha em
 * entregas não desfaz os pedidos que já entraram — o dado parcial é melhor que nenhum, desde que
 * a tela saiba dizer o que ficou faltando, e é para isso que o aviso volta na resposta.
 */
export async function sincronizar(
  clientId: number, de: string, ate: string
): Promise<ResultadoSync> {
  const cliente = await clienteDoBanco(clientId);
  const avisos: string[] = [];

  const r: ResultadoSync = {
    periodo: { inicio: de, fim: ate },
    pedidos: { lidos: 0, gravados: 0, paginas: 0, truncado: false },
    cobrancas: { gravadas: 0 },
    faturas: { lidas: 0, gravadas: 0 },
    entregas: { paises: 0, janela: { inicio: null, fim: null } },
    avisos,
  };

  // ── Pedidos + cobranças ──────────────────────────────────────────────────
  let t0 = Date.now();
  try {
    const { pedidos, paginas, truncado } = await cliente.pedidos(de, ate);
    r.pedidos.lidos = pedidos.length;
    r.pedidos.paginas = paginas;
    r.pedidos.truncado = truncado;
    if (truncado) {
      avisos.push(
        `A Red Rock ainda tinha mais páginas de pedidos depois da ${paginas}ª e a leitura parou ` +
        `aí, por segurança. Sincronize em pedaços menores (por mês, por exemplo) para não ficar ` +
        `com o período incompleto.`
      );
    }
    if (pedidos.length > 0) {
      for (const lote of lotes(pedidos, 500)) {
        r.pedidos.gravados += await gravarPedidos(clientId, lote);
        r.cobrancas.gravadas += await gravarCobrancas(clientId, lote);
      }
    }
    await anotarSync(clientId, 'pedidos', de, ate, {
      paginas, registros: pedidos.length, gravados: r.pedidos.gravados, status: 'ok', ms: Date.now() - t0,
    });
  } catch (err: any) {
    const msg = limparSegredo(err?.message || 'Falha ao ler pedidos.');
    await anotarSync(clientId, 'pedidos', de, ate, { status: 'erro', erro: msg, ms: Date.now() - t0 });
    if (err instanceof ErroRedRock && err.permanente) {
      await registrarFalhaDaCredencial(clientId, PROVEDOR_REDROCK, msg);
    }
    throw err;
  }

  // ── Faturas ──────────────────────────────────────────────────────────────
  t0 = Date.now();
  try {
    const { faturas, truncado } = await cliente.faturas(de, ate);
    r.faturas.lidas = faturas.length;
    if (truncado) avisos.push('A lista de faturas foi cortada no teto de páginas — o período pode estar incompleto.');
    const g = await gravarFaturas(clientId, faturas);
    r.faturas.gravadas = g.gravadas;
    avisos.push(...g.conflitos);
    await anotarSync(clientId, 'faturas', de, ate, {
      registros: faturas.length, gravados: g.gravadas, status: 'ok', ms: Date.now() - t0,
    });
  } catch (err: any) {
    const msg = limparSegredo(err?.message || 'Falha ao ler faturas.');
    await anotarSync(clientId, 'faturas', de, ate, { status: 'erro', erro: msg, ms: Date.now() - t0 });
    avisos.push(`Os pedidos entraram, mas as faturas não: ${msg}`);
  }

  // ── Frete por país ───────────────────────────────────────────────────────
  t0 = Date.now();
  try {
    const e = await cliente.entregas(de, ate);
    const n = await gravarEntregas(clientId, de, ate, e);
    r.entregas.paises = Math.max(0, n - 1); // a linha '*' é o agregado, não é país
    r.entregas.janela = { inicio: dataSo(e.date_from) ?? de, fim: dataSo(e.date_to) ?? ate };
    if (r.entregas.janela.inicio !== de || r.entregas.janela.fim !== ate) {
      avisos.push(
        `O frete por país veio da janela ${r.entregas.janela.inicio} a ${r.entregas.janela.fim}, ` +
        `que não é exatamente a pedida (${de} a ${ate}): a Red Rock recorta essa consulta em no ` +
        `máximo um ano.`
      );
    }
    await anotarSync(clientId, 'entregas', de, ate, { registros: n, gravados: n, status: 'ok', ms: Date.now() - t0 });
  } catch (err: any) {
    const msg = limparSegredo(err?.message || 'Falha ao ler entregas.');
    await anotarSync(clientId, 'entregas', de, ate, { status: 'erro', erro: msg, ms: Date.now() - t0 });
    avisos.push(`O frete por país não foi atualizado: ${msg}`);
  }

  await query(
    `UPDATE produtor_credenciais SET ultimo_ok = NOW(), ultimo_erro = NULL, ultimo_erro_em = NULL,
            updated_at = NOW()
      WHERE client_id = $1 AND provedor = $2`,
    [clientId, PROVEDOR_REDROCK]
  );

  logger.info(CTX, `Cliente ${clientId}: ${r.pedidos.gravados} pedidos, ${r.cobrancas.gravadas} cobranças, ${r.faturas.gravadas} faturas`);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura para a tela
// ─────────────────────────────────────────────────────────────────────────────

export interface CustoRealPeriodo {
  periodo: { inicio: string; fim: string };
  pedidos_total: number;
  pedidos_faturados: number;
  pedidos_sem_fatura: number;
  pedidos_aguardando_frete: number;
  custo_total: number | null;
  custo_produto: number | null;
  custo_fulfillment: number | null;
  custo_frete: number | null;
  custo_embalagem: number | null;
  custo_outros: number | null;
  custo_medio_pedido: number | null;
  /** Quando foi a última sincronização bem-sucedida de pedidos. Null = nunca sincronizou. */
  atualizado_em: string | null;
  ultima_falha: { em: string; erro: string } | null;
}

/**
 * Custo real do período, direto do que a Red Rock cobrou.
 *
 * As médias saem SÓ dos pedidos faturados. Somar o pedido ainda não cobrado como zero, ou dividir
 * o custo dos faturados pelo total de pedidos, dá dois números diferentes e igualmente errados —
 * e o erro cresce perto do fim do período, justamente quando alguém está olhando para decidir
 * alguma coisa. Por isso os dois contadores voltam separados: quem lê vê quanto do período já foi
 * cobrado antes de olhar para a média.
 */
export async function custoReal(
  clientId: number, de: string, ate: string
): Promise<CustoRealPeriodo> {
  const t = await queryOne<any>(
    `SELECT
       COUNT(*)::int                                              AS total,
       COUNT(*) FILTER (WHERE faturado)::int                      AS faturados,
       COUNT(*) FILTER (WHERE NOT faturado)::int                  AS sem_fatura,
       COUNT(*) FILTER (WHERE aguardando_frete)::int              AS aguardando,
       SUM(total)             FILTER (WHERE faturado)             AS custo,
       SUM(total_produto)     FILTER (WHERE faturado)             AS produto,
       SUM(total_fulfillment) FILTER (WHERE faturado)             AS fulfillment,
       SUM(total_frete)       FILTER (WHERE faturado)             AS frete,
       SUM(total_embalagem)   FILTER (WHERE faturado)             AS embalagem,
       SUM(total_outros)      FILTER (WHERE faturado)             AS outros,
       AVG(total)             FILTER (WHERE faturado)             AS medio
     FROM produtor_redrock_pedidos
      WHERE client_id = $1 AND criado_em >= $2::date AND criado_em < ($3::date + 1)`,
    [clientId, de, ate]
  );

  const ok = await queryOne<{ created_at: Date | string }>(
    `SELECT created_at FROM produtor_redrock_sync
      WHERE client_id = $1 AND recurso = 'pedidos' AND status = 'ok'
      ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  );
  const falha = await queryOne<{ created_at: Date | string; erro: string }>(
    `SELECT created_at, erro FROM produtor_redrock_sync
      WHERE client_id = $1 AND status = 'erro'
      ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  );

  return {
    periodo: { inicio: de, fim: ate },
    pedidos_total: t?.total ?? 0,
    pedidos_faturados: t?.faturados ?? 0,
    pedidos_sem_fatura: t?.sem_fatura ?? 0,
    pedidos_aguardando_frete: t?.aguardando ?? 0,
    custo_total: num(t?.custo),
    custo_produto: num(t?.produto),
    custo_fulfillment: num(t?.fulfillment),
    custo_frete: num(t?.frete),
    custo_embalagem: num(t?.embalagem),
    custo_outros: num(t?.outros),
    custo_medio_pedido: num(t?.medio),
    atualizado_em: ok ? iso(ok.created_at) : null,
    ultima_falha: falha && (!ok || new Date(falha.created_at) > new Date(ok.created_at))
      ? { em: iso(falha.created_at)!, erro: falha.erro }
      : null,
  };
}

export interface FreteMedido {
  janela: { inicio: string; fim: string } | null;
  geral: { pedidos: number | null; frete_total: number | null; medio: number | null } | null;
  paises: Array<{ pais: string; pedidos: number | null; frete_total: number | null; medio: number | null }>;
  /** Sugestão de faixa para produtor_fulfillment, a partir do medido. */
  sugestao: { min: number; tipico: number; max: number } | null;
}

/**
 * Frete medido pelo fornecedor, e a faixa que ele sugere.
 *
 * A faixa cadastrada hoje ($0,86 a $17,12) saiu de 12 faturas em que o frete era um total semanal
 * dividido por um número de pedidos que não era o mesmo número de pedidos — dava ~17% de erro e
 * não dava para saber de que pedaço vinha. Aqui o número vem por país, de quem cobra.
 *
 * A sugestão NÃO é aplicada sozinha. Ela aparece ao lado do que está cadastrado, com um botão. O
 * valor cadastrado é uma decisão de alguém; trocar por outro em silêncio faria a previsão mudar
 * sem nenhum evento que explicasse a mudança.
 */
export async function fretePorPais(clientId: number): Promise<FreteMedido> {
  const janela = await queryOne<{ janela_inicio: string; janela_fim: string }>(
    `SELECT janela_inicio::text, janela_fim::text FROM produtor_redrock_frete
      WHERE client_id = $1 ORDER BY janela_fim DESC, janela_inicio DESC LIMIT 1`,
    [clientId]
  );
  if (!janela) return { janela: null, geral: null, paises: [], sugestao: null };

  const linhas = await query<any>(
    `SELECT pais, pedidos, frete_total, frete_medio_pedido
       FROM produtor_redrock_frete
      WHERE client_id = $1 AND janela_inicio = $2::date AND janela_fim = $3::date
      ORDER BY (pais = '*') DESC, frete_total DESC NULLS LAST`,
    [clientId, janela.janela_inicio, janela.janela_fim]
  );

  const geralRow = linhas.find(l => l.pais === '*');
  const paises = linhas
    .filter(l => l.pais !== '*')
    .map(l => ({
      pais: l.pais,
      pedidos: l.pedidos ?? null,
      frete_total: num(l.frete_total),
      medio: num(l.frete_medio_pedido),
    }));

  // A faixa sai dos países que têm volume suficiente para a média significar alguma coisa. Um país
  // com dois pedidos produz média legítima e inútil: ela viraria o mínimo ou o máximo da faixa
  // inteira por acaso.
  const comVolume = paises.filter(p => (p.pedidos ?? 0) >= 10 && p.medio != null);
  const medios = comVolume.map(p => p.medio!) as number[];
  const tipico = num(geralRow?.frete_medio_pedido);

  const sugestao = medios.length >= 2 && tipico != null
    ? { min: Math.min(...medios), tipico, max: Math.max(...medios) }
    : tipico != null
      ? { min: tipico, tipico, max: tipico }
      : null;

  return {
    janela: { inicio: janela.janela_inicio, fim: janela.janela_fim },
    geral: geralRow
      ? { pedidos: geralRow.pedidos ?? null, frete_total: num(geralRow.frete_total), medio: tipico }
      : null,
    paises,
    sugestao,
  };
}

/** Histórico recente de sincronizações, para a tela poder dizer de quando é o número. */
export async function historicoSync(clientId: number, limite = 10) {
  return query<any>(
    `SELECT recurso, periodo_inicio::text, periodo_fim::text, paginas, registros, gravados,
            status, erro, duracao_ms, created_at
       FROM produtor_redrock_sync WHERE client_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [clientId, Math.min(50, Math.max(1, limite))]
  );
}
