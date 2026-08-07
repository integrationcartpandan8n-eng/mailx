/**
 * Previsão do invoice do fulfillment, acumulando pelas vendas do dia.
 *
 * O QUE ESTE MÓDULO EXISTE PARA RESPONDER: "quanto a Red Rock vai cobrar?", antes de a fatura
 * chegar, e atualizado a cada venda que entra.
 *
 * ── Como as 12 faturas reais foram lidas ────────────────────────────────────────────────────
 *
 * A fatura tem dez linhas com três direcionadores diferentes, e duas relações se confirmaram em
 * TODAS as 12 (01/05 a 04/08/2026):
 *
 *     Pick (quantidade)      == soma das unidades de todos os produtos
 *     Box + Bubble Mailer    == número de pedidos
 *
 * São elas que sustentam a previsão. Os preços não mudaram em três meses: produto por unidade
 * ($3,00 o Divine Purity, $2,47 o Divine Detox), pick $0,25 por unidade, taxa $0,75 por pedido,
 * embalagem $0,38 por pedido.
 *
 * ── Por que a previsão é uma FAIXA e não um número ──────────────────────────────────────────
 *
 * Reproduzindo as 12 faturas a partir de pedidos e unidades:
 *
 *     parte fixa (produto + pick + pedido + embalagem) = 75% do dinheiro, erro de 0,2%
 *     frete (UPS/USPS/void fill/processing)            = 25% do dinheiro, erro de ~17%
 *
 * O frete erra porque o número de ENVIOS de uma semana não é o de PEDIDOS dela — na W10 foram 58
 * pedidos e 106 envios, porque despachar tem defasagem em relação a vender. Cravar um número só
 * daria um total 17% errado sem ninguém conseguir dizer de qual pedaço veio o erro. Então a parte
 * exata sai exata, a parte incerta sai como faixa, e a tela mostra as duas separadas.
 */
import { query, queryOne } from '../db/database';

export interface TabelaFulfillment {
  fornecedor: string;
  custo_pick_unidade: number;
  custo_pedido: number;
  custo_embalagem_pedido: number;
  custo_devolucao: number;
  frete_pedido_min: number | null;
  frete_pedido_tipico: number | null;
  frete_pedido_max: number | null;
  fator_pedidos: number;
}

export interface LinhaProdutoPrevisto {
  kit_id: number;
  produto: string;
  nome_na_fatura: string;
  custo_unidade: number;
  unidades: number;
  valor: number;
  /** Vendas cujo produto tem custo cadastrado mas a oferta não — unidades desconhecidas. */
  vendas_sem_oferta: number;
}

export interface PrevisaoInvoice {
  periodo: { from: string; to: string } | null;
  rotulo_periodo: string;
  fornecedor: string | null;
  moeda: string;

  pedidos: number;
  transacoes: number;
  unidades: number;
  devolucoes: number;

  produtos: LinhaProdutoPrevisto[];

  fixo: {
    produto: number;
    pick: number;
    pedido: number;
    embalagem: number;
    devolucao: number;
    total: number;
  };

  /** null quando a faixa de frete não foi cadastrada — não é zero, é desconhecido. */
  frete: { min: number; tipico: number; max: number } | null;

  total: { min: number; tipico: number; max: number } | null;

  /** Série diária para acompanhar o invoice se formando ao longo da semana. */
  por_dia: Array<{
    dia: string; pedidos: number; unidades: number; fixo: number; acumulado_fixo: number;
  }>;

  ressalvas: string[];
}

const VAZIA: TabelaFulfillment = {
  fornecedor: '', custo_pick_unidade: 0, custo_pedido: 0, custo_embalagem_pedido: 0,
  custo_devolucao: 0, frete_pedido_min: null, frete_pedido_tipico: null, frete_pedido_max: null,
  fator_pedidos: 1,
};

function num(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function numOuNulo(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export async function lerTabelaFulfillment(clientId: number): Promise<TabelaFulfillment | null> {
  const r = await queryOne<any>(`SELECT * FROM produtor_fulfillment WHERE client_id = $1`, [clientId]);
  if (!r) return null;
  return {
    fornecedor: r.fornecedor,
    custo_pick_unidade: num(r.custo_pick_unidade),
    custo_pedido: num(r.custo_pedido),
    custo_embalagem_pedido: num(r.custo_embalagem_pedido),
    custo_devolucao: num(r.custo_devolucao),
    frete_pedido_min: numOuNulo(r.frete_pedido_min),
    frete_pedido_tipico: numOuNulo(r.frete_pedido_tipico),
    frete_pedido_max: numOuNulo(r.frete_pedido_max),
    fator_pedidos: num(r.fator_pedidos) || 1,
  };
}

/**
 * Vendas do CLIENTE INTEIRO por dia e por produto — não de um produto só.
 *
 * A fatura da Red Rock cobra Divine Purity e Divine Detox na mesma folha, então prever o invoice
 * olhando um produto de cada vez daria um número que nunca bate com papel nenhum. O escopo da
 * previsão é o cliente; o lucro por produto continua sendo outra tela.
 */
async function vendasPorDiaEProduto(
  clientId: number,
  periodo: { from: string; to: string } | null
): Promise<Array<{
  dia: string; kit_id: number | null; unidades_por_venda: number | null;
  vendas: number; devolucoes: number;
}>> {
  const params: any[] = [clientId];
  let filtro = '';
  if (periodo) {
    params.push(periodo.from, periodo.to);
    filtro = `AND w.created_at >= $2::date AND w.created_at < ($3::date + INTERVAL '1 day')`;
  }

  const rows = await query(`
    WITH oferta AS (
      SELECT o.id, o.kit_id, o.unidades, o.preco, o.external_ids
        FROM produtor_ofertas o
        JOIN produtor_custo_produto c ON c.kit_id = o.kit_id AND c.client_id = o.client_id
       WHERE o.client_id = $1 AND o.ativo
    ),
    venda AS (
      SELECT w.created_at, w.total_price, w.product_external_id, w.product_name, w.event_type
        FROM webhook_logs w
       WHERE w.client_id = $1
         AND w.event_type IN ('order.paid', 'order.refunded', 'order.chargeback')
         AND (w.event_type <> 'order.paid' OR w.status IN ('processed', 'processing'))
         ${filtro}
    ),
    casada AS (
      SELECT v.*, m.kit_id, m.unidades
        FROM venda v
        LEFT JOIN LATERAL (
          SELECT o.kit_id, o.unidades,
                 CASE WHEN COALESCE(array_length(o.external_ids, 1), 0) > 0
                       AND v.product_external_id = ANY(o.external_ids) THEN 0 ELSE 1 END AS prioridade
            FROM oferta o
           WHERE (COALESCE(array_length(o.external_ids, 1), 0) > 0
                  AND v.product_external_id = ANY(o.external_ids))
              OR (COALESCE(array_length(o.external_ids, 1), 0) = 0
                  AND v.total_price IS NOT NULL
                  AND ROUND(v.total_price, 2) = ROUND(o.preco, 2))
           ORDER BY prioridade, o.kit_id, o.unidades
           LIMIT 1
        ) m ON true
    )
    SELECT
      created_at::date::text AS dia,
      kit_id,
      unidades AS unidades_por_venda,
      COUNT(*) FILTER (WHERE event_type = 'order.paid') AS vendas,
      COUNT(*) FILTER (WHERE event_type IN ('order.refunded', 'order.chargeback')) AS devolucoes
    FROM casada
    GROUP BY 1, 2, 3
    ORDER BY 1
  `, params);

  return rows.map((r: any) => ({
    dia: String(r.dia).slice(0, 10),
    kit_id: r.kit_id == null ? null : Number(r.kit_id),
    unidades_por_venda: r.unidades_por_venda == null ? null : Number(r.unidades_por_venda),
    vendas: parseInt(r.vendas, 10) || 0,
    devolucoes: parseInt(r.devolucoes, 10) || 0,
  }));
}

export async function preverInvoice(
  clientId: number,
  periodo: { from: string; to: string } | null,
  moeda: string
): Promise<PrevisaoInvoice> {
  const ressalvas: string[] = [];

  const tabela = await lerTabelaFulfillment(clientId);
  const custos = await query<any>(`
    SELECT c.kit_id, c.nome_na_fatura, c.custo_unidade, k.name AS produto
      FROM produtor_custo_produto c
      JOIN kits k ON k.id = c.kit_id
     WHERE c.client_id = $1
     ORDER BY k.name
  `, [clientId]);

  const t = tabela ?? VAZIA;
  if (!tabela) {
    ressalvas.push(
      'A tabela de preços do fulfillment não foi cadastrada. Sem ela a previsão só consegue somar ' +
      'o custo dos produtos — pick, taxa por pedido, embalagem e frete ficam de fora, e o invoice ' +
      'previsto sai MENOR do que vai vir.'
    );
  }
  if (custos.length === 0) {
    ressalvas.push(
      'Nenhum produto tem custo unitário cadastrado. Sem isso não há previsão de invoice — a ' +
      'maior parte da fatura é justamente o custo do produto.'
    );
  }

  const porKit = new Map<number, { nome_na_fatura: string; custo_unidade: number; produto: string }>();
  for (const c of custos) {
    porKit.set(Number(c.kit_id), {
      nome_na_fatura: c.nome_na_fatura, custo_unidade: num(c.custo_unidade), produto: c.produto,
    });
  }

  const linhas = await vendasPorDiaEProduto(clientId, periodo);

  const unidadesPorKit = new Map<number, number>();
  const semOfertaPorKit = new Map<number, number>();
  let transacoes = 0;
  let unidades = 0;
  let devolucoes = 0;
  const diasMap = new Map<string, { pedidos: number; unidades: number }>();

  for (const l of linhas) {
    transacoes += l.vendas;
    devolucoes += l.devolucoes;
    const d = diasMap.get(l.dia) ?? { pedidos: 0, unidades: 0 };
    d.pedidos += l.vendas;

    if (l.kit_id != null && l.unidades_por_venda != null && porKit.has(l.kit_id)) {
      const u = l.unidades_por_venda * l.vendas;
      unidadesPorKit.set(l.kit_id, (unidadesPorKit.get(l.kit_id) ?? 0) + u);
      unidades += u;
      d.unidades += u;
    } else if (l.vendas > 0) {
      // Venda que nenhuma oferta reconheceu: sabemos que houve pedido, não quantas unidades.
      // Ela conta como PEDIDO (a taxa por pedido e a embalagem serão cobradas) mas não entra em
      // pick nem em custo de produto — inventar uma quantidade aqui seria adivinhar o principal.
      const k = l.kit_id ?? -1;
      semOfertaPorKit.set(k, (semOfertaPorKit.get(k) ?? 0) + l.vendas);
    }
    diasMap.set(l.dia, d);
  }

  const semOferta = [...semOfertaPorKit.values()].reduce((s, v) => s + v, 0);
  if (semOferta > 0) {
    ressalvas.push(
      `${semOferta} venda(s) não casaram com nenhuma oferta cadastrada. Elas entram na conta como ` +
      `PEDIDO (taxa e embalagem são cobradas de qualquer jeito), mas ficam fora do custo de produto ` +
      `e do pick, porque não se sabe quantas unidades foram. A previsão está MENOR do que a realidade ` +
      `nesse tanto.`
    );
  }

  const pedidos = Math.round(transacoes * t.fator_pedidos);

  const produtos: LinhaProdutoPrevisto[] = [...porKit.entries()].map(([kitId, c]) => {
    const u = unidadesPorKit.get(kitId) ?? 0;
    return {
      kit_id: kitId,
      produto: c.produto,
      nome_na_fatura: c.nome_na_fatura,
      custo_unidade: c.custo_unidade,
      unidades: u,
      valor: u * c.custo_unidade,
      vendas_sem_oferta: semOfertaPorKit.get(kitId) ?? 0,
    };
  });

  const fixo = {
    produto: produtos.reduce((s, p) => s + p.valor, 0),
    pick: unidades * t.custo_pick_unidade,
    pedido: pedidos * t.custo_pedido,
    embalagem: pedidos * t.custo_embalagem_pedido,
    devolucao: devolucoes * t.custo_devolucao,
    total: 0,
  };
  fixo.total = fixo.produto + fixo.pick + fixo.pedido + fixo.embalagem + fixo.devolucao;

  // Frete só existe se a faixa foi cadastrada. Sem ela o campo é null — e null não vira zero,
  // senão o total previsto apareceria completo faltando um quarto dele.
  const temFaixa = t.frete_pedido_tipico != null;
  const frete = temFaixa ? {
    min: pedidos * (t.frete_pedido_min ?? t.frete_pedido_tipico!),
    tipico: pedidos * t.frete_pedido_tipico!,
    max: pedidos * (t.frete_pedido_max ?? t.frete_pedido_tipico!),
  } : null;

  if (!temFaixa && tabela) {
    ressalvas.push(
      'A faixa de frete por pedido não foi cadastrada, então o total previsto não inclui frete. ' +
      'Nas faturas históricas o frete foi cerca de um quarto da conta.'
    );
  }

  const total = frete ? {
    min: fixo.total + frete.min,
    tipico: fixo.total + frete.tipico,
    max: fixo.total + frete.max,
  } : null;

  // Série diária: é o pedido do chefe — ver o invoice se formando ao longo da semana em vez de
  // descobrir o valor quando o papel chega.
  const custoFixoPorDia = (d: { pedidos: number; unidades: number }) => {
    const ped = Math.round(d.pedidos * t.fator_pedidos);
    return d.unidades * t.custo_pick_unidade + ped * (t.custo_pedido + t.custo_embalagem_pedido);
  };
  const custoProdutoDoDia = (dia: string) => linhas
    .filter(l => l.dia === dia && l.kit_id != null && l.unidades_por_venda != null && porKit.has(l.kit_id))
    .reduce((s, l) => s + l.unidades_por_venda! * l.vendas * porKit.get(l.kit_id!)!.custo_unidade, 0);

  let acc = 0;
  const por_dia = [...diasMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dia, d]) => {
    const v = custoFixoPorDia(d) + custoProdutoDoDia(dia);
    acc += v;
    return {
      dia,
      pedidos: Math.round(d.pedidos * t.fator_pedidos),
      unidades: d.unidades,
      fixo: v,
      acumulado_fixo: acc,
    };
  });

  if (t.fator_pedidos !== 1) {
    ressalvas.push(
      `O número de pedidos é ${t.fator_pedidos}× o de transações, conforme cadastrado — use a ` +
      `comparação com as faturas já lançadas para conferir se esse fator ainda vale.`
    );
  }

  return {
    periodo,
    rotulo_periodo: periodo ? `${periodo.from} a ${periodo.to}` : 'vitalício',
    fornecedor: tabela?.fornecedor ?? null,
    moeda,
    pedidos,
    transacoes,
    unidades,
    devolucoes,
    produtos,
    fixo,
    frete,
    total,
    por_dia,
    ressalvas,
  };
}
