/**
 * Camada de leitura dos 5 cards de comissão de afiliado (skill99), por CLIENTE.
 *
 * Fonte: afiliado_eventos, alimentada pelo postback S2S da Digistore24 (ver
 * src/webhooks/digistore24-afiliado.handler.ts). O cruzamento cliente <-> merchant_id é feito
 * AQUI, na leitura — nunca gravado na tabela de eventos — pra um cliente mapeado hoje enxergar na
 * hora todo o histórico que já tinha chegado antes do mapeamento existir.
 *
 * Cards 3/4 (reembolso de venda do período vs. de antes) são resolvidos cruzando order_id DENTRO
 * da própria afiliado_eventos — a Digistore confirmou que não existe campo pronto pra isso do lado
 * de afiliado. Pedido cuja venda original é de ANTES de começarmos a coletar cai no bucket
 * `naoExplicado`, nunca é descartado em silêncio nem contado no lugar errado.
 */

import { queryOne } from '../db/database';

export interface CardsDeAfiliado {
  periodo: { de: string; ate: string };
  card1: { vendas: number; valor: number };
  card2: { valor: number };
  card3: { eventos: number; valor: number };
  card4: { eventos: number; valor: number };
  card5: { valor: number };
  naoExplicado: { eventos: number; valor: number };
}

export type ResultadoCardsAfiliado =
  | { ok: true; cards: CardsDeAfiliado }
  | { ok: false; motivo: 'sem-vinculo' | 'erro-no-banco'; detalhe: string };

/** merchant_id da conta de produtor do cliente na Digistore24, ou null se ainda não mapeado. */
export async function merchantIdDoCliente(clientId: number | string): Promise<string | null> {
  const r = await queryOne<{ digistore24_merchant_id: string | null }>(
    `SELECT digistore24_merchant_id FROM clients WHERE id = $1`,
    [clientId]
  );
  return r?.digistore24_merchant_id || null;
}

/**
 * Os 5 cards do documento, escopados a UM cliente (via merchant_id), pro período `fromYmd`..`toYmd`
 * (strings "YYYY-MM-DD", inclusive nas duas pontas). NUNCA lança — falha na consulta não pode
 * derrubar a página do cliente que mostraria o resto normalmente.
 */
export async function cardsDeAfiliado(
  merchantId: string,
  fromYmd: string,
  toYmd: string
): Promise<ResultadoCardsAfiliado> {
  try {
    const r = await queryOne<{
      card1_vendas: string; card1_valor: string; card2_valor: string; card5_valor: string;
      card3_eventos: string; card3_valor: string; card4_eventos: string; card4_valor: string;
      nao_explicado_eventos: string; nao_explicado_valor: string;
    }>(
      `WITH periodo AS (
         SELECT * FROM afiliado_eventos
         WHERE merchant_id = $1 AND is_test = false
           AND evento_em >= $2::timestamp AND evento_em <= $3::timestamp
       ),
       perdas AS (
         SELECT p.order_id, p.amount_brutto,
                (SELECT MIN(o.evento_em) FROM afiliado_eventos o
                 WHERE o.merchant_id = $1 AND o.order_id = p.order_id AND o.transaction_type = 'payment'
                ) AS venda_original_em
         FROM periodo p
         WHERE p.transaction_type IN ('refund', 'chargeback')
       )
       SELECT
         (SELECT COUNT(*)::int FROM periodo WHERE transaction_type = 'payment') AS card1_vendas,
         (SELECT COALESCE(SUM(amount_brutto), 0)::float8 FROM periodo WHERE transaction_type = 'payment') AS card1_valor,
         (SELECT COALESCE(SUM(amount_brutto), 0)::float8 FROM periodo WHERE transaction_type IN ('payment', 'refund', 'chargeback')) AS card2_valor,
         (SELECT COALESCE(SUM(amount_affiliate), 0)::float8 FROM periodo WHERE transaction_type IN ('payment', 'refund', 'chargeback')) AS card5_valor,
         (SELECT COUNT(*)::int FROM perdas WHERE venda_original_em::date >= $4::date) AS card3_eventos,
         (SELECT COALESCE(SUM(amount_brutto), 0)::float8 FROM perdas WHERE venda_original_em::date >= $4::date) AS card3_valor,
         (SELECT COUNT(*)::int FROM perdas WHERE venda_original_em::date < $4::date) AS card4_eventos,
         (SELECT COALESCE(SUM(amount_brutto), 0)::float8 FROM perdas WHERE venda_original_em::date < $4::date) AS card4_valor,
         (SELECT COUNT(*)::int FROM perdas WHERE venda_original_em IS NULL) AS nao_explicado_eventos,
         (SELECT COALESCE(SUM(amount_brutto), 0)::float8 FROM perdas WHERE venda_original_em IS NULL) AS nao_explicado_valor
      `,
      [merchantId, `${fromYmd} 00:00:00`, `${toYmd} 23:59:59`, fromYmd]
    );

    return {
      ok: true,
      cards: {
        periodo: { de: fromYmd, ate: toYmd },
        card1: { vendas: parseInt(r?.card1_vendas ?? '0', 10), valor: parseFloat(r?.card1_valor ?? '0') },
        card2: { valor: parseFloat(r?.card2_valor ?? '0') },
        card3: { eventos: parseInt(r?.card3_eventos ?? '0', 10), valor: parseFloat(r?.card3_valor ?? '0') },
        card4: { eventos: parseInt(r?.card4_eventos ?? '0', 10), valor: parseFloat(r?.card4_valor ?? '0') },
        card5: { valor: parseFloat(r?.card5_valor ?? '0') },
        naoExplicado: {
          eventos: parseInt(r?.nao_explicado_eventos ?? '0', 10),
          valor: parseFloat(r?.nao_explicado_valor ?? '0'),
        },
      },
    };
  } catch (err: any) {
    return { ok: false, motivo: 'erro-no-banco', detalhe: err.message };
  }
}

/** Ponto de entrada único do router: resolve o merchant_id do cliente e já devolve os cards. */
export async function cardsDeAfiliadoDoCliente(
  clientId: number | string,
  fromYmd: string,
  toYmd: string
): Promise<ResultadoCardsAfiliado> {
  const merchantId = await merchantIdDoCliente(clientId);
  if (!merchantId) {
    return { ok: false, motivo: 'sem-vinculo', detalhe: 'cliente sem digistore24_merchant_id mapeado' };
  }
  return cardsDeAfiliado(merchantId, fromYmd, toYmd);
}
