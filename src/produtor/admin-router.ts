/**
 * Cadastro da aba Produtor (ofertas e faturas do fulfillment).
 *
 * Montado DENTRO do adminRouter, depois da autenticação — herda login, o 401 de API e a checagem
 * de banco sem duplicar nada disso. Router próprio, em módulo próprio, para a fronteira com a
 * MailX continuar visível: nada aqui lê ou escreve tabela de atribuição, UTM ou SMS.
 *
 * Sobre METRICS_ONLY: ele existe para impedir que o painel escreva na CONTA DO CLIENTE
 * (ActiveCampaign, SlickText) — efeito colateral fora daqui, que não dá para desfazer. Cadastrar
 * uma oferta ou lançar uma fatura escreve só em tabela nossa, e é a razão de ser desta tela. Se
 * fosse bloqueado por METRICS_ONLY, a funcionalidade nasceria desligada em produção, que é onde
 * ela precisa rodar. Por isso as escritas daqui NÃO passam por esse flag — de propósito.
 */
import express, { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { query, queryOne } from '../db/database';
import { logger } from '../utils/logger';
import {
  CATEGORIAS_FATURA, CategoriaFatura, calcularResumo, listarFaturas, listarOfertas,
  mapOferta, mapFatura,
} from './service';
import { preverInvoice, lerTabelaFulfillment } from './previsao';
import { parseExportDigistore } from './import-digistore';

const CTX = 'ProdutorAdmin';

export const produtorAdminRouter = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação
//
// Rigorosa de propósito. Um custo digitado errado não quebra nada visível: só faz a margem sair
// diferente do que é, e é o tipo de erro que ninguém encontra olhando a tela — encontra meses
// depois, comparando com o extrato.
// ─────────────────────────────────────────────────────────────────────────────

class ErroDeEntrada extends Error {}

function numero(valor: any, campo: string, opts: { min?: number; max?: number; inteiro?: boolean } = {}): number {
  const n = typeof valor === 'number' ? valor : parseFloat(String(valor ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new ErroDeEntrada(`"${campo}" precisa ser um número.`);
  if (opts.inteiro && !Number.isInteger(n)) throw new ErroDeEntrada(`"${campo}" precisa ser um número inteiro.`);
  if (opts.min != null && n < opts.min) throw new ErroDeEntrada(`"${campo}" não pode ser menor que ${opts.min}.`);
  if (opts.max != null && n > opts.max) throw new ErroDeEntrada(`"${campo}" não pode ser maior que ${opts.max}.`);
  return n;
}

function texto(valor: any, campo: string, max = 255): string {
  const s = String(valor ?? '').trim();
  if (!s) throw new ErroDeEntrada(`"${campo}" é obrigatório.`);
  if (s.length > max) throw new ErroDeEntrada(`"${campo}" passa de ${max} caracteres.`);
  return s;
}

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
function data(valor: any, campo: string): string {
  const s = String(valor ?? '').trim();
  if (!DATA_RE.test(s)) throw new ErroDeEntrada(`"${campo}" precisa estar no formato AAAA-MM-DD.`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ErroDeEntrada(`"${campo}" não é uma data válida.`);
  return s;
}

/** Lista de ids do gateway: aceita texto separado por vírgula ou array. */
function listaDeIds(valor: any): string[] {
  const bruto = Array.isArray(valor) ? valor : String(valor ?? '').split(',');
  const ids = bruto.map(v => String(v).trim()).filter(Boolean);
  if (ids.length > 50) throw new ErroDeEntrada('Máximo de 50 ids do gateway por oferta.');
  for (const id of ids) {
    if (id.length > 100) throw new ErroDeEntrada(`Id do gateway "${id.slice(0, 20)}…" é longo demais.`);
  }
  return [...new Set(ids)];
}

/** O produto pertence mesmo a este cliente? Sem isso, trocar o id na URL vira dado de outro. */
async function exigirKitDoCliente(clientId: number, kitId: number) {
  const kit = await queryOne<{ id: number; name: string; external_id: string | null }>(
    `SELECT id, name, external_id FROM kits WHERE id = $1 AND client_id = $2`,
    [kitId, clientId]
  );
  if (!kit) throw new ErroDeEntrada('Produto não encontrado para este cliente.');
  return kit;
}

function idNaRota(req: Request, nome: string): number {
  const n = parseInt(req.params[nome] as string, 10);
  if (!Number.isInteger(n) || n <= 0) throw new ErroDeEntrada('Identificador inválido.');
  return n;
}

/**
 * Moeda predominante do cliente. Mesma regra da tela de cliente, reescrita aqui de propósito:
 * a versão original é uma função não exportada dentro de admin/router.ts, e a instrução deste
 * trabalho é não encostar naquele arquivo (é onde vivem as queries da aba SMS). São seis linhas
 * de lookup de moeda, não uma definição de métrica — o risco de divergirem é o de uma delas
 * passar a considerar outra fonte, e nesse dia a tela mostra o símbolo errado, não o número.
 */
async function moedaDoCliente(clientId: number): Promise<string> {
  const dominante = await queryOne<{ currency: string }>(`
    SELECT currency FROM webhook_logs
     WHERE client_id = $1 AND currency IS NOT NULL
     GROUP BY currency ORDER BY COUNT(*) DESC LIMIT 1
  `, [clientId]);
  if (dominante?.currency) return dominante.currency;
  const c = await queryOne<{ default_currency: string }>(
    `SELECT default_currency FROM clients WHERE id = $1`, [clientId]
  );
  return c?.default_currency || 'USD';
}

// ─────────────────────────────────────────────────────────────────────────────
// Página
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/', (_req: Request, res: Response) => {
  const candidatos = [
    path.join(process.cwd(), 'src', 'admin', 'produtor.html'),
    path.join(__dirname, '..', 'admin', 'produtor.html'),
  ];
  const arquivo = candidatos.find(p => fs.existsSync(p));
  if (!arquivo) {
    logger.error(CTX, `produtor.html não encontrado. Procurado em: ${candidatos.join(' | ')}`);
    res.status(404).send('Página não encontrada');
    return;
  }
  res.type('html').send(fs.readFileSync(arquivo, 'utf-8'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Produtos disponíveis para o Produtor
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/clientes/:id/produtos', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  // Traz TODOS os produtos, com quantas vendas cada um tem. Filtrar pelos "habilitados" esconderia
  // justamente o produto que ainda não foi ligado e cujo custo alguém quer cadastrar.
  const rows = await query(`
    SELECT k.id, k.name, k.external_id, k.platform, k.enabled,
           COUNT(w.id) FILTER (WHERE w.event_type = 'order.paid') AS vendas,
           (SELECT COUNT(*) FROM produtor_ofertas o WHERE o.kit_id = k.id) AS ofertas
      FROM kits k
      LEFT JOIN webhook_logs w
        ON w.client_id = k.client_id
       AND (w.product_external_id = k.external_id OR LOWER(COALESCE(w.product_name,'')) = LOWER(k.name))
     WHERE k.client_id = $1
     GROUP BY k.id
     ORDER BY COUNT(w.id) DESC, k.name
  `, [clientId]);

  res.json(rows.map((r: any) => ({
    id: r.id,
    nome: r.name,
    external_id: r.external_id,
    plataforma: r.platform,
    habilitado: r.enabled,
    vendas: parseInt(r.vendas, 10) || 0,
    ofertas: parseInt(r.ofertas, 10) || 0,
  })));
}));

// ─────────────────────────────────────────────────────────────────────────────
// Ofertas
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/clientes/:id/kits/:kitId/ofertas', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const kitId = idNaRota(req, 'kitId');
  await exigirKitDoCliente(clientId, kitId);
  res.json(await listarOfertas(clientId, kitId));
}));

function corpoDaOferta(body: any) {
  return {
    nome: texto(body.nome, 'Nome da oferta'),
    unidades: numero(body.unidades, 'Potes', { min: 1, max: 1000, inteiro: true }),
    preco: numero(body.preco, 'Preço', { min: 0.01, max: 1000000 }),
    taxa_gateway_pct: numero(body.taxa_gateway_pct ?? 0, 'Taxa do gateway', { min: 0, max: 100 }),
    comissao_afiliado_pct: numero(body.comissao_afiliado_pct ?? 0, 'Comissão de afiliado', { min: 0, max: 100 }),
    external_ids: listaDeIds(body.external_ids),
    observacao: body.observacao ? String(body.observacao).slice(0, 2000) : null,
  };
}

produtorAdminRouter.post('/clientes/:id/kits/:kitId/ofertas', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const kitId = idNaRota(req, 'kitId');
  await exigirKitDoCliente(clientId, kitId);
  const o = corpoDaOferta(req.body);

  const rows = await query(
    `INSERT INTO produtor_ofertas (client_id, kit_id, nome, unidades, preco,
       taxa_gateway_pct, comissao_afiliado_pct, external_ids, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [clientId, kitId, o.nome, o.unidades, o.preco,
     o.taxa_gateway_pct, o.comissao_afiliado_pct, o.external_ids, o.observacao]
  );
  logger.info(CTX, `Oferta cadastrada: "${o.nome}" (cliente ${clientId}, produto ${kitId})`);
  // Mesma forma do GET: sem isso o POST devolveria preco "294.00" (string, como o Postgres manda)
  // e o GET devolveria 294 (número), e a tela teria que saber de onde veio cada objeto.
  res.status(201).json(mapOferta(rows[0]));
}));

produtorAdminRouter.patch('/clientes/:id/ofertas/:ofertaId', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const ofertaId = idNaRota(req, 'ofertaId');
  const o = corpoDaOferta(req.body);
  const ativo = req.body.ativo === undefined ? true : req.body.ativo !== false;

  const rows = await query(
    `UPDATE produtor_ofertas
        SET nome=$3, unidades=$4, preco=$5,
            taxa_gateway_pct=$6, comissao_afiliado_pct=$7, external_ids=$8, observacao=$9,
            ativo=$10, updated_at=NOW()
      WHERE id=$1 AND client_id=$2 RETURNING *`,
    [ofertaId, clientId, o.nome, o.unidades, o.preco,
     o.taxa_gateway_pct, o.comissao_afiliado_pct, o.external_ids, o.observacao, ativo]
  );
  if (rows.length === 0) throw new ErroDeEntrada('Oferta não encontrada para este cliente.');
  res.json(mapOferta(rows[0]));
}));

produtorAdminRouter.delete('/clientes/:id/ofertas/:ofertaId', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const ofertaId = idNaRota(req, 'ofertaId');
  const rows = await query(
    `DELETE FROM produtor_ofertas WHERE id=$1 AND client_id=$2 RETURNING id`, [ofertaId, clientId]
  );
  if (rows.length === 0) throw new ErroDeEntrada('Oferta não encontrada para este cliente.');
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Faturas do fulfillment
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/clientes/:id/kits/:kitId/faturas', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const kitId = idNaRota(req, 'kitId');
  await exigirKitDoCliente(clientId, kitId);
  res.json(await listarFaturas(clientId, kitId));
}));

produtorAdminRouter.post('/clientes/:id/kits/:kitId/faturas', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const kitId = idNaRota(req, 'kitId');
  await exigirKitDoCliente(clientId, kitId);

  const categoria = String(req.body.categoria ?? 'produto_frete') as CategoriaFatura;
  if (!CATEGORIAS_FATURA.includes(categoria)) {
    throw new ErroDeEntrada(`Categoria inválida. Use uma de: ${CATEGORIAS_FATURA.join(', ')}.`);
  }

  const inicio = data(req.body.competencia_inicio, 'Início da competência');
  const fim = data(req.body.competencia_fim, 'Fim da competência');
  if (inicio > fim) throw new ErroDeEntrada('O início da competência é depois do fim.');

  // Competência de anos: quase sempre erro de digitação no ano, e o estrago é silencioso — a
  // fatura passa a "cobrir" períodos inteiros e some a previsão de todos eles.
  const dias = (new Date(`${fim}T00:00:00Z`).getTime() - new Date(`${inicio}T00:00:00Z`).getTime())
    / 86400000 + 1;
  if (dias > 400) {
    throw new ErroDeEntrada(
      `A competência cobre ${Math.round(dias)} dias. Acima de 400 quase sempre é erro de ano ` +
      `na data — confira antes de lançar.`
    );
  }

  const valor = numero(req.body.valor, 'Valor', { min: 0.01, max: 100000000 });
  const unidades = req.body.unidades === '' || req.body.unidades == null
    ? null
    : numero(req.body.unidades, 'Unidades', { min: 1, max: 10000000, inteiro: true });

  try {
    const rows = await query(
      `INSERT INTO produtor_faturas (client_id, kit_id, fornecedor, numero, categoria,
         competencia_inicio, competencia_fim, emitida_em, valor, moeda, unidades,
         arquivo_url, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        clientId, kitId,
        texto(req.body.fornecedor, 'Fornecedor'),
        req.body.numero ? String(req.body.numero).trim().slice(0, 120) : null,
        categoria, inicio, fim,
        req.body.emitida_em ? data(req.body.emitida_em, 'Data de emissão') : null,
        valor,
        String(req.body.moeda || 'USD').toUpperCase().slice(0, 3),
        unidades,
        req.body.arquivo_url ? String(req.body.arquivo_url).slice(0, 2000) : null,
        req.body.observacao ? String(req.body.observacao).slice(0, 2000) : null,
      ]
    );
    logger.info(CTX, `Fatura lançada: ${req.body.fornecedor} ${req.body.numero ?? ''} (${inicio}..${fim}) = ${valor}`);
    res.status(201).json(mapFatura(rows[0]));
  } catch (err: any) {
    // 23505 = unique_violation. Lançar a mesma fatura duas vezes não aparece na tela: só faz o
    // custo real subir e a margem parecer pior. O índice recusa; aqui a mensagem explica.
    if (err?.code === '23505') {
      res.status(409).json({
        error: `A fatura ${req.body.numero} de ${req.body.fornecedor} já foi lançada. ` +
               `Se for outra fatura, use um número diferente.`,
      });
      return;
    }
    throw err;
  }
}));

produtorAdminRouter.delete('/clientes/:id/faturas/:faturaId', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const faturaId = idNaRota(req, 'faturaId');
  const rows = await query(
    `DELETE FROM produtor_faturas WHERE id=$1 AND client_id=$2 RETURNING id`, [faturaId, clientId]
  );
  if (rows.length === 0) throw new ErroDeEntrada('Fatura não encontrada para este cliente.');
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico: o que está realmente ligado?
//
// O ambiente de desenvolvimento não tem acesso ao banco de produção, então a única forma honesta
// de saber quais contas de gateway existem e quais produtos têm venda é perguntar ao próprio
// servidor de produção. Só leitura, e nenhum segredo sai daqui: das credenciais devolve apenas se
// existem e o tamanho, nunca o valor.
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/diagnostico/origens', asyncHandler(async (_req, res) => {
  const clientes = await query(`
    SELECT c.id, c.company_name, c.status, c.default_currency,
           (SELECT COUNT(*) FROM kits k WHERE k.client_id = c.id) AS produtos,
           (SELECT COUNT(*) FROM webhook_logs w
             WHERE w.client_id = c.id AND w.event_type = 'order.paid') AS vendas,
           (SELECT MIN(w.created_at)::date::text FROM webhook_logs w
             WHERE w.client_id = c.id AND w.event_type = 'order.paid') AS primeira_venda,
           (SELECT MAX(w.created_at)::date::text FROM webhook_logs w
             WHERE w.client_id = c.id AND w.event_type = 'order.paid') AS ultima_venda
      FROM clients c ORDER BY c.id
  `);

  const lojas = await query(`
    SELECT si.client_id, c.company_name, si.platform, si.shop_slug, si.status,
           si.display_name, si.created_at::date::text AS criada_em,
           (si.api_token IS NOT NULL AND si.api_token <> '') AS tem_credencial,
           LENGTH(COALESCE(si.api_token, '')) AS tamanho_credencial
      FROM store_integrations si
      LEFT JOIN clients c ON c.id = si.client_id
     ORDER BY si.platform, si.shop_slug
  `);

  // Produtos com venda de verdade, para saber se Divine Purity já chega por algum caminho.
  const produtos = await query(`
    SELECT k.client_id, c.company_name, k.id AS kit_id, k.name, k.platform, k.external_id,
           COUNT(w.id) FILTER (WHERE w.event_type = 'order.paid') AS vendas,
           MIN(w.created_at)::date::text AS primeira,
           MAX(w.created_at)::date::text AS ultima,
           (SELECT COUNT(*) FROM produtor_ofertas o WHERE o.kit_id = k.id) AS ofertas_cadastradas,
           EXISTS (SELECT 1 FROM produtor_custo_produto p WHERE p.kit_id = k.id) AS tem_custo
      FROM kits k
      LEFT JOIN clients c ON c.id = k.client_id
      LEFT JOIN webhook_logs w ON w.client_id = k.client_id
       AND (w.product_external_id = k.external_id OR LOWER(COALESCE(w.product_name,'')) = LOWER(k.name))
     GROUP BY k.id, c.company_name
     ORDER BY COUNT(w.id) DESC, k.name
     LIMIT 60
  `);

  // Nomes de produto que chegaram por webhook mas não viraram kit de ninguém.
  const nomesSoltos = await query(`
    SELECT product_name, source, COUNT(*) AS vendas,
           MIN(created_at)::date::text AS primeira, MAX(created_at)::date::text AS ultima
      FROM webhook_logs
     WHERE event_type = 'order.paid' AND product_name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM kits k WHERE LOWER(k.name) = LOWER(webhook_logs.product_name))
     GROUP BY product_name, source ORDER BY COUNT(*) DESC LIMIT 30
  `);

  res.json({
    leia_assim:
      'Cada conta de gateway é uma linha em lojas. A Digistore descobre de qual conta veio a ' +
      'venda testando a assinatura do IPN contra TODAS as passphrases cadastradas, então contas ' +
      'novas convivem com as existentes sem conflito. Credenciais não são devolvidas — só se ' +
      'existem e o tamanho.',
    clientes: clientes.map((c: any) => ({
      id: c.id, nome: c.company_name, status: c.status, moeda: c.default_currency,
      produtos: parseInt(c.produtos, 10), vendas: parseInt(c.vendas, 10),
      primeira_venda: c.primeira_venda, ultima_venda: c.ultima_venda,
    })),
    lojas: lojas.map((l: any) => ({
      cliente_id: l.client_id, cliente: l.company_name, plataforma: l.platform,
      identificador: l.shop_slug, apelido: l.display_name, status: l.status,
      criada_em: l.criada_em, tem_credencial: l.tem_credencial,
      tamanho_credencial: parseInt(l.tamanho_credencial, 10),
    })),
    produtos: produtos.map((p: any) => ({
      cliente: p.company_name, kit_id: p.kit_id, nome: p.name, plataforma: p.platform,
      external_id: p.external_id, vendas: parseInt(p.vendas, 10),
      primeira: p.primeira, ultima: p.ultima,
      ofertas_cadastradas: parseInt(p.ofertas_cadastradas, 10), tem_custo: p.tem_custo,
    })),
    produtos_sem_kit: nomesSoltos.map((n: any) => ({
      nome: n.product_name, origem: n.source, vendas: parseInt(n.vendas, 10),
      primeira: n.primeira, ultima: n.ultima,
    })),
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Tabela de preços do fulfillment e custo unitário por produto
//
// Ficam fora da oferta porque não são da oferta: o pote custa o mesmo na embalagem de 6, de 3 ou
// de 1 (é do PRODUTO), e pick/taxa/embalagem/frete são preços do FORNECEDOR, iguais para todas as
// ofertas. As 12 faturas da Red Rock mostram isso linha por linha.
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/clientes/:id/fulfillment', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const [tabela, custos] = await Promise.all([
    lerTabelaFulfillment(clientId),
    query(`SELECT c.kit_id, c.nome_na_fatura, c.custo_unidade, k.name AS produto
             FROM produtor_custo_produto c JOIN kits k ON k.id = c.kit_id
            WHERE c.client_id = $1 ORDER BY k.name`, [clientId]),
  ]);
  res.json({
    tabela,
    custos: custos.map((c: any) => ({
      kit_id: Number(c.kit_id), produto: c.produto, nome_na_fatura: c.nome_na_fatura,
      custo_unidade: parseFloat(c.custo_unidade),
    })),
  });
}));

produtorAdminRouter.put('/clientes/:id/fulfillment', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const b = req.body ?? {};

  const faixa = (campo: string, rot: string) =>
    b[campo] === '' || b[campo] == null ? null : numero(b[campo], rot, { min: 0, max: 100000 });
  const min = faixa('frete_pedido_min', 'Frete mínimo por pedido');
  const tip = faixa('frete_pedido_tipico', 'Frete típico por pedido');
  const max = faixa('frete_pedido_max', 'Frete máximo por pedido');
  // Faixa invertida produziria um "entre" que não contém o valor típico, e a tela mostraria um
  // intervalo que nega o próprio número do meio.
  if (min != null && tip != null && min > tip) throw new ErroDeEntrada('O frete mínimo é maior que o típico.');
  if (max != null && tip != null && max < tip) throw new ErroDeEntrada('O frete máximo é menor que o típico.');

  const rows = await query(
    `INSERT INTO produtor_fulfillment (client_id, fornecedor, custo_pick_unidade, custo_pedido,
       custo_embalagem_pedido, custo_devolucao, frete_pedido_min, frete_pedido_tipico,
       frete_pedido_max, fator_pedidos, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (client_id) DO UPDATE SET
       fornecedor = EXCLUDED.fornecedor,
       custo_pick_unidade = EXCLUDED.custo_pick_unidade,
       custo_pedido = EXCLUDED.custo_pedido,
       custo_embalagem_pedido = EXCLUDED.custo_embalagem_pedido,
       custo_devolucao = EXCLUDED.custo_devolucao,
       frete_pedido_min = EXCLUDED.frete_pedido_min,
       frete_pedido_tipico = EXCLUDED.frete_pedido_tipico,
       frete_pedido_max = EXCLUDED.frete_pedido_max,
       fator_pedidos = EXCLUDED.fator_pedidos,
       observacao = EXCLUDED.observacao,
       updated_at = NOW()
     RETURNING *`,
    [
      clientId,
      texto(b.fornecedor, 'Fornecedor'),
      numero(b.custo_pick_unidade ?? 0, 'Pick por unidade', { min: 0, max: 10000 }),
      numero(b.custo_pedido ?? 0, 'Taxa por pedido', { min: 0, max: 10000 }),
      numero(b.custo_embalagem_pedido ?? 0, 'Embalagem por pedido', { min: 0, max: 10000 }),
      numero(b.custo_devolucao ?? 0, 'Custo por devolução', { min: 0, max: 10000 }),
      min, tip, max,
      numero(b.fator_pedidos ?? 1, 'Pedidos por transação', { min: 0.01, max: 10 }),
      b.observacao ? String(b.observacao).slice(0, 2000) : null,
    ]
  );
  logger.info(CTX, `Tabela de fulfillment salva (cliente ${clientId})`);
  res.json(rows[0]);
}));

produtorAdminRouter.put('/clientes/:id/kits/:kitId/custo', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const kitId = idNaRota(req, 'kitId');
  await exigirKitDoCliente(clientId, kitId);
  const rows = await query(
    `INSERT INTO produtor_custo_produto (client_id, kit_id, nome_na_fatura, custo_unidade)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_id, kit_id) DO UPDATE SET
       nome_na_fatura = EXCLUDED.nome_na_fatura,
       custo_unidade = EXCLUDED.custo_unidade,
       updated_at = NOW()
     RETURNING *`,
    [
      clientId, kitId,
      // O nome como a Red Rock escreve. Sem o vínculo explícito, casar "Divine Purity" com
      // "Divine Purity Drops" por semelhança acertaria hoje e erraria no dia que aparecesse um
      // "Divine Purity Capsules" — e erraria calado.
      texto(req.body?.nome_na_fatura, 'Nome na fatura'),
      numero(req.body?.custo_unidade ?? 0, 'Custo por unidade', { min: 0, max: 100000 }),
    ]
  );
  res.json(rows[0]);
}));

// ─────────────────────────────────────────────────────────────────────────────
// Importação do export da Digistore
//
// O produto é de casa e a conta da Digistore dele não é a que alimenta a MailX, então
// webhook_logs não tem essas vendas. E o IPN, quando for ligado, só traz do dia da ligação em
// diante — as faturas da Red Rock que existem hoje são de maio a agosto. Sem o export, não há
// como comparar a previsão com nenhuma fatura que já chegou.
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.post(
  '/clientes/:id/importar',
  express.text({ type: '*/*', limit: '25mb' }),
  asyncHandler(async (req, res) => {
    const clientId = idNaRota(req, 'id');
    const conteudo = typeof req.body === 'string' ? req.body : '';
    if (conteudo.trim().length === 0) throw new ErroDeEntrada('O arquivo chegou vazio.');

    const nome = String(req.query.arquivo || 'export.csv').slice(0, 255);
    const r = parseExportDigistore(conteudo);
    if (r.vendas.length === 0) {
      res.status(400).json({
        error: 'Nenhuma venda foi reconhecida no arquivo.',
        avisos: r.avisos,
        colunas_encontradas: r.colunas_encontradas,
      });
      return;
    }

    const datas = r.vendas.map(v => v.data).sort();
    const imp = await query<{ id: number }>(
      `INSERT INTO produtor_importacoes (client_id, arquivo, linhas_lidas, periodo_inicio, periodo_fim, aviso)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [clientId, nome, r.linhas_lidas, datas[0], datas[datas.length - 1],
       r.avisos.length ? r.avisos.join(' | ') : null]
    );
    const importacaoId = imp[0].id;

    // ON CONFLICT DO NOTHING: reimportar o mesmo período é o caso NORMAL (o export vem por
    // intervalo e os intervalos se sobrepõem). Duplicar dobraria o invoice previsto e pareceria
    // crescimento — o índice por número de transação é o que impede.
    let gravadas = 0;
    for (const v of r.vendas) {
      const ins = await query(
        `INSERT INTO produtor_vendas (client_id, importacao_id, transacao_id, pedido_id, data,
           tipo, tipo_bruto, produto_id, produto_nome, quantidade, valor_bruto, moeda, pais, afiliado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (client_id, transacao_id, COALESCE(produto_id, '')) DO NOTHING
         RETURNING id`,
        [clientId, importacaoId, v.transacao_id, v.pedido_id, v.data, v.tipo, v.tipo_bruto,
         v.produto_id, v.produto_nome, v.quantidade, v.valor_bruto, v.moeda, v.pais, v.afiliado]
      );
      if (ins.length > 0) gravadas++;
    }
    const repetidas = r.vendas.length - gravadas;
    await query(
      `UPDATE produtor_importacoes SET linhas_gravadas = $2, linhas_repetidas = $3 WHERE id = $1`,
      [importacaoId, gravadas, repetidas]
    );

    // Produtos do arquivo que ainda não têm custo cadastrado: é o que faz a previsão sair menor
    // do que a fatura, e some se a tela não disser.
    const semCusto = await query<{ produto_nome: string; produto_id: string; vendas: string }>(
      `SELECT produto_nome, produto_id, COUNT(*) AS vendas
         FROM produtor_vendas v
        WHERE v.client_id = $1 AND v.importacao_id = $2 AND v.tipo = 'pagamento'
          AND NOT EXISTS (
            SELECT 1 FROM produtor_custo_produto c
             WHERE c.client_id = v.client_id AND LOWER(c.nome_na_fatura) = LOWER(v.produto_nome)
          )
        GROUP BY 1, 2 ORDER BY COUNT(*) DESC`,
      [clientId, importacaoId]
    );

    logger.info(CTX, `Importação: ${gravadas} gravadas, ${repetidas} repetidas (cliente ${clientId}, ${nome})`);
    res.json({
      importacao_id: importacaoId,
      arquivo: nome,
      linhas_lidas: r.linhas_lidas,
      vendas_reconhecidas: r.vendas.length,
      gravadas,
      repetidas,
      periodo: { de: datas[0], ate: datas[datas.length - 1] },
      colunas_encontradas: r.colunas_encontradas,
      avisos: r.avisos,
      produtos_sem_custo: semCusto.map(p => ({
        nome: p.produto_nome, produto_id: p.produto_id, vendas: parseInt(p.vendas, 10),
      })),
    });
  })
);

/**
 * Desfazer uma importação.
 *
 * Subir o arquivo errado é o erro mais fácil de cometer nesta tela — e sem desfazer, a saída seria
 * mexer no banco. Cada venda guarda de qual importação veio, então apagar é exato: some o que
 * aquele arquivo trouxe e nada mais. Venda que veio em DUAS importações (períodos sobrepostos)
 * pertence à primeira, então desfazer a segunda não a remove — o que é o certo.
 */
produtorAdminRouter.delete('/clientes/:id/importacoes/:impId', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const impId = idNaRota(req, 'impId');
  const apagadas = await query(
    `DELETE FROM produtor_vendas WHERE client_id = $1 AND importacao_id = $2 RETURNING id`,
    [clientId, impId]
  );
  const rows = await query(
    `DELETE FROM produtor_importacoes WHERE id = $1 AND client_id = $2 RETURNING arquivo`,
    [impId, clientId]
  );
  if (rows.length === 0) throw new ErroDeEntrada('Importação não encontrada para este cliente.');
  logger.info(CTX, `Importação ${impId} desfeita: ${apagadas.length} venda(s) removidas`);
  res.json({ ok: true, vendas_removidas: apagadas.length, arquivo: rows[0].arquivo });
}));

/**
 * Ofertas encontradas nas vendas importadas, prontas para cadastrar.
 *
 * O produtor tem 15 ofertas, e o dado para todas elas já está no arquivo: o Prd ID identifica a
 * oferta e a quantidade de potes está no próprio nome ("M3 - Divine Purity Drops (6 Bottles)").
 * Fazer a pessoa digitar 15 vezes o que o sistema já sabe é trabalho inventado — e cada digitação
 * é uma chance de errar um id e a venda deixar de casar.
 *
 * Não cria nada sozinho: devolve a lista para conferência. Cadastro automático que ninguém revisou
 * é pior que cadastro manual, porque o erro entra com cara de dado do sistema.
 */
produtorAdminRouter.get('/clientes/:id/ofertas-sugeridas', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const rows = await query<{
    produto_id: string; produto_nome: string; vendas: string; preco_mediano: string; ja_existe: boolean;
  }>(`
    SELECT v.produto_id, v.produto_nome,
           COUNT(*) AS vendas,
           -- Mediana, não média: o preço varia por imposto estadual em quase toda venda, e a média
           -- seria puxada pelos extremos. O preço aqui é só referência para quem confere — o
           -- casamento da venda é pelo Prd ID, que é exato.
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(v.valor_bruto)) AS preco_mediano,
           EXISTS (
             SELECT 1 FROM produtor_ofertas o
              WHERE o.client_id = v.client_id AND v.produto_id = ANY(o.external_ids)
           ) AS ja_existe
      FROM produtor_vendas v
     WHERE v.client_id = $1 AND v.tipo = 'pagamento' AND v.produto_id IS NOT NULL
     GROUP BY v.client_id, v.produto_id, v.produto_nome
     ORDER BY COUNT(*) DESC
  `, [clientId]);

  // Quantidade de potes tirada do próprio nome. Sem isso não dá para saber quantas unidades a
  // oferta despacha, que é o que multiplica o custo na fatura.
  const POTES = /\((\d+)\s*(?:bottles?|potes?|unidades?)\)/i;

  res.json(rows.map(r => {
    const m = (r.produto_nome || '').match(POTES);
    return {
      produto_id: r.produto_id,
      nome: r.produto_nome,
      vendas: parseInt(r.vendas, 10),
      preco_referencia: r.preco_mediano == null ? null : parseFloat(r.preco_mediano),
      // null e não 1: produto sem contagem no nome pode ser digital (não despacha nada) ou ter a
      // quantidade escrita de outro jeito. Chutar 1 faria o custo sair errado sem ninguém ver.
      unidades: m ? parseInt(m[1], 10) : null,
      ja_existe: r.ja_existe,
    };
  }));
}));

/** Cadastra de uma vez as ofertas conferidas na tela. */
produtorAdminRouter.post('/clientes/:id/ofertas-em-lote', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const itens = Array.isArray(req.body?.ofertas) ? req.body.ofertas : [];
  if (itens.length === 0) throw new ErroDeEntrada('Nenhuma oferta selecionada.');
  if (itens.length > 200) throw new ErroDeEntrada('Máximo de 200 ofertas por vez.');

  const criadas: any[] = [];
  const ignoradas: Array<{ nome: string; motivo: string }> = [];
  // Cada oferta traz o SEU produto. Um lote inteiro num produto só jogaria as ofertas do upsell
  // (DivineDetox) dentro do produto principal, e o custo por unidade sairia errado nas duas
  // pontas sem nada na tela denunciar.
  const kitsValidos = new Set(
    (await query<{ id: number }>(`SELECT id FROM kits WHERE client_id = $1`, [clientId])).map(k => k.id)
  );
  for (const it of itens) {
    const nome = String(it?.nome ?? '').trim().slice(0, 255);
    const unidades = parseInt(it?.unidades, 10);
    const produtoId = String(it?.produto_id ?? '').trim();
    const kitId = parseInt(it?.kit_id, 10);
    if (!nome || !produtoId) { ignoradas.push({ nome: nome || '(sem nome)', motivo: 'faltou nome ou id do gateway' }); continue; }
    if (!kitsValidos.has(kitId)) { ignoradas.push({ nome, motivo: 'produto não escolhido ou não pertence a este cliente' }); continue; }
    if (!Number.isInteger(unidades) || unidades < 1) {
      ignoradas.push({ nome, motivo: 'quantidade de unidades desconhecida — informe manualmente' });
      continue;
    }
    const rows = await query(
      `INSERT INTO produtor_ofertas (client_id, kit_id, nome, unidades, preco,
         taxa_gateway_pct, comissao_afiliado_pct, external_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [clientId, kitId, nome, unidades,
       Number.isFinite(parseFloat(it?.preco)) ? parseFloat(it.preco) : 0,
       Number.isFinite(parseFloat(it?.taxa_gateway_pct)) ? parseFloat(it.taxa_gateway_pct) : 0,
       0, [produtoId]]
    );
    criadas.push(mapOferta(rows[0]));
  }
  logger.info(CTX, `${criadas.length} oferta(s) cadastradas em lote (cliente ${clientId})`);
  res.status(201).json({ criadas, ignoradas });
}));

/** Nomes de produto vistos nas vendas e nas faturas — para não digitar de cabeça. */
produtorAdminRouter.get('/clientes/:id/sugestoes', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const [dasVendas, dasFaturas] = await Promise.all([
    query<{ nome: string }>(
      `SELECT DISTINCT produto_nome AS nome FROM produtor_vendas
        WHERE client_id = $1 AND produto_nome IS NOT NULL ORDER BY 1`, [clientId]),
    query<{ nome: string }>(
      `SELECT DISTINCT fornecedor AS nome FROM produtor_faturas WHERE client_id = $1 ORDER BY 1`, [clientId]),
  ]);
  res.json({
    produtos_nas_vendas: dasVendas.map(r => r.nome),
    fornecedores: dasFaturas.map(r => r.nome),
  });
}));

produtorAdminRouter.get('/clientes/:id/importacoes', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const rows = await query(
    `SELECT id, arquivo, linhas_lidas, linhas_gravadas, linhas_repetidas,
            periodo_inicio::text AS periodo_inicio, periodo_fim::text AS periodo_fim,
            aviso, created_at
       FROM produtor_importacoes WHERE client_id = $1 ORDER BY id DESC LIMIT 30`,
    [clientId]
  );
  res.json(rows);
}));

// ─────────────────────────────────────────────────────────────────────────────
// Previsão do invoice — escopo do CLIENTE, não de um produto
//
// A fatura da Red Rock cobra Divine Purity e Divine Detox na mesma folha. Prever olhando um
// produto de cada vez daria um número que nunca bateria com papel nenhum.
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/clientes/:id/previsao', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const periodo = from && to && DATA_QUERY_RE.test(from) && DATA_QUERY_RE.test(to) && from <= to
    ? { from, to }
    : null;
  res.json(await preverInvoice(clientId, periodo, await moedaDoCliente(clientId)));
}));

// ─────────────────────────────────────────────────────────────────────────────
// O resumo (previsto vs real, lucro)
// ─────────────────────────────────────────────────────────────────────────────

const DATA_QUERY_RE = /^\d{4}-\d{2}-\d{2}$/;

produtorAdminRouter.get('/clientes/:id/kits/:kitId/resumo', asyncHandler(async (req, res) => {
  const clientId = idNaRota(req, 'id');
  const kitId = idNaRota(req, 'kitId');
  const kit = await exigirKitDoCliente(clientId, kitId);

  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  // Sem from/to o resumo é VITALÍCIO, e o campo rotulo_periodo diz isso — todo número da tela
  // precisa declarar se é do período ou vitalício.
  const periodo = from && to && DATA_QUERY_RE.test(from) && DATA_QUERY_RE.test(to) && from <= to
    ? { from, to }
    : null;

  const moeda = await moedaDoCliente(clientId);
  res.json(await calcularResumo(clientId, kit, periodo, moeda));
}));

// ─────────────────────────────────────────────────────────────────────────────
// Erros de entrada viram 400 com a mensagem que a tela mostra ao usuário.
// Qualquer outro erro segue para o handler global (500), porque um erro que ninguém previu não
// deve ser apresentado como se fosse culpa de quem preencheu o formulário.
// ─────────────────────────────────────────────────────────────────────────────
produtorAdminRouter.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ErroDeEntrada) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
});
