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
  CATEGORIAS_FATURA, CategoriaFatura, Conta, Produto, calcularResumo, listarFaturas, listarOfertas,
  mapOferta, mapFatura,
} from './service';
import { preverInvoice, lerTabelaFulfillment } from './previsao';
import { parseExportDigistore } from './import-digistore';
import { ErroRedRock, RedRockClient } from './redrock-api';
import {
  PROVEDOR_REDROCK, apagarCredencial, custoReal, fretePorPais, historicoSync, lerCredencial,
  resumoCredencial, salvarCredencial, sincronizar,
} from './redrock-sync';

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
async function exigirProduto(contaId: number, produtoId: number): Promise<Produto> {
  const p = await queryOne<any>(
    `SELECT id, conta_id, nome, nomes_na_venda, nome_na_fatura, custo_unidade, kit_id
       FROM produtor_produtos WHERE id = $1 AND conta_id = $2`,
    [produtoId, contaId]
  );
  if (!p) throw new ErroDeEntrada('Produto não encontrado nesta conta.');
  return mapProduto(p);
}

function mapProduto(r: any): Produto {
  return {
    id: r.id,
    conta_id: r.conta_id,
    nome: r.nome,
    nomes_na_venda: Array.isArray(r.nomes_na_venda) ? r.nomes_na_venda : [],
    nome_na_fatura: r.nome_na_fatura ?? null,
    // null e não zero: "não cadastrado" e "custa nada" são coisas diferentes, e zero faria a
    // margem sair 100% sem nada na tela avisar.
    custo_unidade: r.custo_unidade == null ? null : parseFloat(r.custo_unidade),
    kit_id: r.kit_id ?? null,
  };
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
/**
 * A conta, com a ponte para a MailX. Toda rota começa por aqui.
 *
 * Existe como função e não como middleware para o erro sair com a mensagem certa: "conta não
 * encontrada" é diferente de "sem permissão", e a tela mostra as duas de jeitos diferentes.
 */
async function exigirConta(contaId: number): Promise<Conta> {
  const c = await queryOne<any>(
    `SELECT id, nome, moeda, client_id FROM produtor_contas WHERE id = $1`, [contaId]
  );
  if (!c) throw new ErroDeEntrada('Conta de produtor não encontrada.');
  return { id: c.id, nome: c.nome, moeda: c.moeda || 'USD', client_id: c.client_id ?? null };
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
// Clientes que têm (ou podem ter) dados de produtor
//
// Existe para a aba Produtor do dashboard poder escolher de quem é a tela sem depender das rotas
// de cliente da MailX. São seis linhas de leitura, e é de propósito que elas morem aqui: a aba
// nova não pode passar a ser mais um motivo para alguém mexer em admin/router.ts.
//
// Quem já tem oferta, venda ou fatura vem primeiro. Sem essa ordem, a lista abriria em ordem
// alfabética e o produtor de verdade ficaria no meio de clientes de SMS que nunca vão ter custo.
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/contas', asyncHandler(async (_req, res) => {
  const rows = await query(`
    SELECT c.id, c.nome, c.moeda, c.client_id, cl.company_name AS cliente_mailx,
           (SELECT COUNT(*) FROM produtor_produtos p WHERE p.conta_id = c.id) AS produtos,
           (SELECT COUNT(*) FROM produtor_ofertas  o WHERE o.conta_id = c.id) AS ofertas,
           (SELECT COUNT(*) FROM produtor_vendas   v WHERE v.conta_id = c.id) AS vendas,
           (SELECT COUNT(*) FROM produtor_faturas  f WHERE f.conta_id = c.id) AS faturas
      FROM produtor_contas c
      LEFT JOIN clients cl ON cl.id = c.client_id
     WHERE c.ativo
     ORDER BY c.nome
  `);
  res.json(rows.map((r: any) => ({
    id: r.id,
    nome: r.nome,
    moeda: r.moeda,
    // A ponte com a MailX, quando existe. cliente_mailx null com client_id preenchido não acontece
    // (o SET NULL zera os dois juntos), mas a tela trata os dois casos do mesmo jeito.
    cliente_id: r.client_id ?? null,
    cliente_mailx: r.cliente_mailx ?? null,
    produtos: parseInt(r.produtos, 10),
    configurado: (parseInt(r.ofertas, 10) + parseInt(r.vendas, 10) + parseInt(r.faturas, 10)) > 0,
  })));
}));

/**
 * Cria uma conta de produtor.
 *
 * Sem isto não havia como a DirectX existir na tela: a única forma de um produtor aparecer era ser
 * um cliente da MailX que já tinha kit criado por webhook — e a DirectX não é cliente e não vende
 * pela conta de gateway da MailX.
 */
produtorAdminRouter.post('/contas', asyncHandler(async (req, res) => {
  const nome = texto(req.body?.nome, 'Nome da conta');
  const moeda = String(req.body?.moeda ?? 'USD').trim().toUpperCase().slice(0, 3) || 'USD';
  const clienteId = req.body?.cliente_id == null || req.body.cliente_id === ''
    ? null
    : numero(req.body.cliente_id, 'Cliente da MailX', { inteiro: true, min: 1 });

  if (clienteId != null) await exigirClienteMailx(clienteId);

  const existe = await queryOne<{ id: number }>(
    `SELECT id FROM produtor_contas WHERE LOWER(nome) = LOWER($1)`, [nome]
  );
  if (existe) throw new ErroDeEntrada(`Já existe uma conta de produtor chamada "${nome}".`);

  const rows = await query(
    `INSERT INTO produtor_contas (nome, moeda, client_id) VALUES ($1,$2,$3) RETURNING *`,
    [nome, moeda, clienteId]
  );
  logger.info(CTX, `Conta de produtor criada: ${nome}`);
  res.status(201).json(rows[0]);
}));

/** Renomear a conta, trocar a moeda, ligar ou desligar a ponte com um cliente da MailX. */
produtorAdminRouter.patch('/contas/:id', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  await exigirConta(contaId);
  const b = req.body ?? {};

  const campos: string[] = [];
  const valores: any[] = [contaId];
  if (b.nome !== undefined) { campos.push(`nome = $${valores.push(texto(b.nome, 'Nome da conta'))}`); }
  if (b.moeda !== undefined) {
    campos.push(`moeda = $${valores.push(String(b.moeda).trim().toUpperCase().slice(0, 3) || 'USD')}`);
  }
  if (b.cliente_id !== undefined) {
    const cid = b.cliente_id == null || b.cliente_id === ''
      ? null
      : numero(b.cliente_id, 'Cliente da MailX', { inteiro: true, min: 1 });
    if (cid != null) {
      await exigirClienteMailx(cid);
      // Um cliente é ponte de no máximo uma conta: duas contas no mesmo cliente leriam as MESMAS
      // vendas por webhook e o faturamento apareceria dobrado, uma vez em cada conta.
      const ocupado = await queryOne<{ nome: string }>(
        `SELECT nome FROM produtor_contas WHERE client_id = $1 AND id <> $2`, [cid, contaId]
      );
      if (ocupado) throw new ErroDeEntrada(`Esse cliente da MailX já está vinculado à conta "${ocupado.nome}".`);
    }
    campos.push(`client_id = $${valores.push(cid)}`);
  }
  if (campos.length === 0) throw new ErroDeEntrada('Nada para alterar.');

  const rows = await query(
    `UPDATE produtor_contas SET ${campos.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    valores
  );
  res.json(rows[0]);
}));

/** Clientes da MailX disponíveis para a ponte. Só leitura, e é a única coisa que esta tela lê de lá. */
produtorAdminRouter.get('/clientes-mailx', asyncHandler(async (_req, res) => {
  const rows = await query(`
    SELECT c.id, c.company_name AS nome,
           (SELECT nome FROM produtor_contas pc WHERE pc.client_id = c.id) AS ja_vinculado_a
      FROM clients c ORDER BY c.company_name
  `);
  res.json(rows.map((r: any) => ({ id: r.id, nome: r.nome, ja_vinculado_a: r.ja_vinculado_a ?? null })));
}));

async function exigirClienteMailx(clienteId: number) {
  const c = await queryOne<{ id: number }>(`SELECT id FROM clients WHERE id = $1`, [clienteId]);
  if (!c) throw new ErroDeEntrada('Cliente da MailX não encontrado.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Produtos disponíveis para o Produtor
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/contas/:id/produtos', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  await exigirConta(contaId);
  const rows = await query(`
    SELECT p.id, p.nome, p.nomes_na_venda, p.nome_na_fatura, p.custo_unidade, p.kit_id,
           k.name AS kit_nome,
           (SELECT COUNT(*) FROM produtor_ofertas o WHERE o.produto_id = p.id) AS ofertas,
           -- Unidades vendidas por DUAS vias, porque as duas existem: a venda pode ter sido
           -- reconhecida por uma oferta (pelo id do gateway, que é o caminho exato) ou pelo nome
           -- do produto no export. Contar só pelo nome mostrava "0 unidade(s)" ao lado de uma
           -- tela com quarenta vendas, porque o nome no export ("M3 - Divine Purity Drops
           -- (6 Bottles)") nunca é o nome de casa.
           (SELECT COALESCE(SUM(v.quantidade), 0) FROM produtor_vendas v
             WHERE v.conta_id = p.conta_id AND v.tipo = 'pagamento'
               AND (
                 EXISTS (SELECT 1 FROM produtor_ofertas o
                          WHERE o.produto_id = p.id
                            AND v.gateway_produto_id = ANY(o.external_ids))
                 OR LOWER(TRIM(COALESCE(v.produto_nome, ''))) = ANY(
                      ARRAY(SELECT LOWER(TRIM(x)) FROM unnest(
                        ARRAY[p.nome] || ARRAY[COALESCE(p.nome_na_fatura, p.nome)] || p.nomes_na_venda
                      ) AS x WHERE TRIM(x) <> ''))
               )) AS unidades_vendidas
      FROM produtor_produtos p
      LEFT JOIN kits k ON k.id = p.kit_id
     WHERE p.conta_id = $1 AND p.ativo
     ORDER BY p.nome
  `, [contaId]);

  res.json(rows.map((r: any) => ({
    id: r.id,
    nome: r.nome,
    nomes_na_venda: Array.isArray(r.nomes_na_venda) ? r.nomes_na_venda : [],
    nome_na_fatura: r.nome_na_fatura ?? null,
    // null = não cadastrado. Zero seria "custa nada" e faria a margem sair 100%.
    custo_unidade: r.custo_unidade == null ? null : parseFloat(r.custo_unidade),
    // A ponte com o kit da MailX, quando existe. kit_nome vem junto para a tela poder dizer a QUAL
    // kit o produto está ligado, em vez de mostrar um número.
    kit_id: r.kit_id ?? null,
    kit_nome: r.kit_nome ?? null,
    ofertas: parseInt(r.ofertas, 10) || 0,
    unidades_vendidas: parseInt(r.unidades_vendidas, 10) || 0,
  })));
}));

/**
 * Cadastra um produto na conta.
 *
 * É o passo que faltava para uma conta de produtor existir sozinha. Antes, produto só nascia de um
 * webhook da MailX — o que nunca ia acontecer para a DirectX, cujas vendas chegam pelo export da
 * Digistore e pela Red Rock.
 */
produtorAdminRouter.post('/contas/:id/produtos', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  await exigirConta(contaId);
  const p = validarProduto(req.body);

  const existe = await queryOne<{ id: number }>(
    `SELECT id FROM produtor_produtos WHERE conta_id = $1 AND LOWER(nome) = LOWER($2)`,
    [contaId, p.nome]
  );
  if (existe) throw new ErroDeEntrada(`Esta conta já tem um produto chamado "${p.nome}".`);
  if (p.kit_id != null) await exigirKitDaPonte(contaId, p.kit_id);

  const rows = await query(
    `INSERT INTO produtor_produtos (conta_id, nome, nomes_na_venda, nome_na_fatura, custo_unidade, kit_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [contaId, p.nome, p.nomes_na_venda, p.nome_na_fatura, p.custo_unidade, p.kit_id]
  );
  logger.info(CTX, `Produto "${p.nome}" cadastrado (conta ${contaId})`);
  res.status(201).json(mapProduto(rows[0]));
}));

produtorAdminRouter.patch('/contas/:id/produtos/:produtoId', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const produtoId = idNaRota(req, 'produtoId');
  await exigirProduto(contaId, produtoId);
  const p = validarProduto(req.body);
  if (p.kit_id != null) await exigirKitDaPonte(contaId, p.kit_id);

  const rows = await query(
    `UPDATE produtor_produtos
        SET nome = $3, nomes_na_venda = $4, nome_na_fatura = $5, custo_unidade = $6, kit_id = $7,
            updated_at = NOW()
      WHERE id = $1 AND conta_id = $2 RETURNING *`,
    [produtoId, contaId, p.nome, p.nomes_na_venda, p.nome_na_fatura, p.custo_unidade, p.kit_id]
  );
  res.json(mapProduto(rows[0]));
}));

produtorAdminRouter.delete('/contas/:id/produtos/:produtoId', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const produtoId = idNaRota(req, 'produtoId');
  const ofertas = await query(
    `SELECT 1 FROM produtor_ofertas WHERE conta_id = $1 AND produto_id = $2`, [contaId, produtoId]
  );
  // Apagar o produto levaria as ofertas junto pelo CASCADE. Recusar e dizer quantas são é melhor
  // que apagar em silêncio o cadastro que alguém montou oferta por oferta.
  if (ofertas.length > 0) {
    throw new ErroDeEntrada(
      `Este produto tem ${ofertas.length} oferta(s) cadastrada(s). Apague as ofertas primeiro, ` +
      `ou o histórico delas iria junto sem aviso.`
    );
  }
  const rows = await query(
    `DELETE FROM produtor_produtos WHERE id = $1 AND conta_id = $2 RETURNING nome`,
    [produtoId, contaId]
  );
  if (rows.length === 0) throw new ErroDeEntrada('Produto não encontrado nesta conta.');
  res.json({ ok: true, nome: rows[0].nome });
}));

function validarProduto(body: any) {
  const nome = texto(body?.nome, 'Nome do produto');
  const nomeNaFatura = body?.nome_na_fatura == null || String(body.nome_na_fatura).trim() === ''
    ? null : String(body.nome_na_fatura).trim().slice(0, 255);
  const nomes = (Array.isArray(body?.nomes_na_venda)
    ? body.nomes_na_venda
    : String(body?.nomes_na_venda ?? '').split(','))
    .map((n: any) => String(n).trim()).filter(Boolean).slice(0, 30);
  // Custo ausente é NULL, não zero: a tela mostra "não cadastrado" e mantém o lucro fora do ar, em
  // vez de calcular uma margem de 100% que parece ótima e é falsa.
  const custo = body?.custo_unidade == null || String(body.custo_unidade).trim() === ''
    ? null : numero(body.custo_unidade, 'Custo por unidade', { min: 0, max: 100000 });
  const kitId = body?.kit_id == null || String(body.kit_id).trim() === ''
    ? null : numero(body.kit_id, 'Kit da MailX', { inteiro: true, min: 1 });
  return { nome, nome_na_fatura: nomeNaFatura, nomes_na_venda: [...new Set(nomes)], custo_unidade: custo, kit_id: kitId };
}

/** O kit tem que ser do cliente com quem ESTA conta faz ponte. Sem ponte, não há kit a vincular. */
async function exigirKitDaPonte(contaId: number, kitId: number) {
  const conta = await exigirConta(contaId);
  if (conta.client_id == null) {
    throw new ErroDeEntrada(
      'Para vincular um produto a um kit da MailX, a conta precisa antes estar ligada a um cliente.'
    );
  }
  const k = await queryOne<{ id: number }>(
    `SELECT id FROM kits WHERE id = $1 AND client_id = $2`, [kitId, conta.client_id]
  );
  if (!k) throw new ErroDeEntrada('Esse kit não pertence ao cliente vinculado a esta conta.');
}

/** Kits do cliente vinculado, para o seletor de ponte do produto. */
produtorAdminRouter.get('/contas/:id/kits-disponiveis', asyncHandler(async (req, res) => {
  const conta = await exigirConta(idNaRota(req, 'id'));
  if (conta.client_id == null) { res.json([]); return; }
  const rows = await query(
    `SELECT k.id, k.name AS nome,
            (SELECT p.nome FROM produtor_produtos p WHERE p.kit_id = k.id) AS ja_vinculado_a
       FROM kits k WHERE k.client_id = $1 ORDER BY k.name`,
    [conta.client_id]
  );
  res.json(rows);
}));

// ─────────────────────────────────────────────────────────────────────────────
// Ofertas
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/contas/:id/produtos/:produtoId/ofertas', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const produtoId = idNaRota(req, 'produtoId');
  await exigirProduto(contaId, produtoId);
  res.json(await listarOfertas(contaId, produtoId));
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

produtorAdminRouter.post('/contas/:id/produtos/:produtoId/ofertas', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const produtoId = idNaRota(req, 'produtoId');
  await exigirProduto(contaId, produtoId);
  const o = corpoDaOferta(req.body);

  const rows = await query(
    `INSERT INTO produtor_ofertas (conta_id, produto_id, nome, unidades, preco,
       taxa_gateway_pct, comissao_afiliado_pct, external_ids, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [contaId, produtoId, o.nome, o.unidades, o.preco,
     o.taxa_gateway_pct, o.comissao_afiliado_pct, o.external_ids, o.observacao]
  );
  logger.info(CTX, `Oferta cadastrada: "${o.nome}" (conta ${contaId}, produto ${produtoId})`);
  // Mesma forma do GET: sem isso o POST devolveria preco "294.00" (string, como o Postgres manda)
  // e o GET devolveria 294 (número), e a tela teria que saber de onde veio cada objeto.
  res.status(201).json(mapOferta(rows[0]));
}));

produtorAdminRouter.patch('/contas/:id/ofertas/:ofertaId', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const ofertaId = idNaRota(req, 'ofertaId');
  const o = corpoDaOferta(req.body);
  const ativo = req.body.ativo === undefined ? true : req.body.ativo !== false;

  const rows = await query(
    `UPDATE produtor_ofertas
        SET nome=$3, unidades=$4, preco=$5,
            taxa_gateway_pct=$6, comissao_afiliado_pct=$7, external_ids=$8, observacao=$9,
            ativo=$10, updated_at=NOW()
      WHERE id=$1 AND conta_id=$2 RETURNING *`,
    [ofertaId, contaId, o.nome, o.unidades, o.preco,
     o.taxa_gateway_pct, o.comissao_afiliado_pct, o.external_ids, o.observacao, ativo]
  );
  if (rows.length === 0) throw new ErroDeEntrada('Oferta não encontrada para este cliente.');
  res.json(mapOferta(rows[0]));
}));

produtorAdminRouter.delete('/contas/:id/ofertas/:ofertaId', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const ofertaId = idNaRota(req, 'ofertaId');
  const rows = await query(
    `DELETE FROM produtor_ofertas WHERE id=$1 AND conta_id=$2 RETURNING id`, [ofertaId, contaId]
  );
  if (rows.length === 0) throw new ErroDeEntrada('Oferta não encontrada para este cliente.');
  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Faturas do fulfillment
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/contas/:id/produtos/:produtoId/faturas', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const produtoId = idNaRota(req, 'produtoId');
  await exigirProduto(contaId, produtoId);
  res.json(await listarFaturas(contaId, produtoId));
}));

produtorAdminRouter.post('/contas/:id/produtos/:produtoId/faturas', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const produtoId = idNaRota(req, 'produtoId');
  await exigirProduto(contaId, produtoId);

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
      `INSERT INTO produtor_faturas (conta_id, produto_id, fornecedor, numero, categoria,
         competencia_inicio, competencia_fim, emitida_em, valor, moeda, unidades,
         arquivo_url, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        contaId, produtoId,
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

produtorAdminRouter.delete('/contas/:id/faturas/:faturaId', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const faturaId = idNaRota(req, 'faturaId');
  const rows = await query(
    `DELETE FROM produtor_faturas WHERE id=$1 AND conta_id=$2 RETURNING id`, [faturaId, contaId]
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
           (SELECT COUNT(*) FROM produtor_produtos pp
             WHERE pp.kit_id = k.id) AS produtos_de_produtor_ligados,
           EXISTS (SELECT 1 FROM produtor_produtos pp
                    WHERE pp.kit_id = k.id AND pp.custo_unidade IS NOT NULL) AS tem_custo
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
      produtos_de_produtor_ligados: parseInt(p.produtos_de_produtor_ligados, 10),
      tem_custo: p.tem_custo,
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

produtorAdminRouter.get('/contas/:id/fulfillment', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const [tabela, custos] = await Promise.all([
    lerTabelaFulfillment(contaId),
    query(`SELECT p.id AS produto_id, p.nome_na_fatura, p.custo_unidade, p.nome AS produto
             FROM produtor_produtos p
            WHERE p.conta_id = $1 AND p.custo_unidade IS NOT NULL
            ORDER BY p.nome`, [contaId]),
  ]);
  res.json({
    tabela,
    custos: custos.map((c: any) => ({
      produto_id: Number(c.produto_id), produto: c.produto, nome_na_fatura: c.nome_na_fatura,
      custo_unidade: parseFloat(c.custo_unidade),
    })),
  });
}));

produtorAdminRouter.put('/contas/:id/fulfillment', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
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
    `INSERT INTO produtor_fulfillment (conta_id, fornecedor, custo_pick_unidade, custo_pedido,
       custo_embalagem_pedido, custo_devolucao, frete_pedido_min, frete_pedido_tipico,
       frete_pedido_max, fator_pedidos, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (conta_id) DO UPDATE SET
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
      contaId,
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
  logger.info(CTX, `Tabela de fulfillment salva (conta ${contaId})`);
  res.json(rows[0]);
}));

/**
 * Custo por unidade do produto.
 *
 * Rota própria, e não só o PATCH do produto, porque é um passo do cadastro guiado e a tela precisa
 * poder salvar só isto sem reenviar o resto (e sem risco de apagar o nome na fatura ao fazê-lo).
 */
produtorAdminRouter.put('/contas/:id/produtos/:produtoId/custo', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const produtoId = idNaRota(req, 'produtoId');
  await exigirProduto(contaId, produtoId);
  const rows = await query(
    `UPDATE produtor_produtos
        SET nome_na_fatura = $3, custo_unidade = $4, updated_at = NOW()
      WHERE id = $2 AND conta_id = $1 RETURNING *`,
    [
      contaId, produtoId,
      // O nome como a Red Rock escreve. Sem o vínculo explícito, casar "Divine Purity" com
      // "Divine Purity Drops" por semelhança acertaria hoje e erraria no dia que aparecesse um
      // "Divine Purity Capsules" — e erraria calado.
      texto(req.body?.nome_na_fatura, 'Nome na fatura'),
      numero(req.body?.custo_unidade ?? 0, 'Custo por unidade', { min: 0, max: 100000 }),
    ]
  );
  res.json(mapProduto(rows[0]));
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
  '/contas/:id/importar',
  express.text({ type: '*/*', limit: '25mb' }),
  asyncHandler(async (req, res) => {
    const contaId = idNaRota(req, 'id');
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
      `INSERT INTO produtor_importacoes (conta_id, arquivo, linhas_lidas, periodo_inicio, periodo_fim, aviso)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [contaId, nome, r.linhas_lidas, datas[0], datas[datas.length - 1],
       r.avisos.length ? r.avisos.join(' | ') : null]
    );
    const importacaoId = imp[0].id;

    // ON CONFLICT DO NOTHING: reimportar o mesmo período é o caso NORMAL (o export vem por
    // intervalo e os intervalos se sobrepõem). Duplicar dobraria o invoice previsto e pareceria
    // crescimento — o índice por número de transação é o que impede.
    let gravadas = 0;
    for (const v of r.vendas) {
      const ins = await query(
        `INSERT INTO produtor_vendas (conta_id, importacao_id, transacao_id, pedido_id, data,
           tipo, tipo_bruto, gateway_produto_id, produto_nome, quantidade, valor_bruto, valor_liquido,
           valor_recebido, moeda, pais, afiliado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (conta_id, transacao_id, COALESCE(gateway_produto_id, '')) DO NOTHING
         RETURNING id`,
        [contaId, importacaoId, v.transacao_id, v.pedido_id, v.data, v.tipo, v.tipo_bruto,
         v.gateway_produto_id, v.produto_nome, v.quantidade, v.valor_bruto, v.valor_liquido,
         v.valor_recebido, v.moeda, v.pais, v.afiliado]
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
    const semCusto = await query<{ produto_nome: string; gateway_produto_id: string; vendas: string }>(
      `SELECT produto_nome, gateway_produto_id, COUNT(*) AS vendas
         FROM produtor_vendas v
        WHERE v.conta_id = $1 AND v.importacao_id = $2 AND v.tipo = 'pagamento'
          AND NOT EXISTS (
            SELECT 1 FROM produtor_produtos p
             WHERE p.conta_id = v.conta_id AND p.custo_unidade IS NOT NULL
               AND LOWER(TRIM(COALESCE(v.produto_nome, ''))) = ANY(
                     ARRAY(SELECT LOWER(TRIM(x)) FROM unnest(
                       ARRAY[p.nome] || ARRAY[COALESCE(p.nome_na_fatura, p.nome)] || p.nomes_na_venda
                     ) AS x WHERE TRIM(x) <> ''))
          )
        GROUP BY 1, 2 ORDER BY COUNT(*) DESC`,
      [contaId, importacaoId]
    );

    logger.info(CTX, `Importação: ${gravadas} gravadas, ${repetidas} repetidas (conta ${contaId}, ${nome})`);
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
        nome: p.produto_nome, gateway_id: p.gateway_produto_id, vendas: parseInt(p.vendas, 10),
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
produtorAdminRouter.delete('/contas/:id/importacoes/:impId', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const impId = idNaRota(req, 'impId');
  const apagadas = await query(
    `DELETE FROM produtor_vendas WHERE conta_id = $1 AND importacao_id = $2 RETURNING id`,
    [contaId, impId]
  );
  const rows = await query(
    `DELETE FROM produtor_importacoes WHERE id = $1 AND conta_id = $2 RETURNING arquivo`,
    [impId, contaId]
  );
  if (rows.length === 0) throw new ErroDeEntrada('Importação não encontrada nesta conta.');
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
produtorAdminRouter.get('/contas/:id/ofertas-sugeridas', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const rows = await query<{
    gateway_produto_id: string; produto_nome: string; vendas: string; preco_mediano: string; ja_existe: boolean;
  }>(`
    SELECT v.gateway_produto_id, v.produto_nome,
           COUNT(*) AS vendas,
           -- Mediana, não média: o preço varia por imposto estadual em quase toda venda, e a média
           -- seria puxada pelos extremos. O preço aqui é só referência para quem confere — o
           -- casamento da venda é pelo Prd ID, que é exato.
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(v.valor_bruto)) AS preco_mediano,
           EXISTS (
             SELECT 1 FROM produtor_ofertas o
              WHERE o.conta_id = v.conta_id AND v.gateway_produto_id = ANY(o.external_ids)
           ) AS ja_existe
      FROM produtor_vendas v
     WHERE v.conta_id = $1 AND v.tipo = 'pagamento' AND v.gateway_produto_id IS NOT NULL
     GROUP BY v.conta_id, v.gateway_produto_id, v.produto_nome
     ORDER BY COUNT(*) DESC
  `, [contaId]);

  // Quantidade de potes tirada do próprio nome. Sem isso não dá para saber quantas unidades a
  // oferta despacha, que é o que multiplica o custo na fatura.
  const POTES = /\((\d+)\s*(?:bottles?|potes?|unidades?)\)/i;

  res.json(rows.map(r => {
    const m = (r.produto_nome || '').match(POTES);
    return {
      // gateway_id, não produto_id: este é o "Prd ID" da Digistore, que vai para external_ids da
      // oferta. O produto DESTA conta é escolhido na tela, e vai separado no envio em lote.
      gateway_id: r.gateway_produto_id,
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
produtorAdminRouter.post('/contas/:id/ofertas-em-lote', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const itens = Array.isArray(req.body?.ofertas) ? req.body.ofertas : [];
  if (itens.length === 0) throw new ErroDeEntrada('Nenhuma oferta selecionada.');
  if (itens.length > 200) throw new ErroDeEntrada('Máximo de 200 ofertas por vez.');

  const criadas: any[] = [];
  const ignoradas: Array<{ nome: string; motivo: string }> = [];
  // Cada oferta traz o SEU produto. Um lote inteiro num produto só jogaria as ofertas do upsell
  // (DivineDetox) dentro do produto principal, e o custo por unidade sairia errado nas duas
  // pontas sem nada na tela denunciar.
  const produtosValidos = new Set(
    (await query<{ id: number }>(`SELECT id FROM produtor_produtos WHERE conta_id = $1`, [contaId])).map(p => p.id)
  );
  for (const it of itens) {
    const nome = String(it?.nome ?? '').trim().slice(0, 255);
    const unidades = parseInt(it?.unidades, 10);
    // Dois ids diferentes na mesma linha: o do GATEWAY (texto, veio do export e é o que casa a
    // venda) e o do PRODUTO desta conta (inteiro, escolhido na tela). Nomes distintos de propósito
    // — trocar um pelo outro casaria tudo com nada, em silêncio.
    const gatewayId = String(it?.gateway_id ?? '').trim();
    const produtoId = parseInt(it?.produto_id, 10);
    if (!nome || !gatewayId) { ignoradas.push({ nome: nome || '(sem nome)', motivo: 'faltou nome ou id do gateway' }); continue; }
    if (!produtosValidos.has(produtoId)) { ignoradas.push({ nome, motivo: 'produto não escolhido ou não pertence a esta conta' }); continue; }
    if (!Number.isInteger(unidades) || unidades < 1) {
      ignoradas.push({ nome, motivo: 'quantidade de unidades desconhecida — informe manualmente' });
      continue;
    }
    const rows = await query(
      `INSERT INTO produtor_ofertas (conta_id, produto_id, nome, unidades, preco,
         taxa_gateway_pct, comissao_afiliado_pct, external_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [contaId, produtoId, nome, unidades,
       Number.isFinite(parseFloat(it?.preco)) ? parseFloat(it.preco) : 0,
       Number.isFinite(parseFloat(it?.taxa_gateway_pct)) ? parseFloat(it.taxa_gateway_pct) : 0,
       0, [gatewayId]]
    );
    criadas.push(mapOferta(rows[0]));
  }
  logger.info(CTX, `${criadas.length} oferta(s) cadastradas em lote (conta ${contaId})`);
  res.status(201).json({ criadas, ignoradas });
}));

/** Nomes de produto vistos nas vendas e nas faturas — para não digitar de cabeça. */
produtorAdminRouter.get('/contas/:id/sugestoes', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const [dasVendas, dasFaturas] = await Promise.all([
    query<{ nome: string }>(
      `SELECT DISTINCT produto_nome AS nome FROM produtor_vendas
        WHERE conta_id = $1 AND produto_nome IS NOT NULL ORDER BY 1`, [contaId]),
    query<{ nome: string }>(
      `SELECT DISTINCT fornecedor AS nome FROM produtor_faturas WHERE conta_id = $1 ORDER BY 1`, [contaId]),
  ]);
  res.json({
    produtos_nas_vendas: dasVendas.map(r => r.nome),
    fornecedores: dasFaturas.map(r => r.nome),
  });
}));

produtorAdminRouter.get('/contas/:id/importacoes', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const rows = await query(
    `SELECT id, arquivo, linhas_lidas, linhas_gravadas, linhas_repetidas,
            periodo_inicio::text AS periodo_inicio, periodo_fim::text AS periodo_fim,
            aviso, created_at
       FROM produtor_importacoes WHERE conta_id = $1 ORDER BY id DESC LIMIT 30`,
    [contaId]
  );
  res.json(rows);
}));

// ─────────────────────────────────────────────────────────────────────────────
// Previsão do invoice — escopo do CLIENTE, não de um produto
//
// A fatura da Red Rock cobra Divine Purity e Divine Detox na mesma folha. Prever olhando um
// produto de cada vez daria um número que nunca bateria com papel nenhum.
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/contas/:id/previsao', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const periodo = from && to && DATA_QUERY_RE.test(from) && DATA_QUERY_RE.test(to) && from <= to
    ? { from, to }
    : null;
  const conta = await exigirConta(contaId);
  res.json(await preverInvoice(conta, periodo, conta.moeda));
}));

// ─────────────────────────────────────────────────────────────────────────────
// O resumo (previsto vs real, lucro)
// ─────────────────────────────────────────────────────────────────────────────

const DATA_QUERY_RE = /^\d{4}-\d{2}-\d{2}$/;

produtorAdminRouter.get('/contas/:id/produtos/:produtoId/resumo', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const produtoId = idNaRota(req, 'produtoId');
  const conta = await exigirConta(contaId);
  const produto = await exigirProduto(contaId, produtoId);

  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  // Sem from/to o resumo é VITALÍCIO, e o campo rotulo_periodo diz isso — todo número da tela
  // precisa declarar se é do período ou vitalício.
  const periodo = from && to && DATA_QUERY_RE.test(from) && DATA_QUERY_RE.test(to) && from <= to
    ? { from, to }
    : null;

  res.json(await calcularResumo(conta, produto, periodo, conta.moeda));
}));

// ─────────────────────────────────────────────────────────────────────────────
// Integração com a Red Rock (Client Financial API)
//
// A token entra AQUI, por formulário, e nunca sai: o GET devolve só os quatro últimos caracteres.
// Não existe rota que leia a credencial inteira, nem no corpo nem em log — a única coisa que sai
// daqui com ela dentro é a requisição para a própria Red Rock.
// ─────────────────────────────────────────────────────────────────────────────

produtorAdminRouter.get('/contas/:id/integracoes', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  res.json({
    redrock: await resumoCredencial(contaId),
    sincronizacoes: await historicoSync(contaId, 10),
  });
}));

produtorAdminRouter.post('/contas/:id/integracoes/redrock', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const token = String(req.body?.token ?? '').trim();
  if (token.length < 16) {
    throw new ErroDeEntrada(
      'A token parece incompleta. Copie o valor inteiro que a Red Rock mostrou uma única vez, ' +
      'na hora de criar — depois ela não é exibida de novo.'
    );
  }
  if (token.length > 500) throw new ErroDeEntrada('A token é longa demais para ser uma token.');

  // Cadastrar já valida contra o /me: se a token não funcionar, ela não entra no banco. Guardar
  // uma credencial inválida faria a falha aparecer só na primeira sincronização automática, longe
  // de quem digitou.
  const resumo = await salvarCredencial(contaId, token);
  res.status(201).json(resumo);
}));

produtorAdminRouter.post('/contas/:id/integracoes/redrock/testar', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const cred = await lerCredencial(contaId);
  if (!cred) throw new ErroDeEntrada('Nenhuma token da Red Rock cadastrada para este cliente.');
  const identidade = await new RedRockClient(cred.token).identidade();
  await query(
    `UPDATE produtor_credenciais SET ultimo_ok = NOW(), ultimo_erro = NULL, ultimo_erro_em = NULL,
            updated_at = NOW()
      WHERE conta_id = $1 AND provedor = $2`,
    [contaId, PROVEDOR_REDROCK]
  );
  res.json({ ok: true, ...identidade });
}));

produtorAdminRouter.delete('/contas/:id/integracoes/redrock', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const apagou = await apagarCredencial(contaId);
  // O dado já sincronizado FICA. Ele é histórico de custo, não é da credencial — apagar junto
  // faria "trocar a token" virar "perder o custo real de três meses".
  res.json({ removida: apagou });
}));

/**
 * Puxa o período pedido.
 *
 * Teto de 400 dias por chamada: a janela de /deliveries é de no máximo um ano, e pedir mais do que
 * isso devolveria pedido de dois anos com um frete de um, o que sai da tela como se fosse a mesma
 * janela. Períodos maiores se faz em pedaços, e a resposta diz isso.
 */
produtorAdminRouter.post('/contas/:id/redrock/sincronizar', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const de = data(req.body?.from, 'Início do período');
  const ate = data(req.body?.to, 'Fim do período');
  if (de > ate) throw new ErroDeEntrada('O início do período é depois do fim.');

  const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000;
  if (dias > 400) {
    throw new ErroDeEntrada(
      'O período passa de 400 dias. A consulta de frete da Red Rock só aceita até um ano, então ' +
      'um período maior misturaria janelas diferentes na mesma tela. Sincronize por partes.'
    );
  }

  res.json(await sincronizar(contaId, de, ate));
}));

produtorAdminRouter.get('/contas/:id/redrock/custo-real', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  // Sem from/to é vitalício, e vitalício não passa recorte nenhum — nem um '2000-01-01' fingindo
  // de "desde sempre", que descartava pedido sem data de criação em silêncio.
  if (!from && !to) { res.json(await custoReal(contaId, null)); return; }
  if (!from || !to || !DATA_QUERY_RE.test(from) || !DATA_QUERY_RE.test(to) || from > to) {
    throw new ErroDeEntrada('Informe from e to no formato AAAA-MM-DD, ou nenhum dos dois para o vitalício.');
  }
  res.json(await custoReal(contaId, { de: from, ate: to }));
}));

produtorAdminRouter.get('/contas/:id/redrock/frete', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const medido = await fretePorPais(contaId);
  res.json({ medido, cadastrado: await lerTabelaFulfillment(contaId) });
}));

/**
 * Aplica a faixa medida na tabela de fulfillment.
 *
 * Rota própria, e não um efeito colateral da sincronização, de propósito: o valor cadastrado é uma
 * decisão de alguém e a previsão inteira sai dele. Trocar sozinho faria o número da tela mudar sem
 * nenhum evento que explicasse a mudança — e o jeito de descobrir seria comparar com um print.
 */
produtorAdminRouter.post('/contas/:id/redrock/frete/aplicar', asyncHandler(async (req, res) => {
  const contaId = idNaRota(req, 'id');
  const { sugestao } = await fretePorPais(contaId);
  if (!sugestao) {
    throw new ErroDeEntrada(
      'Ainda não há frete medido para sugerir uma faixa. Sincronize a Red Rock primeiro.'
    );
  }
  const atual = await lerTabelaFulfillment(contaId);
  if (!atual) throw new ErroDeEntrada('Cadastre a tabela de fulfillment antes de aplicar a faixa medida.');

  // Faixa degenerada não é aplicada. Com min e max nulos existe uma medida central e não existe
  // dispersão medida — gravar min = max = típico transformaria a previsão num número cravado, e a
  // banda de incerteza é justamente a parte honesta dela.
  if (sugestao.min == null || sugestao.max == null) {
    throw new ErroDeEntrada(
      `Só ${sugestao.pedidos} pedido(s) com frete já cobrado — pouco para medir a dispersão. ` +
      `O frete típico medido é ${sugestao.tipico.toFixed(2)}, e ele aparece na tela; a faixa só ` +
      `entra quando houver observação suficiente, para a previsão não virar um número cravado.`
    );
  }
  // Mesma checagem do formulário. Os percentis já garantem a ordem por construção, mas a rota não
  // pode depender disso: ela é um caminho de escrita como qualquer outro, e o dia em que a origem
  // da sugestão mudar, é aqui que o banco tem que recusar um intervalo que não contém o meio dele.
  if (!(sugestao.min <= sugestao.tipico && sugestao.tipico <= sugestao.max)) {
    throw new ErroDeEntrada('A faixa medida saiu fora de ordem (mínimo, típico, máximo). Nada foi gravado.');
  }

  await query(
    `UPDATE produtor_fulfillment
        SET frete_pedido_min = $2, frete_pedido_tipico = $3, frete_pedido_max = $4,
            frete_medido_pedidos = $5, frete_medido_em = NOW(),
            updated_at = NOW()
      WHERE conta_id = $1`,
    [contaId, sugestao.min, sugestao.tipico, sugestao.max, sugestao.pedidos]
  );

  res.json({ aplicada: sugestao, anterior: {
    min: atual.frete_pedido_min, tipico: atual.frete_pedido_tipico, max: atual.frete_pedido_max,
  } });
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
  // Falha da Red Rock é falha de OUTRO sistema, e a tela precisa saber a diferença entre "arruma a
  // credencial" e "tenta de novo mais tarde" — daí o 400 para o permanente e o 502 para o
  // passageiro, com a mensagem já higienizada lá no cliente.
  if (err instanceof ErroRedRock) {
    res.status(err.permanente ? 400 : 502).json({ error: err.message, origem: 'redrock' });
    return;
  }

  // Erro do Postgres vira mensagem legível em vez de "Internal server error".
  //
  // Isto é painel de administração, e o schema é o nosso: "column X of relation Y does not exist"
  // diz na hora o que aconteceu, enquanto "Internal server error" obriga a ir no pm2 logs do
  // servidor. Já custou duas idas ao log nesta semana, as duas por coluna renomeada.
  //
  // Só o code e a message do Postgres, nunca o SQL nem os parâmetros — a query traria nome de
  // cliente e valor de venda para dentro de uma mensagem de erro.
  if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) && err.message) {
    logger.error(CTX, `Erro do banco (${err.code}): ${err.message}`, { detail: err.detail });
    res.status(500).json({
      error: `O banco recusou a operação (${err.code}): ${err.message}`,
      dica: err.code === '42703' || err.code === '42P01'
        ? 'Coluna ou tabela que o código espera não existe neste banco. Confira se o deploy mais ' +
          'recente rodou — o schema é aplicado no restart do servidor.'
        : undefined,
    });
    return;
  }

  next(err);
});
