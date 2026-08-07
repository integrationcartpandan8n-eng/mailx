/**
 * Leitura do export de transações da Digistore.
 *
 * Por que existe: a conta da Digistore do produto de casa não é a que alimenta a MailX, então
 * webhook_logs não tem essas vendas — e o IPN, quando for ligado, só traz do dia da ligação em
 * diante. As faturas da Red Rock que existem hoje são de maio a agosto: sem o export, não há
 * como comparar a previsão com nenhuma fatura que já chegou.
 *
 * O export também traz o que o webhook não traz e a previsão precisa: a QUANTIDADE de cada linha
 * e o PAÍS de destino.
 *
 * O parser é tolerante de propósito, porque o arquivo é de terceiro e já mudou de forma antes
 * (a Red Rock renomeou linhas da fatura no meio da série; presumir que a Digistore nunca fará o
 * mesmo seria otimismo). Cabeçalho é casado por nome normalizado, coluna que falta vira null em
 * vez de derrubar o arquivo inteiro, e o que não foi entendido volta como aviso na resposta.
 */

export interface VendaImportada {
  transacao_id: string;
  pedido_id: string | null;
  data: string;            // YYYY-MM-DD
  tipo: 'pagamento' | 'reembolso' | 'chargeback' | 'outro';
  tipo_bruto: string;
  produto_id: string | null;
  produto_nome: string | null;
  quantidade: number;
  valor_bruto: number | null;
  /** Bruto sem o imposto de venda. */
  valor_liquido: number | null;
  /** O que sobra depois da Digistore — a base honesta do lucro. */
  valor_recebido: number | null;
  moeda: string | null;
  pais: string | null;
  afiliado: string | null;
}

export interface ResultadoParse {
  vendas: VendaImportada[];
  linhas_lidas: number;
  colunas_encontradas: Record<string, string | null>;
  avisos: string[];
}

/** Divide uma linha CSV respeitando aspas. Aceita ; ou , como separador. */
function dividirLinha(linha: string, sep: string): string[] {
  const campos: string[] = [];
  let atual = '';
  let dentroDeAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      // "" dentro de aspas é uma aspa literal
      if (dentroDeAspas && linha[i + 1] === '"') { atual += '"'; i++; }
      else dentroDeAspas = !dentroDeAspas;
    } else if (c === sep && !dentroDeAspas) {
      campos.push(atual); atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

/**
 * Limpa o valor de uma célula.
 *
 * O export da Digistore escreve números como `="47.00"` — é a fórmula que o Excel usa para não
 * transformar o valor em data ou cortar zero à esquerda. Sem tirar isso, todo valor viraria NaN e
 * o faturamento sairia zerado sem nenhum erro aparecer.
 */
function limpar(v: string): string {
  let s = (v ?? '').trim();
  if (s.startsWith('="') && s.endsWith('"')) s = s.slice(2, -1);
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.trim();
}

function normalizar(s: string): string {
  return limpar(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Nomes aceitos para cada campo, em ordem de preferência. */
const COLUNAS: Record<string, string[]> = {
  data: ['date', 'data', 'orderdate'],
  hora: ['time', 'hora'],
  transacao: ['transactionid', 'transaction', 'idtransacao'],
  pedido: ['orderid', 'order', 'pedido'],
  tipo: ['transactiontype', 'type', 'tipo'],
  moeda: ['currency', 'moeda'],
  bruto: ['grossamount', 'gross', 'valorbruto', 'amount'],
  liquido: ['netamount', 'net', 'valorliquido'],
  recebido: ['yourearnings', 'earnings', 'seusganhos'],
  produtoId: ['prdid', 'productid', 'produtoid'],
  produtoNome: ['productname', 'produto', 'nomeproduto'],
  quantidade: ['quantity', 'qty', 'quantidade'],
  pais: ['country', 'pais'],
  afiliado: ['affiliate', 'afiliado'],
  addonIds: ['addonproductids'],
  addonNomes: ['addonproductnames'],
  addonQtds: ['addonquantities'],
};

/** Data: aceita MM/DD/AAAA (padrão do export) e AAAA-MM-DD. */
function parseData(v: string): string | null {
  const s = limpar(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, a, b, ano] = m;
  // O export da Digistore usa MM/DD/AAAA. Quando o primeiro número passa de 12 só pode ser dia,
  // e aí o arquivo está em DD/MM — tratar os dois evita ler 07/09 como setembro sem perceber.
  const mes = parseInt(a, 10) > 12 ? parseInt(b, 10) : parseInt(a, 10);
  const dia = parseInt(a, 10) > 12 ? parseInt(a, 10) : parseInt(b, 10);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function parseNumero(v: string): number | null {
  const s = limpar(v).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  // "1,234.56" (milhar com vírgula) vs "1234,56" (decimal com vírgula)
  const normalizado = s.includes(',') && s.includes('.')
    ? s.replace(/,/g, '')
    : s.replace(',', '.');
  const n = parseFloat(normalizado);
  return Number.isFinite(n) ? n : null;
}

/** Classifica o tipo da transação preservando o rótulo original. */
export function classificarTipo(bruto: string): VendaImportada['tipo'] {
  const t = normalizar(bruto);
  if (!t) return 'outro';
  // "refund request" é pedido de reembolso, ainda não efetivado — não pode tirar receita nem
  // gerar devolução, senão o mesmo pedido seria descontado duas vezes quando o refund sair.
  if (t.includes('refundrequest')) return 'outro';
  if (t.includes('refund')) return 'reembolso';
  if (t.includes('chargeback')) return 'chargeback';
  if (t.includes('payment') || t.includes('sale') || t.includes('pagamento')) return 'pagamento';
  return 'outro';
}

export function parseExportDigistore(conteudo: string): ResultadoParse {
  const avisos: string[] = [];
  const texto = conteudo.replace(/^﻿/, '');
  const linhas = texto.split(/\r?\n/).filter(l => l.trim() !== '');
  if (linhas.length < 2) {
    return { vendas: [], linhas_lidas: 0, colunas_encontradas: {}, avisos: ['O arquivo não tem linhas de dados.'] };
  }

  // Separador: o export usa ponto e vírgula, mas planilha reexportada costuma virar vírgula.
  const sep = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ';' : ',';

  const cabecalho = dividirLinha(linhas[0], sep).map(normalizar);
  const indice: Record<string, number> = {};
  const encontradas: Record<string, string | null> = {};
  for (const [campo, nomes] of Object.entries(COLUNAS)) {
    const i = cabecalho.findIndex(c => nomes.includes(c));
    indice[campo] = i;
    encontradas[campo] = i >= 0 ? dividirLinha(linhas[0], sep)[i].replace(/"/g, '').trim() : null;
  }

  for (const obrigatoria of ['data', 'tipo', 'produtoNome'] as const) {
    if (indice[obrigatoria] < 0) {
      avisos.push(
        `A coluna de ${obrigatoria} não foi encontrada no cabeçalho. Sem ela a importação não ` +
        `consegue montar a previsão — confira se o arquivo é o export de transações da Digistore.`
      );
    }
  }
  if (indice.recebido < 0) {
    avisos.push(
      'Sem a coluna "Your earnings": o lucro vai usar o valor BRUTO como receita, que inclui ' +
      'imposto de venda e a parte da Digistore. Nesse caso o lucro sai otimista e a tela avisa.'
    );
  }
  if (indice.quantidade < 0) {
    avisos.push('Sem coluna de quantidade: cada linha vai contar como 1 unidade, que subestima quem comprou mais de uma.');
  }

  const vendas: VendaImportada[] = [];
  let semData = 0;
  let semTransacao = 0;

  for (let li = 1; li < linhas.length; li++) {
    const campos = dividirLinha(linhas[li], sep);
    const val = (campo: string): string => {
      const i = indice[campo];
      return i >= 0 && i < campos.length ? limpar(campos[i]) : '';
    };

    const data = parseData(val('data'));
    if (!data) { semData++; continue; }

    const tipoBruto = val('tipo');
    const quantidade = Math.max(1, Math.round(parseNumero(val('quantidade')) ?? 1));

    // Sem número de transação não há como impedir importação repetida. Usar a linha inteira como
    // chave seria pior: qualquer reexport com uma coluna a mais viraria venda nova.
    const transacao = val('transacao') || val('pedido');
    if (!transacao) { semTransacao++; continue; }

    const base = {
      transacao_id: transacao,
      pedido_id: val('pedido') || null,
      data,
      tipo: classificarTipo(tipoBruto),
      tipo_bruto: tipoBruto || '(vazio)',
      valor_bruto: parseNumero(val('bruto')),
      valor_liquido: parseNumero(val('liquido')),
      valor_recebido: parseNumero(val('recebido')),
      moeda: (val('moeda') || null)?.slice(0, 3) ?? null,
      pais: val('pais') || null,
      afiliado: val('afiliado') || null,
    };

    vendas.push({
      ...base,
      produto_id: val('produtoId') || null,
      produto_nome: val('produtoNome') || null,
      quantidade,
    });

    // Upsell que vem como add-on na MESMA ordem. É a explicação para a fatura ter menos pedidos
    // do que transações: um pedido despachado, dois produtos dentro. Sem ler estas colunas, as
    // unidades do upsell sumiriam da previsão e o custo sairia menor do que a fatura.
    const addIds = val('addonIds').split(/[,|]/).map(s => s.trim()).filter(Boolean);
    const addNomes = val('addonNomes').split(/[,|]/).map(s => s.trim()).filter(Boolean);
    const addQtds = val('addonQtds').split(/[,|]/).map(s => s.trim()).filter(Boolean);
    for (let k = 0; k < Math.max(addIds.length, addNomes.length); k++) {
      const nome = addNomes[k] ?? null;
      const id = addIds[k] ?? null;
      if (!nome && !id) continue;
      vendas.push({
        ...base,
        produto_id: id,
        produto_nome: nome,
        quantidade: Math.max(1, Math.round(parseNumero(addQtds[k] ?? '1') ?? 1)),
      });
    }
  }

  if (semData > 0) avisos.push(`${semData} linha(s) ignoradas por não ter data legível.`);
  if (semTransacao > 0) {
    avisos.push(
      `${semTransacao} linha(s) ignoradas por não ter número de transação nem de pedido — sem ` +
      `essa chave, reimportar o arquivo duplicaria a venda.`
    );
  }

  const tipos = new Set(vendas.filter(v => v.tipo === 'outro').map(v => v.tipo_bruto));
  if (tipos.size > 0) {
    avisos.push(
      `Tipos de transação não classificados como venda, reembolso ou chargeback: ` +
      `${[...tipos].join(', ')}. Eles foram guardados mas não entram na previsão.`
    );
  }

  return { vendas, linhas_lidas: linhas.length - 1, colunas_encontradas: encontradas, avisos };
}
