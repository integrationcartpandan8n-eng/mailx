/**
 * ATRIBUIÇÃO — a definição única de canal e de segmento.
 *
 * Por que este arquivo existe: em 08/08/2026 o mesmo indicador estava sendo calculado em lugares
 * diferentes, e isso produziu três bugs em sequência no mesmo dia. A tabela de segmento foi
 * corrigida e a "Aberto por produto" ficou para trás, mostrando 7 vendas num lugar e 27 no outro,
 * na MESMA tela. Depois a normalização de família foi aplicada no front e esquecida no servidor.
 * Nos dois casos o conserto não estava errado — estava incompleto, e não havia como saber.
 *
 * A regra passa a morar aqui, uma vez. Quem precisa de "venda de SMS", "recuperação" ou "família
 * do produto" importa daqui em vez de reescrever. Um conserto neste arquivo vale para a tela
 * inteira de uma vez — que é a diferença entre corrigir um bug e corrigir uma classe de bug.
 */

// ─────────────────────────────────────────────────────────────
// Fase B — Atribuição MailX via colunas normalizadas
// Canal decidido por utm_medium (padrão UTMS_DASH), com fallback
// legado (source/campaign sem hífen) para registros antigos sem medium.
// ─────────────────────────────────────────────────────────────

/**
 * Venda atribuída à MailX (qualquer canal).
 *
 * Inclui tracking_code porque ClickBank e Buygoods NÃO ACEITAM UTM — a documentação UTMS_DASH
 * define que a marcação vai no `tid` (ClickBank) e no `subid` (Buygoods), no formato
 * "Mailx_AutoEmail_..." / "MailxSMS_AutoSMS_...". Esse valor é guardado cru em
 * webhook_logs.tracking_code. Sem olhar essa coluna, toda venda MailX vinda desses dois
 * gateways seria registrada e não atribuída a ninguém — o ClickBank ainda não está ativo,
 * então nada foi perdido até agora, mas passaria a ser invisível no dia que ligasse.
 */
export const SQL_IS_MAILX = `(
  COALESCE(utm_source, '')   ILIKE '%mailx%'
  OR COALESCE(utm_campaign, '') ILIKE '%mailx%'
  OR COALESCE(tracking_code, '') ILIKE '%mailx%'
)`;

/**
 * Canal SMS: medium contém 'sms', OU a origem é mailx-sms.
 *
 * A checagem por utm_source já existia, mas só valia com `utm_medium IS NULL` — e essa condição
 * classificava venda de SMS como EMAIL. Encontrado ao validar o SMS: os links do Horse Peak (N8N)
 * saem com `utm_source=mailx-sms` e `utm_medium=WFI001` / `WFI002-Upsell`, fora do padrão da spec
 * (que manda `auto-sms`). Como 'WFI001' não contém 'sms' e não é nulo, a venda caía em
 * SQL_IS_SMS = falso; e como a origem tem 'mailx', SQL_IS_MAILX = verdadeiro. Resultado:
 * SQL_MAILX_EMAIL = MailX E NÃO SMS ficava verdadeiro, e receita de SMS entrava no faturamento de
 * EMAIL — o pior tipo de erro, porque os dois canais ficam errados de uma vez e a soma continua
 * fechando.
 *
 * Origem `mailx-sms` é prova suficiente de canal, com ou sem medium: nenhum link de email carrega
 * essa origem. O medium fora do padrão continua sendo problema (a tabela por mensagem exige
 * `auto-sms` exato), mas isso aparece na nota de reconciliação do card, não como canal trocado.
 */
export const SQL_IS_SMS = `(
  COALESCE(utm_medium, '') ILIKE '%sms%'
  OR REPLACE(COALESCE(utm_source, ''),   '-', '') ILIKE '%mailxsms%'
  OR REPLACE(COALESCE(utm_campaign, ''), '-', '') ILIKE '%mailxsms%'
  -- ClickBank/Buygoods: o canal vem no próprio código de rastreio, que começa com
  -- "MailxSMS_AutoSMS_" no SMS e "Mailx_AutoEmail_" no email. Tokens específicos em vez de
  -- procurar 'sms' solto, pra nome de produto com essas letras não classificar errado.
  OR COALESCE(tracking_code, '') ILIKE '%mailxsms%'
  OR COALESCE(tracking_code, '') ILIKE '%autosms%'
)`;

/** MailX via SMS. */
export const SQL_MAILX_SMS = `(${SQL_IS_MAILX} AND ${SQL_IS_SMS})`;

/** MailX via Email = MailX e NÃO SMS. */
export const SQL_MAILX_EMAIL = `(${SQL_IS_MAILX} AND NOT ${SQL_IS_SMS})`;

/** Recuperação de carrinho abandonado (qualquer canal). */
export const SQL_IS_RECOVERY = `(
  COALESCE(utm_campaign, '') ILIKE '%carrinhoabandonado%'
  OR COALESCE(utm_source, '') ILIKE '%carrinhoabandonado%'
  OR COALESCE(tracking_code, '') ILIKE '%carrinhoabandonado%'
)`;

/** Medium de automação (auto-email / auto-sms). */
export const SQL_MEDIUM_AUTO = `COALESCE(utm_medium, '') ILIKE '%auto%'`;

/** Medium de campanha (campaign-editorial / campaing-promo e variações). */
export const SQL_MEDIUM_CAMPAIGN = `(
  COALESCE(utm_medium, '') ILIKE '%campai%'
  OR COALESCE(utm_medium, '') ILIKE '%editorial%'
  OR COALESCE(utm_medium, '') ILIKE '%promo%'
)`;

/** Campanha de upsell. */
/**
 * Upsell — a automação de pós-compra. Duas grafias circulam para o MESMO evento: a
 * documentação UTMS_DASH chama de "Automação Compra Aprovada (Upsell)" e usa
 * "CompraAprovada" na campanha, enquanto os disparos em produção usam "Upsell".
 * As duas contam, nos dois caminhos (utm_campaign e tid/subid) — antes só "Upsell" era
 * reconhecido via UTM, então um cliente que seguisse a documentação à risca teria upsell
 * zerado sem nenhum aviso.
 */
export const SQL_IS_UPSELL = `(
  COALESCE(utm_campaign, '')    ILIKE '%upsell%'
  OR COALESCE(utm_campaign, '') ILIKE '%compraaprovada%'
  OR COALESCE(tracking_code, '') ILIKE '%upsell%'
  OR COALESCE(tracking_code, '') ILIKE '%compraaprovada%'
)`;

/** Receita normalizada (Fase A garante NUMERIC ou NULL). */
export const SQL_REVENUE = `COALESCE(SUM(total_price), 0)`;

/**
 * ESCOPO por automação: a venda veio de uma mensagem vinculada a um workflow da SlickText.
 *
 * É o que alinha numerador e denominador — a venda pertence a um fluxo cujas listas estão sendo
 * contadas nos leads. Upsell entra pelo fluxo que o vendeu, que é onde o lead realmente está.
 * O $1 é sempre o client_id; quem usa precisa passá-lo como primeiro parâmetro.
 */
export const SQL_ESCOPO_POR_AUTOMACAO = `EXISTS (
  SELECT 1 FROM sms_campaign_map m
  WHERE m.client_id = $1 AND m.utm_campaign = webhook_logs.utm_campaign
)`;

/**
 * Família do produto — tira o sufixo de ORIGEM, não de produto.
 *
 * "NeuromindProN8N" é o mesmo NeuroMind: n8n diz QUEM disparou, não O QUE foi vendido. Antes de
 * existir aqui, essa regra estava duplicada no servidor e no navegador, e a duplicação já cobrou:
 * corrigida num lado, esquecida no outro, o produto virou linha própria, ficou "sem lista" e as
 * 21 recuperações dele sumiram do denominador de todo mundo.
 *
 * Conservadora de propósito: só sufixo no fim. Remover no meio quebraria nome legítimo que
 * contenha a sigla.
 */
export function familiaDoProduto(nome: string | null | undefined): string {
  if (!nome) return '';
  return String(nome).replace(/[\s._-]*n8n$/i, '').trim() || String(nome);
}

export interface KitListasRow {
  st_list_abandono_id: string | null;
  st_list_abandono_id_2?: string | null;
  st_list_compra_id: string | null;
  st_list_compra_id_2?: string | null;
}

/**
 * Todas as listas de abandono/compra de um kit, incluindo a segunda quando existir.
 *
 * Existe porque um produto pode ser vendido por mais de um gateway de captação de lead ao mesmo
 * tempo (Digistore direto, JVZoo, BuyGoods como afiliado) — confirmado com o Murilo para a família
 * NorthScale: não importa de onde veio o lead, toda venda que fecha cai na MESMA conta Digistore
 * cadastrada. O lead de cada gateway cai numa lista diferente, às vezes em conta diferente da
 * SlickText, e as duas são leads DE VERDADE do mesmo produto — têm que ser SOMADAS.
 *
 * Único ponto de leitura das duas colunas: todo lugar que soma lista de produto usa esta função,
 * em vez de ler `st_list_compra_id` sozinho — assim uma segunda lista vinculada pelo auto-vínculo
 * entra em TODO cálculo (leads, contagem por conta, inventário) sem precisar lembrar de atualizar
 * cada um separadamente.
 */
export function listasDoKit(kit: KitListasRow): { abandono: string[]; compra: string[] } {
  return {
    abandono: [kit.st_list_abandono_id, kit.st_list_abandono_id_2].filter((v): v is string => !!v),
    compra: [kit.st_list_compra_id, kit.st_list_compra_id_2].filter((v): v is string => !!v),
  };
}

/**
 * APURAÇÃO DO CANAL SMS — a contagem canônica de vendas por segmento.
 *
 * Esta função existe para que a aba SMS e o endpoint de invariantes leiam do MESMO lugar.
 * Antes, o endpoint refazia a conta por conta própria e conferia 1 das 4 identidades: a
 * ferramenta construída para achar inconsistência estava, ela mesma, incompleta pelo motivo que
 * ela existe para combater.
 *
 * `periodoSql` e `params` vêm de quem chama porque o parser de período (hoje / N dias /
 * personalizado com hora) mora no router e é usado por dezenas de endpoints. O contrato é fixo:
 * $1 é sempre o client_id.
 */
export interface ApuracaoSms {
  /** Casaram com carrinho abandonado. */
  recuperacoes: number;
  /** Casaram com upsell / compra aprovada. */
  compradores: number;
  /** Não casaram com nenhum dos dois — o link não diz de qual fluxo veio. */
  naoClassificado: number;
  total: number;
  /** Dos classificados, os que vieram de mensagem vinculada a uma automação. */
  dentroRec: number;
  dentroCompra: number;
  foraRec: number;
  foraCompra: number;
}

export async function apurarSms(
  executarQuery: <T>(sql: string, params: any[]) => Promise<T[]>,
  clientId: string | number,
  periodoSql: string,
  params: (string | number)[]
): Promise<ApuracaoSms> {
  const linhas = await executarQuery<any>(`
    SELECT
      COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY}) AS rec,
      COUNT(*) FILTER (WHERE ${SQL_IS_UPSELL})   AS upsell,
      COUNT(*) FILTER (WHERE NOT ${SQL_IS_RECOVERY} AND NOT ${SQL_IS_UPSELL}) AS nao_class,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY} AND ${SQL_ESCOPO_POR_AUTOMACAO}) AS dentro_rec,
      COUNT(*) FILTER (WHERE ${SQL_IS_UPSELL}   AND ${SQL_ESCOPO_POR_AUTOMACAO}) AS dentro_compra
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND client_id = $1 AND ${SQL_MAILX_SMS}
      ${periodoSql ? `AND ${periodoSql}` : ''}
  `, params);

  const r = linhas[0] ?? {};
  const n = (v: any) => parseInt(v ?? '0', 10) || 0;

  const recuperacoes = n(r.rec);
  const compradores = n(r.upsell);
  const dentroRec = n(r.dentro_rec);
  const dentroCompra = n(r.dentro_compra);

  return {
    recuperacoes,
    compradores,
    naoClassificado: n(r.nao_class),
    total: n(r.total),
    dentroRec,
    dentroCompra,
    // Derivados, não consultados de novo: fora = classificado menos dentro. Uma segunda query
    // para "fora" abriria a porta para os dois lados discordarem — que é o defeito que esta
    // função existe para fechar.
    foraRec: recuperacoes - dentroRec,
    foraCompra: compradores - dentroCompra,
  };
}
