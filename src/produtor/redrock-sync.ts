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

export async function lerCredencial(contaId: number, provedor = PROVEDOR_REDROCK) {
  return queryOne<CredencialRow>(
    `SELECT token, rotulo, referencia_externa, ultimo_ok, ultimo_erro, ultimo_erro_em, created_at
       FROM produtor_credenciais WHERE conta_id = $1 AND provedor = $2`,
    [contaId, provedor]
  );
}

export async function resumoCredencial(
  contaId: number, provedor = PROVEDOR_REDROCK
): Promise<CredencialResumo | null> {
  const r = await lerCredencial(contaId, provedor);
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
  contaId: number, token: string, provedor = PROVEDOR_REDROCK
): Promise<CredencialResumo> {
  const cliente = new RedRockClient(token);
  const id = await cliente.identidade();

  await query(
    `INSERT INTO produtor_credenciais
       (conta_id, provedor, token, rotulo, referencia_externa, ultimo_ok, ultimo_erro, ultimo_erro_em)
     VALUES ($1, $2, $3, $4, $5, NOW(), NULL, NULL)
     ON CONFLICT (conta_id, provedor) DO UPDATE
       SET token = EXCLUDED.token,
           rotulo = EXCLUDED.rotulo,
           referencia_externa = EXCLUDED.referencia_externa,
           ultimo_ok = NOW(),
           ultimo_erro = NULL,
           ultimo_erro_em = NULL,
           updated_at = NOW()`,
    [contaId, provedor, token.trim(), id.empresa_nome, id.empresa_id]
  );

  logger.info(CTX, `Credencial ${provedor} cadastrada para a conta ${contaId} (${id.empresa_nome ?? 'sem nome'})`);
  return (await resumoCredencial(contaId, provedor))!;
}

export async function apagarCredencial(contaId: number, provedor = PROVEDOR_REDROCK): Promise<boolean> {
  const r = await query(
    `DELETE FROM produtor_credenciais WHERE conta_id = $1 AND provedor = $2 RETURNING id`,
    [contaId, provedor]
  );
  return r.length > 0;
}

async function registrarFalhaDaCredencial(contaId: number, provedor: string, erro: string) {
  await query(
    `UPDATE produtor_credenciais SET ultimo_erro = $3, ultimo_erro_em = NOW(), updated_at = NOW()
      WHERE conta_id = $1 AND provedor = $2`,
    [contaId, provedor, erro.slice(0, 500)]
  );
}

async function clienteDoBanco(contaId: number): Promise<RedRockClient> {
  const c = await lerCredencial(contaId);
  if (!c) {
    throw new ErroRedRock(
      'A token da Red Rock ainda não foi cadastrada para esta conta. Cadastre em Integrações.',
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

async function gravarPedidos(contaId: number, pedidos: RROrderCost[]): Promise<number> {
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
        contaId,
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
         (conta_id, external_order_id, numero_pedido, cliente_nome, pais, criado_em,
          faturado, aguardando_frete, total, total_produto, total_fulfillment, total_frete,
          total_embalagem, total_outros)
       VALUES ${linhas.join(',')}
       ON CONFLICT (conta_id, external_order_id) DO UPDATE SET
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
        WHERE p.conta_id = $1 AND p.external_order_id = v.ext`,
      [
        contaId,
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
async function gravarCobrancas(contaId: number, pedidos: RROrderCost[]): Promise<number> {
  const linhas: Array<{ ext: string; i: number; c: RRChargeLine }> = [];
  for (const p of pedidos) {
    (p.charges ?? []).forEach((c, i) => linhas.push({ ext: p.order, i, c }));
  }
  if (linhas.length === 0) {
    // Pedido que perdeu todas as cobranças precisa ficar sem nenhuma, não com as antigas.
    await query(
      `DELETE FROM produtor_redrock_cobrancas
        WHERE conta_id = $1 AND external_order_id = ANY($2::text[])`,
      [contaId, pedidos.map(p => p.order)]
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
        contaId, l.ext, l.i,
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
         (conta_id, external_order_id, linha, data, atividade, cobranca, descricao, quantidade, valor)
       VALUES ${sql.join(',')}
       ON CONFLICT (conta_id, external_order_id, linha) DO UPDATE SET
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
        WHERE c.conta_id = $1 AND c.external_order_id = v.ext AND c.linha = v.linha`,
      [
        contaId,
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
      WHERE c.conta_id = $1 AND c.external_order_id = v.ext AND c.linha >= v.qtd`,
    [contaId, [...porPedido.keys()], [...porPedido.values()]]
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
  contaId: number, faturas: RRInvoice[]
): Promise<{ gravadas: number; conflitos: string[] }> {
  const conflitos: string[] = [];
  let gravadas = 0;

  for (const f of faturas) {
    const numero = (f.invoice_number ?? '').trim();
    if (!numero) continue;

    const periodo = await queryOne<{ inicio: string | null; fim: string | null }>(
      `SELECT MIN(data)::text AS inicio, MAX(data)::text AS fim
         FROM produtor_redrock_cobrancas
        WHERE conta_id = $1 AND numero_fatura = $2 AND data IS NOT NULL`,
      [contaId, numero]
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
        WHERE conta_id = $1 AND LOWER(fornecedor) = LOWER($2) AND numero = $3`,
      [contaId, FORNECEDOR_REDROCK, numero]
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
           (conta_id, produto_id, fornecedor, numero, categoria, competencia_inicio, competencia_fim,
            emitida_em, valor, moeda, origem, origem_id, observacao)
         VALUES ($1, NULL, $2, $3, 'produto_frete', $4, $5, $6, $7, $8, $9, $10, $11)`,
        [contaId, FORNECEDOR_REDROCK, numero, periodo.inicio, periodo.fim,
         dataSo(f.invoiced_at), valor, (f.currency || 'USD').slice(0, 3), PROVEDOR_REDROCK, f.id,
         `Importada da Client Financial API. Situação de pagamento: ${f.payment_status}.`]
      );
    }
    gravadas++;
  }

  return { gravadas, conflitos };
}

async function gravarEntregas(
  contaId: number, de: string, ate: string, e: RREntregas
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

  // As duas janelas são guardadas separadas, e a apurada fica NULL quando a API não informa.
  //
  // Antes havia um `?? de` aqui, e ele fazia um estrago silencioso: "a Red Rock não disse a
  // janela" virava "a Red Rock confirmou a janela que pedi". A tela então imprimia "apurada pela
  // Red Rock" sobre um intervalo que ela nunca afirmou, e a comparação que deveria detectar a
  // divergência passava a comparar `de` com `de` — o aviso nunca disparava.
  const inicio = dataSo(e.date_from);
  const fim = dataSo(e.date_to);

  const valores: any[] = [];
  const sql: string[] = [];
  linhas.forEach((l, i) => {
    const b = i * 10;
    sql.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`);
    valores.push(contaId, l[0], inicio, fim, de, ate, l[1], l[2], l[3], l[4]);
  });

  const r = await query(
    `INSERT INTO produtor_redrock_frete
       (conta_id, pais, janela_inicio, janela_fim, pedido_inicio, pedido_fim,
        pedidos, linhas_cobranca, frete_total, frete_medio_pedido)
     VALUES ${sql.join(',')}
     ON CONFLICT (conta_id, pais,
                  COALESCE(janela_inicio, DATE '0001-01-01'),
                  COALESCE(janela_fim, DATE '0001-01-01')) DO UPDATE SET
       pedido_inicio = EXCLUDED.pedido_inicio, pedido_fim = EXCLUDED.pedido_fim,
       pedidos = EXCLUDED.pedidos, linhas_cobranca = EXCLUDED.linhas_cobranca,
       frete_total = EXCLUDED.frete_total, frete_medio_pedido = EXCLUDED.frete_medio_pedido,
       sincronizado_em = NOW()
     RETURNING id`,
    valores
  );
  return r.length;
}

async function anotarSync(
  contaId: number, recurso: string, de: string | null, ate: string | null,
  dados: { paginas?: number; registros?: number; gravados?: number; status: 'ok' | 'erro'; erro?: string; ms: number }
) {
  await query(
    `INSERT INTO produtor_redrock_sync
       (conta_id, recurso, periodo_inicio, periodo_fim, paginas, registros, gravados, status, erro, duracao_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [contaId, recurso, de, ate, dados.paginas ?? 0, dados.registros ?? 0, dados.gravados ?? 0,
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
  contaId: number, de: string, ate: string
): Promise<ResultadoSync> {
  const cliente = await clienteDoBanco(contaId);
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
        r.pedidos.gravados += await gravarPedidos(contaId, lote);
        r.cobrancas.gravadas += await gravarCobrancas(contaId, lote);
      }
    }
    await anotarSync(contaId, 'pedidos', de, ate, {
      paginas, registros: pedidos.length, gravados: r.pedidos.gravados, status: 'ok', ms: Date.now() - t0,
    });
  } catch (err: any) {
    const msg = limparSegredo(err?.message || 'Falha ao ler pedidos.');
    await anotarSync(contaId, 'pedidos', de, ate, { status: 'erro', erro: msg, ms: Date.now() - t0 });
    if (err instanceof ErroRedRock && err.permanente) {
      await registrarFalhaDaCredencial(contaId, PROVEDOR_REDROCK, msg);
    }
    throw err;
  }

  // ── Faturas ──────────────────────────────────────────────────────────────
  t0 = Date.now();
  try {
    const { faturas, truncado } = await cliente.faturas(de, ate);
    r.faturas.lidas = faturas.length;
    if (truncado) avisos.push('A lista de faturas foi cortada no teto de páginas — o período pode estar incompleto.');
    const g = await gravarFaturas(contaId, faturas);
    r.faturas.gravadas = g.gravadas;
    avisos.push(...g.conflitos);
    await anotarSync(contaId, 'faturas', de, ate, {
      registros: faturas.length, gravados: g.gravadas, status: 'ok', ms: Date.now() - t0,
    });
  } catch (err: any) {
    const msg = limparSegredo(err?.message || 'Falha ao ler faturas.');
    await anotarSync(contaId, 'faturas', de, ate, { status: 'erro', erro: msg, ms: Date.now() - t0 });
    avisos.push(`Os pedidos entraram, mas as faturas não: ${msg}`);
  }

  // ── Frete por país ───────────────────────────────────────────────────────
  t0 = Date.now();
  try {
    const e = await cliente.entregas(de, ate);
    const n = await gravarEntregas(contaId, de, ate, e);
    r.entregas.paises = Math.max(0, n - 1); // a linha '*' é o agregado, não é país
    const jIni = dataSo(e.date_from);
    const jFim = dataSo(e.date_to);
    r.entregas.janela = { inicio: jIni, fim: jFim };
    if (jIni == null || jFim == null) {
      avisos.push(
        'A Red Rock não informou a janela do frete por país. Os números do frete estão na tela, ' +
        'mas sem dizer que intervalo eles cobrem.'
      );
    } else if (jIni !== de || jFim !== ate) {
      // O aviso antigo só oferecia o teto de um ano como explicação, e o corte que acontece de
      // verdade é o padrão de 90 dias. Quem lia conferia 124 dias contra "no máximo um ano",
      // concluía que não se aplicava, e aprendia a ignorar o aviso — pior que não avisar.
      const dias = (a: string, b: string) =>
        Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
      avisos.push(
        `O frete por país cobre ${dias(jIni, jFim)} dias (${jIni} a ${jFim}), não os ` +
        `${dias(de, ate)} pedidos (${de} a ${ate}): a Red Rock recorta essa consulta em 90 dias ` +
        `por padrão. O custo por pedido acima é do período inteiro; o frete médio, só dessa ` +
        `janela menor.`
      );
    }
    await anotarSync(contaId, 'entregas', de, ate, { registros: n, gravados: n, status: 'ok', ms: Date.now() - t0 });
  } catch (err: any) {
    const msg = limparSegredo(err?.message || 'Falha ao ler entregas.');
    await anotarSync(contaId, 'entregas', de, ate, { status: 'erro', erro: msg, ms: Date.now() - t0 });
    avisos.push(`O frete por país não foi atualizado: ${msg}`);
  }

  await query(
    `UPDATE produtor_credenciais SET ultimo_ok = NOW(), ultimo_erro = NULL, ultimo_erro_em = NULL,
            updated_at = NOW()
      WHERE conta_id = $1 AND provedor = $2`,
    [contaId, PROVEDOR_REDROCK]
  );

  logger.info(CTX, `Conta ${contaId}: ${r.pedidos.gravados} pedidos, ${r.cobrancas.gravadas} cobranças, ${r.faturas.gravadas} faturas`);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura para a tela
// ─────────────────────────────────────────────────────────────────────────────

export interface CustoRealPeriodo {
  /** null = vitalício: tudo o que foi sincronizado, sem recorte de data. */
  periodo: { inicio: string; fim: string } | null;
  pedidos_total: number;
  /** invoiced=true, INCLUSIVE os que ainda esperam frete. Só contagem — não é denominador. */
  pedidos_faturados: number;
  /** invoiced=true e frete já cobrado. É esta a população de custo_total e custo_medio_pedido. */
  pedidos_completos: number;
  pedidos_sem_fatura: number;
  pedidos_aguardando_frete: number;
  /** Pedidos sem data de criação: ficam fora de qualquer recorte por período, e a tela precisa dizer. */
  pedidos_sem_data: number;
  custo_total: number | null;
  custo_produto: number | null;
  custo_fulfillment: number | null;
  custo_frete: number | null;
  custo_embalagem: number | null;
  custo_outros: number | null;
  custo_medio_pedido: number | null;
  /** Parte fixa já cobrada dos pedidos que ainda esperam frete. Dinheiro real, fora da média. */
  custo_parcial: number | null;
  /** Quando foi a última sincronização bem-sucedida que COBRE este período. Null = nunca. */
  atualizado_em: string | null;
  ultima_falha: { em: string; erro: string } | null;
}

/**
 * Custo real do período, direto do que a Red Rock cobrou.
 *
 * Tudo aqui — soma, parcelas e média — sai de UMA população: pedido faturado com o frete já
 * cobrado. Os outros dois grupos voltam como contagem e como valor à parte, para a tela mostrar
 * sem misturar:
 *
 *   não faturado ....... existe, ainda não foi cobrado. Custo desconhecido.
 *   aguardando frete ... foi cobrado só na parte fixa. Custo conhecido pela metade.
 *
 * O segundo grupo é o traiçoeiro. O total dele é um número real e plausível, só que sem a perna
 * do frete — e como frete é ~28% da conta, jogá-lo na média derruba o resultado sem nada parecer
 * errado. Com dado real de 1.261 pedidos deu $28,05 no lugar de $30,59.
 */
export async function custoReal(
  contaId: number, periodo: { de: string; ate: string } | null
): Promise<CustoRealPeriodo> {
  // Vitalício não passa recorte nenhum. Antes ele mandava '2000-01-01' até a data do RELÓGIO DO
  // NAVEGADOR, o que descartava em silêncio pedido sem criado_em e qualquer pedido à frente do
  // relógio de quem olha — enquanto a tela dizia "tudo que foi sincronizado".
  const recorte = periodo
    ? `AND criado_em >= $2::date AND criado_em < ($3::date + 1)`
    : '';
  const params = periodo ? [contaId, periodo.de, periodo.ate] : [contaId];

  const t = await queryOne<any>(
    `SELECT
       COUNT(*)::int                                                     AS total,
       COUNT(*) FILTER (WHERE faturado)::int                             AS faturados,
       COUNT(*) FILTER (WHERE NOT faturado)::int                         AS sem_fatura,
       COUNT(*) FILTER (WHERE aguardando_frete)::int                     AS aguardando,
       COUNT(*) FILTER (WHERE criado_em IS NULL)::int                    AS sem_data,
       -- ── A população que fecha conta ──────────────────────────────────────────
       -- faturado E não aguardando frete. "faturado" sozinho não serve: os dois booleanos são
       -- independentes na API, e o pedido cobrado só na parte fixa tem invoiced=true com o total
       -- SEM a perna do frete. Somar esse total ou entrar com ele numa média mistura pedido
       -- completo com pedido pela metade — e o resultado sai baixo, do jeito que parece plausível.
       --
       -- Aconteceu com dado real: a média deu $28,05 quando o pedido de cobrança fechada custava
       -- $30,59. Os 295 pedidos sem frete puxavam 8,3% para baixo, e a tela ainda afirmava que
       -- eles estavam de fora. A coluna aguardando_frete foi criada exatamente para impedir isso
       -- e não estava sendo usada em nenhum FILTER.
       COUNT(*) FILTER (WHERE faturado AND NOT aguardando_frete)::int     AS completos,
       SUM(total)             FILTER (WHERE faturado AND NOT aguardando_frete) AS custo,
       SUM(total_produto)     FILTER (WHERE faturado AND NOT aguardando_frete) AS produto,
       SUM(total_fulfillment) FILTER (WHERE faturado AND NOT aguardando_frete) AS fulfillment,
       SUM(total_frete)       FILTER (WHERE faturado AND NOT aguardando_frete) AS frete,
       SUM(total_embalagem)   FILTER (WHERE faturado AND NOT aguardando_frete) AS embalagem,
       SUM(total_outros)      FILTER (WHERE faturado AND NOT aguardando_frete) AS outros,
       AVG(total)             FILTER (WHERE faturado AND NOT aguardando_frete) AS medio,
       -- A parte fixa já cobrada dos que ainda esperam frete, separada. Ela é dinheiro real que
       -- saiu, então não pode sumir da tela — só não pode entrar na média nem virar porcentagem.
       SUM(total)             FILTER (WHERE faturado AND aguardando_frete)     AS custo_parcial
     FROM produtor_redrock_pedidos
      WHERE conta_id = $1 ${recorte}`,
    params
  );

  // A data de frescor tem que ser do PERÍODO que está na tela. A última sincronização de agosto
  // não diz nada sobre números de maio, e imprimir "lido agora há pouco" sobre eles é a afirmação
  // mais perigosa do card — é justamente a que existe para dizer em que dá para confiar.
  const ok = periodo
    ? await queryOne<{ created_at: Date | string }>(
        `SELECT created_at FROM produtor_redrock_sync
          WHERE conta_id = $1 AND recurso = 'pedidos' AND status = 'ok'
            AND periodo_inicio <= $2::date AND periodo_fim >= $3::date
          ORDER BY created_at DESC LIMIT 1`,
        [contaId, periodo.de, periodo.ate]
      )
    : await queryOne<{ created_at: Date | string }>(
        `SELECT created_at FROM produtor_redrock_sync
          WHERE conta_id = $1 AND recurso = 'pedidos' AND status = 'ok'
          ORDER BY created_at DESC LIMIT 1`,
        [contaId]
      );

  // Só falha de PEDIDOS invalida estes números. Uma falha em entregas ou faturas não impede os
  // pedidos de entrarem, e marcar o card inteiro como desatualizado por causa dela fazia a pessoa
  // sincronizar de novo atrás de um problema que não estava ali.
  const falha = await queryOne<{ created_at: Date | string; erro: string }>(
    `SELECT created_at, erro FROM produtor_redrock_sync
      WHERE conta_id = $1 AND recurso = 'pedidos' AND status = 'erro'
      ORDER BY created_at DESC LIMIT 1`,
    [contaId]
  );

  return {
    periodo: periodo ? { inicio: periodo.de, fim: periodo.ate } : null,
    pedidos_total: t?.total ?? 0,
    pedidos_faturados: t?.faturados ?? 0,
    pedidos_completos: t?.completos ?? 0,
    pedidos_sem_fatura: t?.sem_fatura ?? 0,
    pedidos_aguardando_frete: t?.aguardando ?? 0,
    pedidos_sem_data: t?.sem_data ?? 0,
    custo_total: num(t?.custo),
    custo_produto: num(t?.produto),
    custo_fulfillment: num(t?.fulfillment),
    custo_frete: num(t?.frete),
    custo_embalagem: num(t?.embalagem),
    custo_outros: num(t?.outros),
    custo_medio_pedido: num(t?.medio),
    custo_parcial: num(t?.custo_parcial),
    atualizado_em: ok ? iso(ok.created_at) : null,
    ultima_falha: falha && (!ok || new Date(falha.created_at) > new Date(ok.created_at))
      ? { em: iso(falha.created_at)!, erro: falha.erro }
      : null,
  };
}

export interface FreteMedido {
  /** Janela que a Red Rock DISSE ter apurado. null = ela não informou. */
  janela: { inicio: string; fim: string } | null;
  /** Janela que foi pedida na sincronização, para a tela poder mostrar quando as duas divergem. */
  janela_pedida: { inicio: string; fim: string } | null;
  geral: { pedidos: number | null; frete_total: number | null; medio: number | null } | null;
  paises: Array<{ pais: string; pedidos: number | null; frete_total: number | null; medio: number | null }>;
  /**
   * Faixa sugerida para produtor_fulfillment, tirada dos fretes REAIS pedido a pedido.
   *
   * min e max são null quando não há observações suficientes para falar em dispersão — e aí a
   * tela mostra só o típico, sem chamar de faixa. Um mínimo igual ao máximo não é uma faixa
   * estreita: é a ausência de faixa escrita com a aparência de uma.
   */
  sugestao: { min: number | null; tipico: number; max: number | null; pedidos: number } | null;
}

/**
 * Frete medido pelo fornecedor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A FAIXA SAI DOS PEDIDOS, NÃO DAS MÉDIAS POR PAÍS.
 *
 * A primeira versão tirava min e max das médias de cada país. Com dado real isso desabou: a
 * operação é quase toda nos Estados Unidos, um único país passou do volume mínimo, e a "faixa"
 * saiu $8,76 – $8,76 — um ponto com aparência de intervalo. Pior, a variação que importa é a que
 * existe DENTRO do país (peso, serviço, distância), e uma média por país apaga exatamente essa.
 *
 * Os percentis abaixo vêm de produtor_redrock_pedidos.total_frete: uma observação por pedido, do
 * frete que a Red Rock realmente cobrou. Eram 718 observações em disco enquanto a faixa era
 * derivada de um número só.
 *
 * p10/p50/p90 em vez de mínimo e máximo absolutos porque a ponta é ruído: um pedido internacional
 * perdido vira o "máximo" e estica a previsão inteira por causa de uma linha.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A sugestão NÃO é aplicada sozinha. Ela aparece ao lado do que está cadastrado, com um botão. O
 * valor cadastrado é uma decisão de alguém; trocar por outro em silêncio faria a previsão mudar
 * sem nenhum evento que explicasse a mudança.
 */
export async function fretePorPais(contaId: number): Promise<FreteMedido> {
  // A linha a mostrar é a da última APURAÇÃO, não a da janela mais estreita. A ordenação anterior
  // era por janela_fim e depois janela_inicio, e como o "até" é quase sempre hoje, o desempate
  // elegia o início mais tardio — ou seja, a janela mais curta. Uma sincronização antiga de 90
  // dias continuava na tela depois de uma nova de 124, sem nada explicando.
  const janela = await queryOne<any>(
    `SELECT janela_inicio::text AS janela_inicio, janela_fim::text AS janela_fim,
            pedido_inicio::text AS pedido_inicio, pedido_fim::text AS pedido_fim
       FROM produtor_redrock_frete
      WHERE conta_id = $1
      ORDER BY sincronizado_em DESC, janela_fim DESC LIMIT 1`,
    [contaId]
  );

  const sugestao = await sugerirFrete(contaId);
  if (!janela) {
    return { janela: null, janela_pedida: null, geral: null, paises: [], sugestao };
  }

  const linhas = await query<any>(
    `SELECT pais, pedidos, frete_total, frete_medio_pedido
       FROM produtor_redrock_frete
      WHERE conta_id = $1 AND janela_inicio IS NOT DISTINCT FROM $2::date
        AND janela_fim IS NOT DISTINCT FROM $3::date
      ORDER BY (pais = '*') DESC, pedidos DESC NULLS LAST, frete_total DESC NULLS LAST`,
    [contaId, janela.janela_inicio, janela.janela_fim]
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

  return {
    janela: janela.janela_inicio && janela.janela_fim
      ? { inicio: janela.janela_inicio, fim: janela.janela_fim }
      : null,
    janela_pedida: janela.pedido_inicio && janela.pedido_fim
      ? { inicio: janela.pedido_inicio, fim: janela.pedido_fim }
      : null,
    geral: geralRow
      ? {
          pedidos: geralRow.pedidos ?? null,
          frete_total: num(geralRow.frete_total),
          medio: num(geralRow.frete_medio_pedido),
        }
      : null,
    paises,
    sugestao,
  };
}

/** Mínimo de observações para uma dispersão significar alguma coisa. Abaixo disso, só o típico. */
const MIN_PEDIDOS_PARA_FAIXA = 30;

/**
 * Percentis do frete real por pedido.
 *
 * O recorte é o mesmo do custo medido — faturado e com o frete já cobrado. Incluir os pedidos que
 * ainda esperam frete traria total_frete NULL (que os percentis ignoram) ou zero (que arrastaria o
 * p10 para o chão), e o resultado seria uma faixa que começa em nada.
 */
async function sugerirFrete(contaId: number): Promise<FreteMedido['sugestao']> {
  const r = await queryOne<any>(
    `SELECT COUNT(*)::int AS n,
            percentile_cont(0.10) WITHIN GROUP (ORDER BY total_frete) AS p10,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY total_frete) AS p50,
            percentile_cont(0.90) WITHIN GROUP (ORDER BY total_frete) AS p90
       FROM produtor_redrock_pedidos
      WHERE conta_id = $1 AND faturado AND NOT aguardando_frete AND total_frete IS NOT NULL`,
    [contaId]
  );
  const n = r?.n ?? 0;
  const p50 = num(r?.p50);
  if (n === 0 || p50 == null) return null;
  if (n < MIN_PEDIDOS_PARA_FAIXA) {
    return { min: null, tipico: p50, max: null, pedidos: n };
  }
  const p10 = num(r?.p10);
  const p90 = num(r?.p90);
  // Vindos do mesmo conjunto ordenado, p10 <= p50 <= p90 é garantido por construção — não existe
  // o caso de o típico cair fora da própria faixa, que existia quando o típico vinha de uma
  // população e as pontas de outra.
  return { min: p10, tipico: p50, max: p90, pedidos: n };
}

/** Histórico recente de sincronizações, para a tela poder dizer de quando é o número. */
export async function historicoSync(contaId: number, limite = 10) {
  return query<any>(
    `SELECT recurso, periodo_inicio::text, periodo_fim::text, paginas, registros, gravados,
            status, erro, duracao_ms, created_at
       FROM produtor_redrock_sync WHERE conta_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [contaId, Math.min(50, Math.max(1, limite))]
  );
}
