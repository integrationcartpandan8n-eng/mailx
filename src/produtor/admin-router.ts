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
import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { query, queryOne } from '../db/database';
import { logger } from '../utils/logger';
import {
  CATEGORIAS_FATURA, CategoriaFatura, calcularResumo, listarFaturas, listarOfertas,
  mapOferta, mapFatura,
} from './service';

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
    custo_unidade_previsto: numero(body.custo_unidade_previsto ?? 0, 'Custo por pote', { min: 0, max: 1000000 }),
    frete_previsto: numero(body.frete_previsto ?? 0, 'Frete por venda', { min: 0, max: 1000000 }),
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
       custo_unidade_previsto, frete_previsto, taxa_gateway_pct, comissao_afiliado_pct,
       external_ids, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [clientId, kitId, o.nome, o.unidades, o.preco, o.custo_unidade_previsto, o.frete_previsto,
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
        SET nome=$3, unidades=$4, preco=$5, custo_unidade_previsto=$6, frete_previsto=$7,
            taxa_gateway_pct=$8, comissao_afiliado_pct=$9, external_ids=$10, observacao=$11,
            ativo=$12, updated_at=NOW()
      WHERE id=$1 AND client_id=$2 RETURNING *`,
    [ofertaId, clientId, o.nome, o.unidades, o.preco, o.custo_unidade_previsto, o.frete_previsto,
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
