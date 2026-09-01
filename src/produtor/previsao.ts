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
import type { Conta } from './service';

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
  produto_id: number;
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

export async function lerTabelaFulfillment(contaId: number): Promise<TabelaFulfillment | null> {
  const r = await queryOne<any>(`SELECT * FROM produtor_fulfillment WHERE conta_id = $1`, [contaId]);
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
  conta: Conta,
  periodo: { from: string; to: string } | null
): Promise<{
  linhas: Array<{ dia: string; produto_id: number | null; unidades_por_venda: number | null; vendas: number; devolucoes: number }>;
  pedidosPorDia: Map<string, number> | null;
  fonte: 'importacao' | 'webhook' | 'nenhuma';
}> {
  // Fonte 1: vendas importadas do export da Digistore.
  //
  // Têm prioridade sobre webhook_logs quando existem, porque são as vendas DESTE produto — a conta
  // da Digistore do produto de casa não é a que alimenta a MailX. E o export traz o que o webhook
  // não traz: a quantidade de cada linha, que multiplica as unidades do pedido.
  const importadas = await vendasImportadasPorDia(conta.id, periodo);
  if (importadas.temDados) {
    return { linhas: importadas.linhas, pedidosPorDia: importadas.pedidosPorDia, fonte: 'importacao' };
  }

  // Segunda fonte: os webhooks do cliente da MailX vinculado. Sem ponte não existe segunda fonte,
  // e devolver vazio é o certo — era entrar aqui de qualquer jeito que fazia a tela mostrar o
  // faturamento de um cliente de SMS como se fosse do produtor.
  if (conta.client_id == null) {
    return { linhas: [], pedidosPorDia: null, fonte: 'nenhuma' };
  }

  const params: any[] = [conta.id, conta.client_id];
  let filtro = '';
  if (periodo) {
    params.push(periodo.from, periodo.to);
    filtro = `AND w.created_at >= $3::date AND w.created_at < ($4::date + INTERVAL '1 day')`;
  }

  const rows = await query(`
    WITH oferta AS (
      SELECT o.id, o.produto_id, o.unidades, o.preco, o.external_ids
        FROM produtor_ofertas o
        JOIN produtor_produtos p ON p.id = o.produto_id AND p.custo_unidade IS NOT NULL
       WHERE o.conta_id = $1 AND o.ativo
    ),
    venda AS (
      SELECT w.created_at, w.total_price, w.product_external_id, w.product_name, w.event_type
        FROM webhook_logs w
       WHERE w.client_id = $2
         AND w.event_type IN ('order.paid', 'order.refunded', 'order.chargeback')
         AND (w.event_type <> 'order.paid' OR w.status IN ('processed', 'processing'))
         ${filtro}
    ),
    casada AS (
      SELECT v.*, m.produto_id, m.unidades
        FROM venda v
        LEFT JOIN LATERAL (
          SELECT o.produto_id, o.unidades,
                 CASE WHEN COALESCE(array_length(o.external_ids, 1), 0) > 0
                       AND v.product_external_id = ANY(o.external_ids) THEN 0 ELSE 1 END AS prioridade
            FROM oferta o
           WHERE (COALESCE(array_length(o.external_ids, 1), 0) > 0
                  AND v.product_external_id = ANY(o.external_ids))
              OR (COALESCE(array_length(o.external_ids, 1), 0) = 0
                  AND v.total_price IS NOT NULL
                  AND ROUND(v.total_price, 2) = ROUND(o.preco, 2))
           ORDER BY prioridade, o.produto_id, o.unidades
           LIMIT 1
        ) m ON true
    )
    SELECT
      created_at::date::text AS dia,
      produto_id,
      unidades AS unidades_por_venda,
      COUNT(*) FILTER (WHERE event_type = 'order.paid') AS vendas,
      COUNT(*) FILTER (WHERE event_type IN ('order.refunded', 'order.chargeback')) AS devolucoes
    FROM casada
    GROUP BY 1, 2, 3
    ORDER BY 1
  `, params);

  return {
    fonte: 'webhook',
    // Sem importação não se sabe agrupar linhas em pedidos: cada transação conta como um, e é o
    // fator_pedidos que corrige isso até o export entrar.
    pedidosPorDia: null,
    linhas: rows.map((r: any) => ({
      dia: String(r.dia).slice(0, 10),
      produto_id: r.produto_id == null ? null : Number(r.produto_id),
      unidades_por_venda: r.unidades_por_venda == null ? null : Number(r.unidades_por_venda),
      vendas: parseInt(r.vendas, 10) || 0,
      devolucoes: parseInt(r.devolucoes, 10) || 0,
    })),
  };
}

/**
 * Vendas importadas, agregadas por dia e produto.
 *
 * Duas diferenças em relação ao caminho do webhook, e as duas importam:
 *
 * 1. `quantidade` multiplica as unidades. Comprar 2× a oferta de 6 potes são 12 potes na fatura,
 *    e o webhook não carrega essa informação.
 * 2. Pedidos são contados por PEDIDO DISTINTO, não por linha. Quando o upsell vem como add-on da
 *    mesma ordem, as duas linhas compartilham o pedido e o fulfillment despacha uma caixa só —
 *    era a explicação para a fatura ter 106 pedidos onde as transações davam 141.
 */
async function vendasImportadasPorDia(
  contaId: number,
  periodo: { from: string; to: string } | null
): Promise<{
  temDados: boolean;
  linhas: Array<{ dia: string; produto_id: number | null; unidades_por_venda: number | null; vendas: number; devolucoes: number }>;
  /** Pedidos distintos POR DIA. Contar por grupo somaria em dobro o pedido que leva dois produtos. */
  pedidosPorDia: Map<string, number>;
}> {
  const existe = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM produtor_vendas WHERE conta_id = $1 LIMIT 1`, [contaId]
  );
  if (!existe || parseInt(existe.n, 10) === 0) {
    return { temDados: false, linhas: [], pedidosPorDia: new Map() };
  }

  const params: any[] = [contaId];
  let filtro = '';
  if (periodo) {
    params.push(periodo.from, periodo.to);
    filtro = `AND v.data >= $2::date AND v.data <= $3::date`;
  }

  const rows = await query(`
    WITH oferta AS (
      SELECT o.id, o.produto_id, o.unidades, o.preco, o.external_ids
        FROM produtor_ofertas o
        JOIN produtor_produtos p ON p.id = o.produto_id AND p.custo_unidade IS NOT NULL
       WHERE o.conta_id = $1 AND o.ativo
    ),
    casada AS (
      SELECT v.*, m.produto_id, m.unidades AS unidades_oferta
        FROM produtor_vendas v
        LEFT JOIN LATERAL (
          SELECT o.produto_id, o.unidades,
                 CASE WHEN COALESCE(array_length(o.external_ids,1),0) > 0
                       AND v.gateway_produto_id = ANY(o.external_ids) THEN 0 ELSE 1 END AS prioridade
            FROM oferta o
           WHERE (COALESCE(array_length(o.external_ids,1),0) > 0 AND v.gateway_produto_id = ANY(o.external_ids))
              OR (COALESCE(array_length(o.external_ids,1),0) = 0 AND v.valor_bruto IS NOT NULL
                  AND ROUND(ABS(v.valor_bruto),2) = ROUND(o.preco,2))
           ORDER BY prioridade, o.produto_id, o.unidades
           LIMIT 1
        ) m ON true
       WHERE v.conta_id = $1 ${filtro}
    )
    SELECT
      data::text AS dia,
      produto_id,
      unidades_oferta,
      COALESCE(SUM(quantidade) FILTER (WHERE tipo = 'pagamento'), 0) AS quantidade,
      COUNT(*) FILTER (WHERE tipo IN ('reembolso','chargeback')) AS devolucoes
    FROM casada
    GROUP BY 1, 2, 3
    ORDER BY 1
  `, params);

  // Pedidos distintos por DIA, numa consulta própria. Contar dentro do agrupamento por produto
  // somaria o mesmo pedido uma vez para cada produto que ele leva — e é justamente o pedido com
  // upsell, o caso que a fatura mostrou (106 pedidos onde as transações davam 141).
  //
  // O upsell da Digistore vem com Order ID PRÓPRIO, derivado do principal: a compra QEQS3PZS gera
  // a QEQS3PZS1. Confirmado no export real — os ids têm 8 ou 9 caracteres, e todo id de 9 termina
  // em dígito e tem um de 8 correspondente. O fulfillment despacha os dois numa caixa só e cobra
  // um pedido, então contar os ids crus cobraria taxa e embalagem em dobro: no arquivo de vocês
  // são 889 transações para 710 despachos, 141 pedidos com upsell junto.
  //
  // O corte só acontece quando sobram 8+ caracteres antes dos dígitos finais, para não mutilar um
  // id curto que legitimamente termine em número.
  const pedidosRows = await query(`
    SELECT data::text AS dia,
           COUNT(DISTINCT COALESCE(regexp_replace(pedido_id, '^(.{8,})\\d+$', '\\1'), transacao_id)) AS pedidos
      FROM produtor_vendas v
     WHERE v.conta_id = $1 AND v.tipo = 'pagamento' ${filtro}
     GROUP BY 1
  `, params);
  const pedidosPorDia = new Map<string, number>(
    pedidosRows.map((r: any) => [String(r.dia).slice(0, 10), parseInt(r.pedidos, 10) || 0])
  );

  return {
    temDados: true,
    pedidosPorDia,
    linhas: rows.map((r: any) => ({
      dia: String(r.dia).slice(0, 10),
      produto_id: r.produto_id == null ? null : Number(r.produto_id),
      unidades_por_venda: r.unidades_oferta == null ? null : Number(r.unidades_oferta),
      // "vendas" aqui é a QUANTIDADE comprada: é ela que multiplica as unidades da oferta.
      vendas: parseInt(r.quantidade, 10) || 0,
      devolucoes: parseInt(r.devolucoes, 10) || 0,
    })),
  };
}

export async function preverInvoice(
  conta: Conta,
  periodo: { from: string; to: string } | null,
  moeda: string
): Promise<PrevisaoInvoice> {
  const ressalvas: string[] = [];

  const tabela = await lerTabelaFulfillment(conta.id);
  const custos = await query<any>(`
    SELECT p.id AS produto_id, p.nome_na_fatura, p.custo_unidade, p.nome AS produto
      FROM produtor_produtos p
     WHERE p.conta_id = $1 AND p.custo_unidade IS NOT NULL
     ORDER BY p.nome
  `, [conta.id]);

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

  const porProduto = new Map<number, { nome_na_fatura: string; custo_unidade: number; produto: string }>();
  for (const c of custos) {
    porProduto.set(Number(c.produto_id), {
      nome_na_fatura: c.nome_na_fatura, custo_unidade: num(c.custo_unidade), produto: c.produto,
    });
  }

  const fonteVendas = await vendasPorDiaEProduto(conta, periodo);
  const linhas = fonteVendas.linhas;
  const pedidosPorDia = fonteVendas.pedidosPorDia;

  const unidadesPorProduto = new Map<number, number>();
  const semOfertaPorProduto = new Map<number, number>();
  let transacoes = 0;
  let unidades = 0;
  let devolucoes = 0;
  const diasMap = new Map<string, { pedidos: number; unidades: number }>();

  for (const l of linhas) {
    transacoes += l.vendas;
    devolucoes += l.devolucoes;
    const d = diasMap.get(l.dia) ?? { pedidos: 0, unidades: 0 };
    d.pedidos += l.vendas;

    if (l.produto_id != null && l.unidades_por_venda != null && porProduto.has(l.produto_id)) {
      const u = l.unidades_por_venda * l.vendas;
      unidadesPorProduto.set(l.produto_id, (unidadesPorProduto.get(l.produto_id) ?? 0) + u);
      unidades += u;
      d.unidades += u;
    } else if (l.vendas > 0) {
      // Venda que nenhuma oferta reconheceu: sabemos que houve pedido, não quantas unidades.
      // Ela conta como PEDIDO (a taxa por pedido e a embalagem serão cobradas) mas não entra em
      // pick nem em custo de produto — inventar uma quantidade aqui seria adivinhar o principal.
      const k = l.produto_id ?? -1;
      semOfertaPorProduto.set(k, (semOfertaPorProduto.get(k) ?? 0) + l.vendas);
    }
    diasMap.set(l.dia, d);
  }

  const semOferta = [...semOfertaPorProduto.values()].reduce((s, v) => s + v, 0);
  if (semOferta > 0) {
    ressalvas.push(
      `${semOferta} venda(s) não casaram com nenhuma oferta cadastrada. Elas entram na conta como ` +
      `PEDIDO (taxa e embalagem são cobradas de qualquer jeito), mas ficam fora do custo de produto ` +
      `e do pick, porque não se sabe quantas unidades foram. A previsão está MENOR do que a realidade ` +
      `nesse tanto.`
    );
  }

  // Com o export importado, o número de pedidos é CONTADO (pedidos distintos), não estimado — e
  // aí o fator não se aplica: ele existe só para corrigir a contagem por transação do webhook.
  const pedidosContados = pedidosPorDia
    ? [...pedidosPorDia.entries()]
        .filter(([dia]) => !periodo || (dia >= periodo.from && dia <= periodo.to))
        .reduce((s, [, n]) => s + n, 0)
    : null;
  const pedidos = pedidosContados ?? Math.round(transacoes * t.fator_pedidos);

  const produtos: LinhaProdutoPrevisto[] = [...porProduto.entries()].map(([produtoId, c]) => {
    const u = unidadesPorProduto.get(produtoId) ?? 0;
    return {
      produto_id: produtoId,
      produto: c.produto,
      nome_na_fatura: c.nome_na_fatura,
      custo_unidade: c.custo_unidade,
      unidades: u,
      valor: u * c.custo_unidade,
      vendas_sem_oferta: semOfertaPorProduto.get(produtoId) ?? 0,
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
  const custoFixoPorDia = (dia: string, d: { pedidos: number; unidades: number }) => {
    const ped = pedidosPorDia ? (pedidosPorDia.get(dia) ?? 0) : Math.round(d.pedidos * t.fator_pedidos);
    return d.unidades * t.custo_pick_unidade + ped * (t.custo_pedido + t.custo_embalagem_pedido);
  };
  const custoProdutoDoDia = (dia: string) => linhas
    .filter(l => l.dia === dia && l.produto_id != null && l.unidades_por_venda != null && porProduto.has(l.produto_id))
    .reduce((s, l) => s + l.unidades_por_venda! * l.vendas * porProduto.get(l.produto_id!)!.custo_unidade, 0);

  let acc = 0;
  const por_dia = [...diasMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dia, d]) => {
    const v = custoFixoPorDia(dia, d) + custoProdutoDoDia(dia);
    acc += v;
    return {
      dia,
      pedidos: pedidosPorDia ? (pedidosPorDia.get(dia) ?? 0) : Math.round(d.pedidos * t.fator_pedidos),
      unidades: d.unidades,
      fixo: v,
      acumulado_fixo: acc,
    };
  });

  if (fonteVendas.fonte === 'importacao') {
    ressalvas.push(
      'Os pedidos são CONTADOS a partir do export importado (pedidos distintos), não estimados. ' +
      'Quando o upsell vem como add-on da mesma ordem, ele conta como um despacho só — que é ' +
      'como o fulfillment cobra.'
    );
  } else if (t.fator_pedidos !== 1) {
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
