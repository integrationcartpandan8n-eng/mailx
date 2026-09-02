/**
 * Cálculo da aba Produtor: faturamento do produto, custo previsto, custo real (fatura) e lucro.
 *
 * O escopo é a CONTA DE PRODUTOR, não o cliente da MailX. Quando a conta tem a ponte com um
 * cliente preenchida — a DirectX vai ter, porque a MailX vai fazer o SMS e o email dela — este
 * módulo pode LER webhook_logs daquele cliente. Nunca escreve nada fora das tabelas `produtor_*`,
 * não toca em atribuição, UTM, nem em qualquer coisa que a aba SMS use: um erro aqui pode fazer a
 * aba Produtor mostrar um número errado, mas não pode mexer num número da MailX.
 *
 * As três regras que sustentam o resto:
 *
 * 1. **Uma venda casa com no máximo uma oferta.** Id do gateway ganha de preço, empate pelo menor
 *    id. Sem essa regra, duas ofertas de mesmo preço contariam a mesma venda duas vezes e o
 *    faturamento por oferta somaria mais que o faturamento do produto.
 *
 * 2. **A fatura substitui a previsão só nos dias que ela cobre.** Fatura de 01 a 22 num período de
 *    01 a 31 não vira o custo do mês inteiro: os 9 dias restantes continuam valendo a previsão, e a
 *    tela diz quantos dias são de cada. Substituir o período todo faria o custo real parecer
 *    completo quando falta um terço dele.
 *
 * 3. **Vendas sem oferta cadastrada não entram no lucro.** Elas entram no faturamento do produto
 *    (aconteceram), mas não têm custo conhecido. Margem só é calculada sobre o que tem custo, e a
 *    tela mostra a cobertura — denominador incompleto faz toda porcentagem sair maior do que é.
 */
import { query, queryOne } from '../db/database';
import { lerTabelaFulfillment } from './previsao';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export interface Periodo {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

/** A empresa que vende o produto. client_id preenchido = ponte com um cliente da MailX. */
export interface Conta {
  id: number;
  nome: string;
  moeda: string;
  client_id: number | null;
}

/**
 * Produto do produtor. Os três nomes existem porque três sistemas escrevem o mesmo produto de
 * jeitos diferentes, e casar por semelhança atribuiria o custo de um produto ao outro.
 */
export interface Produto {
  id: number;
  conta_id: number;
  nome: string;
  nomes_na_venda: string[];
  nome_na_fatura: string | null;
  custo_unidade: number | null;
  kit_id: number | null;
}

/**
 * De onde vieram as vendas que a tela está mostrando.
 *
 * Precisa aparecer NA TELA, não só aqui: 'importado' é o export da Digistore da conta do produtor,
 * 'webhook' são as vendas que chegam pela MailX no cliente vinculado. São contas diferentes num
 * gateway diferente — apresentar as duas como "vendas" sem dizer qual é qual deixaria alguém
 * comparar dois períodos que vieram de fontes distintas sem perceber.
 */
export type OrigemVendas = 'importado' | 'webhook' | 'nenhuma';

export interface OfertaRow {
  id: number;
  conta_id: number;
  produto_id: number;
  nome: string;
  unidades: number;
  preco: number;
  taxa_gateway_pct: number;
  comissao_afiliado_pct: number;
  external_ids: string[];
  ativo: boolean;
  observacao: string | null;
}

export type CategoriaFatura =
  | 'produto'
  | 'frete'
  | 'produto_frete'
  | 'comissao_afiliado'
  | 'taxa_gateway'
  | 'outros';

export const CATEGORIAS_FATURA: CategoriaFatura[] = [
  'produto', 'frete', 'produto_frete', 'comissao_afiliado', 'taxa_gateway', 'outros',
];

export interface FaturaRow {
  id: number;
  conta_id: number;
  produto_id: number | null;
  fornecedor: string;
  numero: string | null;
  categoria: CategoriaFatura;
  competencia_inicio: string;
  competencia_fim: string;
  emitida_em: string | null;
  valor: number;
  moeda: string;
  unidades: number | null;
  arquivo_url: string | null;
  observacao: string | null;
}

/** Uma linha por (oferta, dia). oferta_id null = venda do produto que nenhuma oferta reconheceu. */
interface DiaRow {
  oferta_id: number | null;
  dia: string;
  vendas: number;
  receita: number;
  vendas_afiliado: number;
  receita_afiliado: number;
  reembolsos: number;
  valor_reembolso: number;
  /**
   * O que sobrou depois de imposto de venda e da parte da Digistore ("Your earnings").
   * null quando a fonte não traz — e aí o lucro cai para o bruto, ROTULADO como otimista.
   */
  receita_recebida: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura do cadastro
// ─────────────────────────────────────────────────────────────────────────────

function num(v: any): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Data em 'YYYY-MM-DD' venha ela como texto (SELECT com ::text) ou como Date (RETURNING *).
 *
 * O driver do Postgres devolve DATE como objeto Date do JS, e `String(date).slice(0,10)` produz
 * "Thu Jul 01" — data em inglês e sem ano, que é exatamente o defeito que já apareceu em produção
 * neste projeto com os retratos de lista. Aqui os dois caminhos existem de verdade: o GET casteia
 * para texto no SQL, o POST devolve o que o INSERT retornou.
 */
function dataTexto(v: any): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export function mapOferta(r: any): OfertaRow {
  return {
    id: r.id,
    conta_id: r.conta_id,
    produto_id: r.produto_id,
    nome: r.nome,
    unidades: parseInt(r.unidades, 10) || 0,
    preco: num(r.preco),
    taxa_gateway_pct: num(r.taxa_gateway_pct),
    comissao_afiliado_pct: num(r.comissao_afiliado_pct),
    external_ids: Array.isArray(r.external_ids) ? r.external_ids : [],
    ativo: r.ativo !== false,
    observacao: r.observacao ?? null,
  };
}

export async function listarOfertas(contaId: number, produtoId: number): Promise<OfertaRow[]> {
  const rows = await query(
    `SELECT * FROM produtor_ofertas WHERE conta_id = $1 AND produto_id = $2 ORDER BY preco DESC, id`,
    [contaId, produtoId]
  );
  return rows.map(mapOferta);
}

export function mapFatura(r: any): FaturaRow {
  return {
    id: r.id,
    conta_id: r.conta_id,
    produto_id: r.produto_id ?? null,
    fornecedor: r.fornecedor,
    numero: r.numero ?? null,
    categoria: r.categoria,
    competencia_inicio: dataTexto(r.competencia_inicio),
    competencia_fim: dataTexto(r.competencia_fim),
    emitida_em: r.emitida_em ? dataTexto(r.emitida_em) : null,
    valor: num(r.valor),
    moeda: r.moeda || 'USD',
    unidades: r.unidades == null ? null : parseInt(r.unidades, 10),
    arquivo_url: r.arquivo_url ?? null,
    observacao: r.observacao ?? null,
  };
}

export async function listarFaturas(contaId: number, produtoId: number): Promise<FaturaRow[]> {
  const rows = await query(
    `SELECT id, conta_id, produto_id, fornecedor, numero, categoria,
            competencia_inicio::text AS competencia_inicio,
            competencia_fim::text    AS competencia_fim,
            emitida_em::text         AS emitida_em,
            valor, moeda, unidades, arquivo_url, observacao
       FROM produtor_faturas
      WHERE conta_id = $1 AND produto_id = $2
      ORDER BY competencia_inicio DESC, id DESC`,
    [contaId, produtoId]
  );
  return rows.map(mapFatura);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendas do produto, casadas com as ofertas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agrega vendas e reembolsos do produto por (oferta, dia), VITALÍCIO.
 *
 * De propósito sem filtro de período no SQL: o recorte é feito depois, em memória, porque a mesma
 * agregação precisa ser fatiada por três janelas diferentes — o período da tela, a competência de
 * cada fatura, e os dias que ficaram sem fatura. Refazer a query para cada janela daria margem a
 * elas discordarem entre si. O GROUP BY reduz o resultado a (dias × ofertas), que é pequeno.
 */
async function agregarVendasPorDia(
  conta: Conta,
  produto: Produto
): Promise<{ dias: DiaRow[]; origem: OrigemVendas }> {
  // Mesma fonte da previsão do invoice.
  //
  // Sem isto, esta tela lia webhook_logs enquanto a previsão lia as vendas importadas — e como a
  // conta da Digistore do produto de casa não alimenta a MailX, o resultado era faturamento e
  // lucro em ZERO ao lado de uma previsão de vinte mil dólares, na mesma tela. Duas fontes para o
  // mesmo indicador é sempre ruim; com uma delas vazia, é uma tela que se desmente sozinha.
  const importadas = await agregarVendasImportadas(conta.id, produto);
  if (importadas) return { dias: importadas, origem: 'importado' };

  // Sem venda importada, só existe uma segunda fonte possível: os webhooks do cliente da MailX
  // com quem esta conta está vinculada. Sem ponte e sem kit, não há de onde tirar venda nenhuma —
  // e devolver lista vazia é o certo. O caminho antigo entrava aqui sempre, e era por isso que a
  // tela abria num cliente de SMS qualquer mostrando o faturamento dele como se fosse do produtor.
  if (conta.client_id == null || produto.kit_id == null) {
    return { dias: [], origem: 'nenhuma' };
  }

  const kit = await queryOne<{ name: string; external_id: string | null }>(
    `SELECT name, external_id FROM kits WHERE id = $1 AND client_id = $2`,
    [produto.kit_id, conta.client_id]
  );
  // A ponte pode ter sido desfeita do outro lado (apagaram o kit e o SET NULL zerou o vínculo, ou
  // o kit mudou de cliente). Nesse caso não há venda a mostrar, e inventar uma seria pior.
  if (!kit) return { dias: [], origem: 'nenhuma' };

  const rows = await query(`
    WITH oferta AS (
      SELECT id, preco, external_ids
        FROM produtor_ofertas
       WHERE conta_id = $1 AND produto_id = $2 AND ativo
    ),
    venda AS (
      SELECT w.id, w.created_at, w.total_price, w.product_external_id, w.affiliate_name, w.event_type
        FROM webhook_logs w
       WHERE w.client_id = $5
         AND w.event_type IN ('order.paid', 'order.refunded', 'order.chargeback')
         -- Venda paga usa o mesmo filtro de status dos KPIs do cliente. Reembolso e chargeback
         -- não têm esse status e ficariam de fora se a condição valesse para os três.
         AND (w.event_type <> 'order.paid' OR w.status IN ('processed', 'processing'))
         AND (
           w.product_external_id = $3
           OR LOWER(COALESCE(w.product_name, '')) = LOWER($4)
           -- Uma oferta pode apontar para um id que o kit não conhece (o gateway às vezes trata
           -- cada embalagem como produto separado). Sem isso, essas vendas sumiriam da conta.
           OR EXISTS (
             SELECT 1 FROM oferta o
              WHERE (COALESCE(array_length(o.external_ids, 1), 0) > 0
                     AND w.product_external_id = ANY(o.external_ids))
                 OR (COALESCE(array_length(o.external_ids, 1), 0) = 0
                     AND w.total_price IS NOT NULL
                     AND ROUND(w.total_price, 2) = ROUND(o.preco, 2))
           )
         )
    ),
    casada AS (
      SELECT v.*, m.oferta_id
        FROM venda v
        LEFT JOIN LATERAL (
          SELECT o.id AS oferta_id,
                 CASE WHEN COALESCE(array_length(o.external_ids, 1), 0) > 0
                       AND v.product_external_id = ANY(o.external_ids)
                      THEN 0 ELSE 1 END AS prioridade
            FROM oferta o
           WHERE (COALESCE(array_length(o.external_ids, 1), 0) > 0
                  AND v.product_external_id = ANY(o.external_ids))
              OR (COALESCE(array_length(o.external_ids, 1), 0) = 0
                  AND v.total_price IS NOT NULL
                  AND ROUND(v.total_price, 2) = ROUND(o.preco, 2))
           -- Casamento por id ganha do casamento por preço, e o empate cai no menor id: uma venda
           -- pertence a UMA oferta, sempre a mesma, em qualquer recálculo.
           ORDER BY prioridade, o.id
           LIMIT 1
        ) m ON true
    )
    SELECT
      oferta_id,
      created_at::date::text AS dia,
      COUNT(*) FILTER (WHERE event_type = 'order.paid') AS vendas,
      COALESCE(SUM(total_price) FILTER (WHERE event_type = 'order.paid'), 0) AS receita,
      COUNT(*) FILTER (
        WHERE event_type = 'order.paid'
          AND NULLIF(TRIM(COALESCE(affiliate_name, '')), '') IS NOT NULL
      ) AS vendas_afiliado,
      COALESCE(SUM(total_price) FILTER (
        WHERE event_type = 'order.paid'
          AND NULLIF(TRIM(COALESCE(affiliate_name, '')), '') IS NOT NULL
      ), 0) AS receita_afiliado,
      COUNT(*) FILTER (WHERE event_type IN ('order.refunded', 'order.chargeback')) AS reembolsos,
      COALESCE(SUM(ABS(total_price)) FILTER (
        WHERE event_type IN ('order.refunded', 'order.chargeback')
      ), 0) AS valor_reembolso
    FROM casada
    GROUP BY 1, 2
    ORDER BY 2
  `, [conta.id, produto.id, kit.external_id, kit.name, conta.client_id]);

  const dias = rows.map((r: any) => ({
    oferta_id: r.oferta_id == null ? null : Number(r.oferta_id),
    dia: String(r.dia).slice(0, 10),
    // O webhook só carrega o bruto (amount_brutto). Sem o recebido, o lucro usa o bruto e a tela
    // diz que está otimista — em vez de fingir precisão que a fonte não tem.
    receita_recebida: null,
    vendas: parseInt(r.vendas, 10) || 0,
    receita: num(r.receita),
    vendas_afiliado: parseInt(r.vendas_afiliado, 10) || 0,
    receita_afiliado: num(r.receita_afiliado),
    reembolsos: parseInt(r.reembolsos, 10) || 0,
    valor_reembolso: num(r.valor_reembolso),
  }));

  return { dias, origem: dias.length > 0 ? 'webhook' : 'nenhuma' };
}

/**
 * Agregação por (oferta, dia) a partir das vendas IMPORTADAS do export da Digistore.
 *
 * Devolve null quando não há importação nenhuma — aí quem chama tenta a segunda fonte, que são os
 * webhooks do cliente da MailX vinculado, quando existe vínculo.
 *
 * Duas diferenças em relação ao webhook, as duas com efeito no custo:
 *  - `quantidade` multiplica as unidades (comprar 2× a oferta de 6 potes são 12 potes na fatura);
 *  - o preço NÃO serve para casar a venda com a oferta quando existe id, porque o `Gross amount`
 *    da Digistore inclui imposto que muda por estado — no export real, a mesma oferta de 6 potes
 *    aparece a 234,00, 248,04, 248,27… Casar por preço aqui não encontraria quase nada.
 */
async function agregarVendasImportadas(contaId: number, produto: Produto): Promise<DiaRow[] | null> {
  const existe = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM produtor_vendas WHERE conta_id = $1`, [contaId]
  );
  if (!existe || parseInt(existe.n, 10) === 0) return null;

  // Todos os nomes por que este produto pode aparecer no export. O nome na fatura entra aqui
  // porque a Red Rock e a Digistore escrevem o mesmo produto diferente, e alguém pode ter
  // cadastrado só um dos dois.
  const nomes = [produto.nome, produto.nome_na_fatura, ...(produto.nomes_na_venda || [])]
    .filter((n): n is string => !!n && n.trim() !== '')
    .map(n => n.trim().toLowerCase());

  const rows = await query(`
    WITH oferta AS (
      SELECT id, preco, external_ids FROM produtor_ofertas
       WHERE conta_id = $1 AND produto_id = $2 AND ativo
    ),
    casada AS (
      SELECT v.*, m.oferta_id
        FROM produtor_vendas v
        LEFT JOIN LATERAL (
          SELECT o.id AS oferta_id,
                 CASE WHEN COALESCE(array_length(o.external_ids,1),0) > 0
                       AND v.gateway_produto_id = ANY(o.external_ids) THEN 0 ELSE 1 END AS prioridade
            FROM oferta o
           WHERE (COALESCE(array_length(o.external_ids,1),0) > 0 AND v.gateway_produto_id = ANY(o.external_ids))
              OR (COALESCE(array_length(o.external_ids,1),0) = 0 AND v.valor_bruto IS NOT NULL
                  AND ROUND(ABS(v.valor_bruto),2) = ROUND(o.preco,2))
           ORDER BY prioridade, o.id
           LIMIT 1
        ) m ON true
       WHERE v.conta_id = $1
         -- Só o que pertence a este produto: venda casada com uma oferta dele, ou venda cujo nome
         -- de produto é um dos nomes conhecidos dele. Sem esse recorte, a tela de um produto
         -- mostraria as vendas do outro.
         AND (m.oferta_id IS NOT NULL
              OR LOWER(TRIM(COALESCE(v.produto_nome, ''))) = ANY($3::text[]))
    )
    SELECT
      oferta_id,
      data::text AS dia,
      COALESCE(SUM(quantidade) FILTER (WHERE tipo = 'pagamento'), 0) AS vendas,
      COALESCE(SUM(valor_bruto) FILTER (WHERE tipo = 'pagamento'), 0) AS receita,
      SUM(valor_recebido) FILTER (WHERE tipo = 'pagamento') AS receita_recebida,
      COALESCE(SUM(quantidade) FILTER (
        WHERE tipo = 'pagamento' AND NULLIF(TRIM(COALESCE(afiliado,'')),'') IS NOT NULL), 0) AS vendas_afiliado,
      COALESCE(SUM(valor_bruto) FILTER (
        WHERE tipo = 'pagamento' AND NULLIF(TRIM(COALESCE(afiliado,'')),'') IS NOT NULL), 0) AS receita_afiliado,
      COUNT(*) FILTER (WHERE tipo IN ('reembolso','chargeback')) AS reembolsos,
      COALESCE(SUM(ABS(valor_bruto)) FILTER (WHERE tipo IN ('reembolso','chargeback')), 0) AS valor_reembolso
    FROM casada
    GROUP BY 1, 2
    ORDER BY 2
  `, [contaId, produto.id, nomes]);

  return rows.map((r: any) => ({
    oferta_id: r.oferta_id == null ? null : Number(r.oferta_id),
    dia: String(r.dia).slice(0, 10),
    vendas: parseInt(r.vendas, 10) || 0,
    receita: num(r.receita),
    receita_recebida: r.receita_recebida == null ? null : num(r.receita_recebida),
    vendas_afiliado: parseInt(r.vendas_afiliado, 10) || 0,
    receita_afiliado: num(r.receita_afiliado),
    reembolsos: parseInt(r.reembolsos, 10) || 0,
    valor_reembolso: num(r.valor_reembolso),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Recorte por janela
// ─────────────────────────────────────────────────────────────────────────────

function dentro(dia: string, janela: Periodo | null): boolean {
  if (!janela) return true;
  return dia >= janela.from && dia <= janela.to;
}

/** Dias cobertos por uma fatura, como conjunto de 'YYYY-MM-DD'. */
function diasDaFatura(f: FaturaRow): string[] {
  const dias: string[] = [];
  const fim = new Date(`${f.competencia_fim}T00:00:00Z`);
  const cursor = new Date(`${f.competencia_inicio}T00:00:00Z`);
  // Trava de sanidade: competência absurda (erro de digitação de ano) não pode virar um laço que
  // segura o event loop. Acima de ~5 anos a fatura é rejeitada no cadastro, isto aqui é a rede.
  let guarda = 0;
  while (cursor <= fim && guarda++ < 2000) {
    dias.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dias;
}

const COBRE_PRODUTO: CategoriaFatura[] = ['produto', 'produto_frete'];
const COBRE_FRETE: CategoriaFatura[] = ['frete', 'produto_frete'];
const FULFILLMENT: CategoriaFatura[] = ['produto', 'frete', 'produto_frete'];

// ─────────────────────────────────────────────────────────────────────────────
// O cálculo
// ─────────────────────────────────────────────────────────────────────────────

export interface LinhaOferta {
  oferta_id: number | null;
  nome: string;
  unidades: number | null;
  preco: number | null;
  vendas: number;
  receita: number;
  /** null quando a oferta não é conhecida — ausência de custo não é custo zero. */
  custo_previsto_unitario: number | null;
  custo_produto_previsto: number | null;
  frete_previsto: number | null;
  taxa_gateway: number | null;
  comissao_afiliado_estimada: number | null;
  vendas_afiliado: number;
  lucro_previsto: number | null;
  margem_prevista: number | null;
}

export interface ResumoProdutor {
  periodo: { from: string; to: string } | null;
  rotulo_periodo: string;
  moeda: string;

  produto: { id: number; nome: string };

  /**
   * De onde vieram as vendas deste resumo. A tela precisa dizer isto ao lado do faturamento:
   * 'importado' é o export da conta da Digistore do produtor, 'webhook' são as vendas que chegam
   * pela MailX no cliente vinculado, 'nenhuma' é não ter nenhuma das duas.
   */
  origem_vendas: OrigemVendas;

  faturamento: {
    total: number;
    vendas: number;
    coberto_por_oferta: number;
    vendas_cobertas: number;
    sem_oferta: number;
    vendas_sem_oferta: number;
    cobertura_pct: number | null;
    recebido: number | null;
    taxa_medida: boolean;
  };

  ofertas: LinhaOferta[];

  previsto: {
    custo_produto: number;
    frete: number;
    fulfillment: number;
    taxa_gateway: number;
    comissao_afiliado: number;
  };

  real: {
    /** null = nenhuma fatura lançada nesta categoria no período. Não é zero. */
    fulfillment: number | null;
    /**
     * Previsto SÓ dos dias cobertos pela fatura — o par correto do `fulfillment` acima.
     * null quando não há fatura. A diferença da tela sai destes dois, nunca do previsto do
     * período inteiro: janelas diferentes fazem custo maior parecer economia.
     */
    previsto_na_cobertura: number | null;
    comissao_afiliado: number | null;
    taxa_gateway: number | null;
    outros: number | null;
    dias_no_periodo: number | null;
    dias_com_fatura_produto: number | null;
    dias_com_fatura_frete: number | null;
    faturas_contidas: number;
    /** Faturas que só encostam na borda do período: listadas, nunca somadas. */
    faturas_parciais: Array<{
      id: number; fornecedor: string; numero: string | null; categoria: CategoriaFatura;
      competencia_inicio: string; competencia_fim: string; valor: number;
    }>;
  };

  /** Reconciliação fatura a fatura: previsto da janela DELA contra o que veio. */
  reconciliacao: Array<{
    id: number;
    fornecedor: string;
    numero: string | null;
    categoria: CategoriaFatura;
    competencia_inicio: string;
    competencia_fim: string;
    valor: number;
    unidades: number | null;
    previsto_na_janela: number | null;
    diferenca: number | null;
    diferenca_pct: number | null;
    custo_real_unitario: number | null;
    unidades_vendidas_na_janela: number;
    dentro_do_periodo: boolean;
  }>;

  reembolso: { valor: number; quantidade: number };

  resultado: {
    custo_fulfillment_usado: number;
    custo_fulfillment_origem: 'real' | 'previsto' | 'misto';
    taxa_gateway_usada: number;
    comissao_afiliado_usada: number;
    comissao_afiliado_medida: boolean;
    outros_custos: number;
    lucro: number;
    base_do_lucro: 'recebido' | 'bruto';
    margem_pct: number | null;
  };

  /** Ressalvas que a tela precisa estampar. Sem elas, os números afirmam mais do que sabem. */
  ressalvas: string[];
}

export async function calcularResumo(
  conta: Conta,
  produto: Produto,
  periodo: Periodo | null,
  moeda: string
): Promise<ResumoProdutor> {
  const [ofertas, faturas, vendasPorDia, tabela] = await Promise.all([
    listarOfertas(conta.id, produto.id),
    listarFaturas(conta.id, produto.id),
    agregarVendasPorDia(conta, produto),
    lerTabelaFulfillment(conta.id),
  ]);
  const dias = vendasPorDia.dias;

  // O custo do fulfillment não é da oferta: o pote custa o mesmo na oferta de 6, de 3 ou de 1
  // (isso é do PRODUTO, e por isso mora em produtor_produtos), e pick/taxa/embalagem/frete são
  // preços do FORNECEDOR, iguais para todas as ofertas. Foi o que as 12 faturas da Red Rock
  // mostraram.
  const custoProd = produto.custo_unidade != null ? { custo_unidade: produto.custo_unidade } : null;
  const custoUnidade = custoProd ? num(custoProd.custo_unidade) : 0;
  const t = tabela;
  /** Custo de fulfillment de UMA venda desta oferta: potes + pick + taxa + embalagem + frete. */
  const custoPorVenda = (o: OfertaRow) => ({
    produto: o.unidades * custoUnidade,
    servicos: t
      ? o.unidades * t.custo_pick_unidade + t.custo_pedido + t.custo_embalagem_pedido
        + (t.frete_pedido_tipico ?? 0)
      : 0,
  });

  const porId = new Map<number, OfertaRow>(ofertas.map(o => [o.id, o]));
  const ressalvas: string[] = [];

  if (!custoProd) {
    ressalvas.push(
      'Este produto não tem custo unitário cadastrado, então o custo de produto está entrando como ' +
      'zero e o lucro aparece MAIOR do que é. Cadastre o custo por unidade na tela de Produtor.'
    );
  }
  if (!tabela) {
    ressalvas.push(
      'A tabela de preços do fulfillment não foi cadastrada: pick, taxa por pedido, embalagem e ' +
      'frete não estão sendo descontados do lucro. Nas faturas reais isso é cerca de um terço do ' +
      'custo.'
    );
  }

  // ── Recorte do período ──
  const noPeriodo = dias.filter(d => dentro(d.dia, periodo));

  const acumulaPorOferta = (linhas: DiaRow[]) => {
    const acc = new Map<number | null, {
      vendas: number; receita: number; recebida: number | null;
      vendas_afiliado: number; receita_afiliado: number;
    }>();
    for (const l of linhas) {
      const e = acc.get(l.oferta_id) ?? { vendas: 0, receita: 0, recebida: null, vendas_afiliado: 0, receita_afiliado: 0 };
      e.vendas += l.vendas;
      e.receita += l.receita;
      if (l.receita_recebida != null) e.recebida = (e.recebida ?? 0) + l.receita_recebida;
      e.vendas_afiliado += l.vendas_afiliado;
      e.receita_afiliado += l.receita_afiliado;
      acc.set(l.oferta_id, e);
    }
    return acc;
  };

  const agregado = acumulaPorOferta(noPeriodo);

  // ── Linhas da tabela de ofertas ──
  const linhas: LinhaOferta[] = [];
  let previstoCustoProduto = 0;
  let previstoFrete = 0;
  let previstoTaxa = 0;
  let previstoComissao = 0;
  let receitaCoberta = 0;
  let receitaRecebida: number | null = null;
  let vendasCobertas = 0;
  let taxaMedida = false;

  for (const o of ofertas) {
    const a = agregado.get(o.id) ?? { vendas: 0, receita: 0, recebida: null, vendas_afiliado: 0, receita_afiliado: 0 };
    const cv = custoPorVenda(o);
    const custoProduto = cv.produto * a.vendas;
    const frete = cv.servicos * a.vendas;
    // Taxa MEDIDA quando o arquivo traz o recebido: é o bruto menos o que de fato caiu na conta,
    // transação por transação. O percentual cadastrado vira só o plano B — estimar 9,5% quando o
    // valor exato está no arquivo foi o mesmo padrão do crédito da SlickText, que estava 3x menor.
    const taxa = a.recebida != null ? a.receita - a.recebida : a.receita * (o.taxa_gateway_pct / 100);
    // Comissão só sobre a receita das vendas COM afiliado. Sobre o faturamento inteiro, cobraria
    // comissão de venda direta — e como afiliado tende a ser a maior fatia, o erro não pareceria
    // erro: só um lucro menor e plausível.
    const comissao = a.receita_afiliado * (o.comissao_afiliado_pct / 100);
    const lucro = a.receita - custoProduto - frete - taxa - comissao;

    previstoCustoProduto += custoProduto;
    previstoFrete += frete;
    previstoTaxa += taxa;
    previstoComissao += comissao;
    receitaCoberta += a.receita;
    if (a.recebida != null) { receitaRecebida = (receitaRecebida ?? 0) + a.recebida; taxaMedida = true; }
    vendasCobertas += a.vendas;

    linhas.push({
      oferta_id: o.id,
      nome: o.nome,
      unidades: o.unidades,
      preco: o.preco,
      vendas: a.vendas,
      receita: a.receita,
      custo_previsto_unitario: custoUnidade,
      custo_produto_previsto: custoProduto,
      frete_previsto: frete,
      taxa_gateway: taxa,
      comissao_afiliado_estimada: comissao,
      vendas_afiliado: a.vendas_afiliado,
      lucro_previsto: lucro,
      margem_prevista: a.receita > 0 ? lucro / a.receita : null,
    });
  }

  // ── Vendas que nenhuma oferta reconheceu ──
  const semOferta = agregado.get(null) ?? { vendas: 0, receita: 0, recebida: null, vendas_afiliado: 0, receita_afiliado: 0 };
  if (semOferta.vendas > 0) {
    linhas.push({
      oferta_id: null,
      nome: 'Vendas sem oferta cadastrada',
      unidades: null,
      preco: null,
      vendas: semOferta.vendas,
      receita: semOferta.receita,
      // null, não zero: não sabemos o custo destas vendas. Zero faria a margem delas parecer 100%.
      custo_previsto_unitario: null,
      custo_produto_previsto: null,
      frete_previsto: null,
      taxa_gateway: null,
      comissao_afiliado_estimada: null,
      vendas_afiliado: semOferta.vendas_afiliado,
      lucro_previsto: null,
      margem_prevista: null,
    });
    ressalvas.push(
      `${semOferta.vendas} venda(s) do produto não casaram com nenhuma oferta cadastrada. ` +
      `Elas entram no faturamento, mas ficam fora do lucro e da margem — o custo delas é desconhecido, ` +
      `não zero. Cadastre a oferta correspondente (ou informe o id do gateway) para elas entrarem na conta.`
    );
  }

  const receitaTotal = receitaCoberta + semOferta.receita;
  const vendasTotal = vendasCobertas + semOferta.vendas;

  // ── Faturas: contidas no período valem; parciais são listadas, nunca somadas ──
  const contidas = faturas.filter(f =>
    !periodo || (f.competencia_inicio >= periodo.from && f.competencia_fim <= periodo.to)
  );
  const parciais = periodo
    ? faturas.filter(f =>
        !contidas.includes(f) &&
        f.competencia_inicio <= periodo.to && f.competencia_fim >= periodo.from)
    : [];

  if (parciais.length > 0) {
    ressalvas.push(
      `${parciais.length} fatura(s) cobrem só parte do período mostrado e ficaram FORA da soma do ` +
      `custo real. Somá-las inteiras cobraria dias que não estão na tela; rateá-las por dia ` +
      `inventaria uma precisão que a fatura não tem. Escolha um período que contenha a competência ` +
      `delas para vê-las na conta.`
    );
  }

  const somaPorCategorias = (cats: CategoriaFatura[]): number | null => {
    const sel = contidas.filter(f => cats.includes(f.categoria));
    return sel.length === 0 ? null : sel.reduce((s, f) => s + f.valor, 0);
  };

  const realFulfillment = somaPorCategorias(FULFILLMENT);
  const realComissao = somaPorCategorias(['comissao_afiliado']);
  const realTaxa = somaPorCategorias(['taxa_gateway']);
  const realOutros = somaPorCategorias(['outros']);

  // ── Substituição por dia coberto ──
  const diasCobertosProduto = new Set<string>();
  const diasCobertosFrete = new Set<string>();
  const diasCobertosComissao = new Set<string>();
  const diasCobertosTaxa = new Set<string>();
  for (const f of contidas) {
    const ds = diasDaFatura(f).filter(d => dentro(d, periodo));
    if (COBRE_PRODUTO.includes(f.categoria)) ds.forEach(d => diasCobertosProduto.add(d));
    if (COBRE_FRETE.includes(f.categoria)) ds.forEach(d => diasCobertosFrete.add(d));
    if (f.categoria === 'comissao_afiliado') ds.forEach(d => diasCobertosComissao.add(d));
    if (f.categoria === 'taxa_gateway') ds.forEach(d => diasCobertosTaxa.add(d));
  }

  /** Previsto de um componente, restrito aos dias que a fatura NÃO cobre. */
  const previstoNaoCoberto = (
    componente: 'produto' | 'frete' | 'taxa' | 'comissao',
    cobertos: Set<string>
  ): number => {
    let total = 0;
    for (const l of noPeriodo) {
      if (l.oferta_id == null || cobertos.has(l.dia)) continue;
      const o = porId.get(l.oferta_id);
      if (!o) continue;
      if (componente === 'produto') total += custoPorVenda(o).produto * l.vendas;
      else if (componente === 'frete') total += custoPorVenda(o).servicos * l.vendas;
      else if (componente === 'taxa') total += l.receita * (o.taxa_gateway_pct / 100);
      else total += l.receita_afiliado * (o.comissao_afiliado_pct / 100);
    }
    return total;
  };

  const custoFulfillmentUsado =
    (realFulfillment ?? 0)
    + previstoNaoCoberto('produto', diasCobertosProduto)
    + previstoNaoCoberto('frete', diasCobertosFrete);

  /**
   * Previsto SÓ dos dias que a fatura cobre — é contra este número que o "veio mais caro ou mais
   * barato" pode ser calculado.
   *
   * Comparar a fatura com o previsto do período INTEIRO é a armadilha desta tela: uma fatura de
   * 01 a 22 num mês de 31 dias fica naturalmente menor que a previsão do mês, e a diferença sai
   * negativa — a tela anunciaria economia justamente quando o fornecedor cobrou mais caro. Foi o
   * que aconteceu: o topo dizia −$143,30 (abaixo do previsto) enquanto a reconciliação da mesma
   * fatura dizia +$113,20 (acima). Os dois olhavam janelas diferentes.
   */
  const previstoNaCobertura = realFulfillment == null ? null :
    (previstoCustoProduto - previstoNaoCoberto('produto', diasCobertosProduto))
    + (previstoFrete - previstoNaoCoberto('frete', diasCobertosFrete));

  const taxaUsada = (realTaxa ?? 0) + previstoNaoCoberto('taxa', diasCobertosTaxa);
  const comissaoUsada = (realComissao ?? 0) + previstoNaoCoberto('comissao', diasCobertosComissao);

  const diasNoPeriodo = periodo ? diasDaFatura({
    competencia_inicio: periodo.from, competencia_fim: periodo.to,
  } as FaturaRow).length : null;

  const cobreTudo = diasNoPeriodo != null
    && diasCobertosProduto.size >= diasNoPeriodo
    && diasCobertosFrete.size >= diasNoPeriodo;
  const origemCusto: 'real' | 'previsto' | 'misto' =
    realFulfillment == null ? 'previsto' : (cobreTudo ? 'real' : 'misto');

  if (origemCusto === 'previsto') {
    ressalvas.push(
      'Nenhuma fatura de fulfillment lançada para este período: o custo mostrado é PREVISÃO, ' +
      'não o que o fornecedor cobrou.'
    );
  } else if (origemCusto === 'misto') {
    ressalvas.push(
      `O custo é misto: fatura real nos dias cobertos por ela e previsão no restante ` +
      `(${diasCobertosProduto.size} de ${diasNoPeriodo ?? '?'} dia(s) com fatura de produto).`
    );
  }

  // ── Reconciliação fatura a fatura ──
  const reconciliacao = faturas.map(f => {
    const janela: Periodo = { from: f.competencia_inicio, to: f.competencia_fim };
    const naJanela = dias.filter(d => dentro(d.dia, janela) && d.oferta_id != null);

    let previsto = 0;
    let unidadesVendidas = 0;
    for (const l of naJanela) {
      const o = porId.get(l.oferta_id as number);
      if (!o) continue;
      unidadesVendidas += o.unidades * l.vendas;
      if (COBRE_PRODUTO.includes(f.categoria)) previsto += custoPorVenda(o).produto * l.vendas;
      if (COBRE_FRETE.includes(f.categoria)) previsto += custoPorVenda(o).servicos * l.vendas;
      if (f.categoria === 'taxa_gateway') previsto += l.receita * (o.taxa_gateway_pct / 100);
      if (f.categoria === 'comissao_afiliado') previsto += l.receita_afiliado * (o.comissao_afiliado_pct / 100);
    }

    // 'outros' não tem previsão correspondente — comparar contra zero inventaria uma diferença de
    // 100% que não quer dizer nada.
    const temPrevisto = f.categoria !== 'outros' && naJanela.length > 0;

    return {
      id: f.id,
      fornecedor: f.fornecedor,
      numero: f.numero,
      categoria: f.categoria,
      competencia_inicio: f.competencia_inicio,
      competencia_fim: f.competencia_fim,
      valor: f.valor,
      unidades: f.unidades,
      previsto_na_janela: temPrevisto ? previsto : null,
      diferenca: temPrevisto ? f.valor - previsto : null,
      diferenca_pct: temPrevisto && previsto > 0 ? (f.valor - previsto) / previsto : null,
      // O número que serve de sugestão para a próxima previsão. Só sai quando a fatura informa
      // unidades: sem elas, dividir pelo que foi VENDIDO misturaria estoque com venda.
      custo_real_unitario: f.unidades && f.unidades > 0 ? f.valor / f.unidades : null,
      unidades_vendidas_na_janela: unidadesVendidas,
      dentro_do_periodo: contidas.includes(f),
    };
  });

  // ── Reembolso ──
  const reembolsoValor = noPeriodo.reduce((s, d) => s + d.valor_reembolso, 0);
  const reembolsoQtd = noPeriodo.reduce((s, d) => s + d.reembolsos, 0);
  if (reembolsoQtd > 0) {
    ressalvas.push(
      'O reembolso tira a receita do lucro, mas o CUSTO do pedido reembolsado continua na conta: ' +
      'o pote já foi despachado. Se o fulfillment devolver esse custo, o lucro real é maior do que ' +
      'o mostrado aqui — a pergunta está em aberto com o fornecedor.'
    );
  }

  // ── Comissão de afiliado ──
  const vendasAfiliado = noPeriodo.reduce((s, d) => s + d.vendas_afiliado, 0);
  const comissaoMedida = realComissao != null;
  if (vendasAfiliado === 0) {
    ressalvas.push(
      'Nenhuma venda com afiliado no período — a comissão não entra no lucro porque não houve ' +
      'venda de afiliado, e não porque o valor seja desconhecido. Quando começar a rodar afiliado, ' +
      'basta preencher o percentual na oferta.'
    );
  } else if (!comissaoMedida) {
    ressalvas.push(
      `${vendasAfiliado} venda(s) com afiliado no período. A comissão descontada é ESTIMADA pelo ` +
      `percentual cadastrado na oferta — nenhuma fatura de comissão foi lançada para conferir.`
    );
  }

  const outrosCustos = realOutros ?? 0;

  // A base do lucro é o que ENTROU, não o que o comprador pagou. O bruto inclui imposto de venda
  // (que nunca foi do produtor) e a parte da Digistore. No export real de 939 vendas isso é 17,1%
  // do bruto — usar o bruto inflava o lucro em quase um terço.
  const baseLucro = receitaRecebida ?? receitaCoberta;
  if (receitaRecebida == null) {
    ressalvas.push(
      'A receita usada no lucro é o valor BRUTO, que inclui o imposto de venda e a parte do ' +
      'gateway — o lucro está OTIMISTA. O valor efetivamente recebido vem na coluna "Your ' +
      'earnings" do export da Digistore; importe o arquivo para o número ficar correto.'
    );
  }
  const lucro = baseLucro
    - custoFulfillmentUsado
    - (receitaRecebida != null ? 0 : taxaUsada)
    - comissaoUsada
    - outrosCustos
    - reembolsoValor;

  return {
    periodo: periodo ? { from: periodo.from, to: periodo.to } : null,
    rotulo_periodo: periodo ? `${periodo.from} a ${periodo.to}` : 'vitalício',
    moeda,
    produto: { id: produto.id, nome: produto.nome },
    origem_vendas: vendasPorDia.origem,

    faturamento: {
      total: receitaTotal,
      /** O que sobrou depois do imposto de venda e do gateway. null = a fonte não informa. */
      recebido: receitaRecebida,
      taxa_medida: taxaMedida,
      vendas: vendasTotal,
      coberto_por_oferta: receitaCoberta,
      vendas_cobertas: vendasCobertas,
      sem_oferta: semOferta.receita,
      vendas_sem_oferta: semOferta.vendas,
      // Sem faturamento não existe cobertura — 0/0 renderizado como 0% diria "nada coberto",
      // que é diferente de "não houve venda".
      cobertura_pct: receitaTotal > 0 ? receitaCoberta / receitaTotal : null,
    },

    ofertas: linhas,

    previsto: {
      custo_produto: previstoCustoProduto,
      frete: previstoFrete,
      fulfillment: previstoCustoProduto + previstoFrete,
      taxa_gateway: previstoTaxa,
      comissao_afiliado: previstoComissao,
    },

    real: {
      fulfillment: realFulfillment,
      previsto_na_cobertura: previstoNaCobertura,
      comissao_afiliado: realComissao,
      taxa_gateway: realTaxa,
      outros: realOutros,
      dias_no_periodo: diasNoPeriodo,
      dias_com_fatura_produto: realFulfillment == null ? null : diasCobertosProduto.size,
      dias_com_fatura_frete: realFulfillment == null ? null : diasCobertosFrete.size,
      faturas_contidas: contidas.length,
      faturas_parciais: parciais.map(f => ({
        id: f.id, fornecedor: f.fornecedor, numero: f.numero, categoria: f.categoria,
        competencia_inicio: f.competencia_inicio, competencia_fim: f.competencia_fim, valor: f.valor,
      })),
    },

    reconciliacao,

    reembolso: { valor: reembolsoValor, quantidade: reembolsoQtd },

    resultado: {
      custo_fulfillment_usado: custoFulfillmentUsado,
      custo_fulfillment_origem: origemCusto,
      taxa_gateway_usada: taxaUsada,
      comissao_afiliado_usada: comissaoUsada,
      comissao_afiliado_medida: comissaoMedida,
      outros_custos: outrosCustos,
      lucro,
      base_do_lucro: receitaRecebida != null ? 'recebido' : 'bruto',
      // Margem sobre a receita COBERTA, não sobre o faturamento do produto: dividir um lucro
      // parcial pelo faturamento inteiro produziria uma margem menor que a real, e ninguém
      // conseguiria explicar de onde veio a diferença.
      margem_pct: baseLucro > 0 ? lucro / baseLucro : null,
    },

    ressalvas,
  };
}
