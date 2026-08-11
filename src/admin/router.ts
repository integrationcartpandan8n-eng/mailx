import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { query, isDatabaseReady, queryOne } from '../db/database';
import { logger } from '../utils/logger';
import { runBootstrap, runKitBootstrap, generateDnsRecords } from '../setup/bootstrap-service';
import { CartPandaClient } from '../services/cartpanda';
import { SlickTextClient } from '../services/slicktext';
import { autoLinkSlickTextLists } from '../webhooks/slicktext-sync';
import { ActiveCampaignClient } from '../services/activecampaign';
import { ds24Call, ds24KeyConfigurada, acharChavesInteressantes } from '../services/digistore24-api';
import { estadoDoCliente } from '../jobs/webhook-watchdog';
import { conferirInvariantes } from './invariantes';
import { canaisConfigurados } from '../services/notificador';
import { env, METRICS_ONLY } from '../config/env';
import {
  SESSION_COOKIE,
  parseCookies,
  isValidSession,
  createSession,
  destroySession,
  sessionCookieHeader,
  clearCookieHeader,
  verifyAdminPassword,
} from '../middleware/auth';

const CTX = 'Admin';

// A definição de canal e de segmento mora em ./atribuicao — uma vez, para os dois caminhos que
// leem esses números (a resposta da aba e o endpoint de invariantes). Ver o cabeçalho de lá.
import {
  SQL_IS_MAILX, SQL_IS_SMS, SQL_MAILX_SMS, SQL_MAILX_EMAIL,
  SQL_IS_RECOVERY, SQL_MEDIUM_AUTO, SQL_MEDIUM_CAMPAIGN, SQL_IS_UPSELL, SQL_REVENUE,
  SQL_ESCOPO_POR_AUTOMACAO, familiaDoProduto, apurarSms, listasDoKit,
} from './atribuicao';

const SQL_EXCLUDE_PAUSED_CLIENTS = `client_id NOT IN (SELECT id FROM clients WHERE status = 'paused')`;

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  BRL: 'R$',
  EUR: '€',
};

function currencySymbol(code: string | null | undefined): string {
  if (!code) return CURRENCY_SYMBOLS.USD;
  return CURRENCY_SYMBOLS[code] || `${code} `;
}

/** Moeda predominante de um cliente: maioria das transações reais, com fallback pro cadastro. */
async function resolveClientCurrency(clientId: string | number): Promise<string> {
  const dominant = await queryOne<{ currency: string }>(`
    SELECT currency, COUNT(*) as cnt
    FROM webhook_logs
    WHERE client_id = $1 AND currency IS NOT NULL
    GROUP BY currency
    ORDER BY cnt DESC
    LIMIT 1
  `, [clientId]);
  if (dominant?.currency) return dominant.currency;

  const client = await queryOne<{ default_currency: string }>(
    `SELECT default_currency FROM clients WHERE id = $1`, [clientId]
  );
  return client?.default_currency || 'USD';
}

const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_HM_RE = /^\d{2}:\d{2}$/;

function parseOptionalTimeRange(req: Request): {
  fromTime: string | null;
  toTime: string | null;
  hasTime: boolean;
} {
  const fromTime = req.query.from_time as string | undefined;
  const toTime = req.query.to_time as string | undefined;
  const hasTime = !!(fromTime && toTime && TIME_HM_RE.test(fromTime) && TIME_HM_RE.test(toTime));
  return {
    fromTime: hasTime ? fromTime! : null,
    toTime: hasTime ? toTime! : null,
    hasTime,
  };
}

function validateYmdRange(from: string, to: string): { fromDate: Date; toDate: Date; dayCount: number } | { error: string } {
  const fromDate = parseYmd(from);
  const toDate = parseYmd(to);
  if (fromDate > toDate) {
    return { error: 'from must be <= to' };
  }
  const dayCount = Math.round((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  if (dayCount > 366) {
    return { error: 'Date range cannot exceed 366 days' };
  }
  return { fromDate, toDate, dayCount };
}

/** Builds created_at filter using $1=from, $2=to; optionally appends $3/$4 for time. */
function createdAtRangeSql(
  params: (string | number)[],
  hasTime: boolean,
  fromTime: string | null,
  toTime: string | null
): string {
  if (hasTime && fromTime && toTime) {
    params.push(fromTime, toTime);
    return `created_at >= ($1::date + $3::time) AND created_at <= ($2::date + $4::time)`;
  }
  return `created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')`;
}

/** Same as createdAtRangeSql but from/to are at $fromIdx/$toIdx (for sms-granular: $2/$3). */
function createdAtRangeSqlAt(
  params: (string | number)[],
  fromIdx: number,
  toIdx: number,
  hasTime: boolean,
  fromTime: string | null,
  toTime: string | null
): string {
  if (hasTime && fromTime && toTime) {
    params.push(fromTime, toTime);
    const tFromIdx = params.length - 1;
    const tToIdx = params.length;
    return `created_at >= ($${fromIdx}::date + $${tFromIdx}::time) AND created_at <= ($${toIdx}::date + $${tToIdx}::time)`;
  }
  return `created_at >= $${fromIdx}::date AND created_at < ($${toIdx}::date + INTERVAL '1 day')`;
}

/**
 * Resolve o período de análise da querystring: preset "Hoje" (?today=1), intervalo
 * from/to explícito, ou nenhum (lifetime). "Hoje" é resolvido com CURRENT_DATE do
 * próprio Postgres — de propósito, para não depender do fuso-horário do navegador
 * de quem está com o filtro aberto (evita "hoje" bater errado por 1 dia).
 */
function resolvePeriodFilter(req: Request): {
  isToday: boolean;
  from?: string;
  to?: string;
  hasTime: boolean;
  fromTime: string | null;
  toTime: string | null;
} {
  if (req.query.today === '1') {
    return { isToday: true, hasTime: false, fromTime: null, toTime: null };
  }
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const { fromTime, toTime, hasTime } = parseOptionalTimeRange(req);
  if (from && to && DATE_YMD_RE.test(from) && DATE_YMD_RE.test(to)) {
    const range = validateYmdRange(from, to);
    if (!('error' in range)) {
      return { isToday: false, from, to, hasTime, fromTime, toTime };
    }
  }
  return { isToday: false, hasTime: false, fromTime: null, toTime: null };
}

/**
 * Builda a condição `created_at` pro período resolvido acima, empurrando os
 * params necessários no array recebido (cada chamada usa seu próprio array de
 * params, já que cada query tem uma base diferente). Retorna '' quando não há
 * período ativo (comportamento antigo: sem filtro, vitalício).
 */
function periodSql(
  period: ReturnType<typeof resolvePeriodFilter>,
  params: (string | number)[]
): string {
  if (period.isToday) {
    return `created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'`;
  }
  if (period.from && period.to) {
    params.push(period.from, period.to);
    const fromIdx = params.length - 1;
    const toIdx = params.length;
    return createdAtRangeSqlAt(params, fromIdx, toIdx, period.hasTime, period.fromTime, period.toTime);
  }
  return '';
}

interface SlickTextAccountRef {
  accountId: number | null; // null = conta principal (clients.st_api_token/st_brand_id)
  label: string;
  st_api_token: string;
  st_brand_id: string;
}

/**
 * Um cliente pode rodar SMS por mais de uma conta/marca da SlickText em paralelo pro mesmo
 * produto (confirmado com o Murilo — ex: dois números de telefone diferentes escalando o
 * mesmo fluxo). Junta a conta principal (clients.st_api_token/st_brand_id) com as adicionais
 * (client_slicktext_accounts). Métricas agregadas (contatos, créditos) devem somar todas;
 * vínculos de mensagem específicos (sms_campaign_map.st_account_id) usam uma só.
 */
async function getSlickTextAccounts(clientId: number | string): Promise<SlickTextAccountRef[]> {
  const client = await queryOne<{ st_api_token: string | null; st_brand_id: string | null }>(
    `SELECT st_api_token, st_brand_id FROM clients WHERE id = $1`, [clientId]
  );
  const extra = await query<{ id: number; label: string | null; st_api_token: string; st_brand_id: string }>(
    `SELECT id, label, st_api_token, st_brand_id FROM client_slicktext_accounts WHERE client_id = $1 ORDER BY id`,
    [clientId]
  );

  const accounts: SlickTextAccountRef[] = [];
  if (client?.st_api_token && client?.st_brand_id) {
    accounts.push({ accountId: null, label: 'Principal', st_api_token: client.st_api_token, st_brand_id: client.st_brand_id });
  }
  for (const row of extra) {
    accounts.push({ accountId: row.id, label: row.label || `Conta ${row.id}`, st_api_token: row.st_api_token, st_brand_id: row.st_brand_id });
  }
  return accounts;
}

/**
 * Grava o retrato de hoje da contagem de cada lista. Idempotente no dia: chamar o /stats dez
 * vezes deixa uma linha por lista, com o último valor. Falha aqui NÃO pode derrubar o /stats —
 * o retrato é para o futuro, o número da tela já está calculado.
 */
async function gravarSnapshotDeListas(
  clientId: string,
  listas: Array<{ id: string; count: number; accountId: number | null; nome?: string | null }>
): Promise<void> {
  for (const l of listas) {
    if (l.count <= 0) continue; // lista que não respondeu — gravar 0 criaria degrau falso no delta
    try {
      // Este caminho conta lista por ID vindo do kit, então normalmente NÃO sabe o nome. O
      // COALESCE existe para ele não apagar o nome que o job já gravou: abrir a aba SMS não pode
      // desfazer informação que a gravação automática obteve.
      await query(
        `INSERT INTO list_contact_snapshots (client_id, st_account_id, list_id, snapshot_date, contact_count, list_name)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, $5)
         ON CONFLICT (client_id, COALESCE(st_account_id, 0), list_id, snapshot_date)
         DO UPDATE SET contact_count = EXCLUDED.contact_count,
                       list_name = COALESCE(EXCLUDED.list_name, list_contact_snapshots.list_name)`,
        [clientId, l.accountId, l.id, l.count, l.nome ?? null]
      );
    } catch (err: any) {
      logger.warn(CTX, `Falha ao gravar retrato da lista ${l.id} (client ${clientId}): ${err.message}`);
    }
  }
}

/**
 * Leads ENTRADOS no período = contagem no fim menos contagem na véspera do início, somando as
 * listas. Devolve null quando os retratos não cobrem o período — e nesse caso quem chama volta pro
 * vitalício ROTULADO, em vez de mostrar um número menor sem dizer por quê.
 *
 * Tolerância de 3 dias em cada ponta: o retrato é gravado quando alguém abre o dashboard, então
 * pode faltar o dia exato. Fora disso a resposta é null — esticar mais transformaria a "contagem
 * exata" numa estimativa pior que o vitalício, que ao menos é um número verdadeiro de algo.
 */
async function leadsPorPeriodoViaSnapshots(
  clientId: string,
  abandonoIds: string[],
  compraIds: string[],
  from: string,
  to: string,
  liveFimCounts?: Map<string, number>
): Promise<{ abandono: number; compra: number; deltaPorLista: Map<string, number>; baseDate: string; endDate: string } | null> {
  const todas = [...new Set([...abandonoIds, ...compraIds])];
  if (todas.length === 0) return null;

  // Quando `to` é hoje, a ponta final não pode vir do retrato: o retrato de hoje, se existir, foi
  // gravado na primeira janela do dia e fica congelado a partir dali — filtrar "Hoje" às 18h
  // mostraria o tamanho da lista às 9h, não agora. `liveFimCounts` é a contagem que a própria
  // rota chamadora ACABOU de buscar na SlickText (ao vivo, pro total vitalício) — reaproveitar
  // em vez de bater na API de novo, e sem esperar o próximo retrato existir.
  const rows = liveFimCounts
    ? await query<{ list_id: string; ponta: string; snapshot_date: string; contact_count: string }>(
        `SELECT DISTINCT ON (list_id) list_id, 'base' AS ponta, snapshot_date::text AS snapshot_date, contact_count
         FROM list_contact_snapshots
         WHERE client_id = $1 AND list_id = ANY($2)
           AND snapshot_date BETWEEN ($3::date - INTERVAL '3 days') AND ($3::date - INTERVAL '1 day')
         ORDER BY list_id, snapshot_date DESC`,
        [clientId, todas, from]
      )
    : await query<{ list_id: string; ponta: string; snapshot_date: string; contact_count: string }>(
        `WITH base AS (
           SELECT DISTINCT ON (list_id) list_id, 'base' AS ponta, snapshot_date::text AS snapshot_date, contact_count
           FROM list_contact_snapshots
           WHERE client_id = $1 AND list_id = ANY($2)
             AND snapshot_date BETWEEN ($3::date - INTERVAL '3 days') AND ($3::date - INTERVAL '1 day')
           ORDER BY list_id, snapshot_date DESC
         ), fim AS (
           SELECT DISTINCT ON (list_id) list_id, 'fim' AS ponta, snapshot_date::text AS snapshot_date, contact_count
           FROM list_contact_snapshots
           WHERE client_id = $1 AND list_id = ANY($2)
             AND snapshot_date BETWEEN $4::date AND ($4::date + INTERVAL '3 days')
           ORDER BY list_id, snapshot_date ASC
         )
         SELECT * FROM base UNION ALL SELECT * FROM fim`,
        [clientId, todas, from, to]
      );

  const porLista = new Map<string, { base?: number; fim?: number; baseD?: string; fimD?: string }>();
  for (const r of rows) {
    const e = porLista.get(r.list_id) ?? {};
    if (r.ponta === 'base') { e.base = parseInt(r.contact_count); e.baseD = r.snapshot_date; }
    else { e.fim = parseInt(r.contact_count); e.fimD = r.snapshot_date; }
    porLista.set(r.list_id, e);
  }
  if (liveFimCounts) {
    for (const id of todas) {
      const count = liveFimCounts.get(id);
      if (count == null) continue; // sem contagem ao vivo pra essa lista — cai no "falta uma ponta" abaixo, honesto
      const e = porLista.get(id) ?? {};
      e.fim = count;
      e.fimD = to;
      porLista.set(id, e);
    }
  }

  // Exige as duas pontas em TODAS as listas. Faltando uma, a soma sairia menor que a realidade e
  // pareceria uma queda de leads — pior que dizer que não dá.
  const somar = (ids: string[]): number | null => {
    let t = 0;
    for (const id of ids) {
      const e = porLista.get(id);
      if (!e || e.base == null || e.fim == null) return null;
      t += Math.max(0, e.fim - e.base); // negativo = descadastro; leads entrados não são negativos
    }
    return t;
  };

  const abandono = somar(abandonoIds);
  const compra = somar(compraIds);
  if (abandono === null || compra === null) return null;

  // Delta POR LISTA, não só o total. É o que permite a tabela "Aberto por produto" usar a MESMA
  // fonte de leads da tabela de cima.
  //
  // Antes ela usava o total atual da lista (vitalício) enquanto a de cima usava o delta do
  // período — e as duas apareciam no mesmo card, com a mesma venda: 26 recuperações contra 644
  // leads davam 4,0% em cima, e as mesmas 26 contra 31.980 davam 0,08% embaixo. Cinquenta vezes
  // de diferença, os dois "certos" no seu próprio universo, e só o de cima com legenda. Comparar
  // taxas de universos diferentes lado a lado é pior que não mostrar a segunda.
  const deltaPorLista = new Map<string, number>();
  for (const [id, e] of porLista) {
    if (e.base != null && e.fim != null) deltaPorLista.set(id, Math.max(0, e.fim - e.base));
  }

  // As datas vêm como texto do SQL (snapshot_date::text) de propósito: o driver do Postgres devolve
  // DATE como objeto Date do JS, e String(date).slice(0,10) produzia "Thu Jul 30" — foi o que
  // apareceu na tela em produção, no idioma errado e sem ano.
  const datas = [...porLista.values()];
  const baseDate = datas.map(d => d.baseD).filter(Boolean).sort().pop() ?? from;
  const endDate = datas.map(d => d.fimD).filter(Boolean).sort()[0] ?? to;
  return { abandono, compra, deltaPorLista, baseDate: String(baseDate).slice(0, 10), endDate: String(endDate).slice(0, 10) };
}

/**
 * Leads de COMPRA por período, exatos, direto do webhook_logs — não do retrato.
 *
 * Por que existe: confirmado por amostra (5 contatos, comparando o `created` da SlickText contra
 * o `webhook_logs.created_at` da venda correspondente) que o contato nasce na SlickText entre 40
 * segundos e pouco mais de 1 minuto DEPOIS do nosso `order.paid` — é o n8n reagindo ao mesmo
 * evento que a gente recebeu, quase no mesmo instante. Isso torna `webhook_logs.created_at` uma
 * fonte EXATA (precisão de segundos, não de dia) e RETROATIVA (cobre desde sempre, não só desde
 * que o retrato começou a rodar) de "quando essa venda virou lead de compra".
 *
 * LIMITE HONESTO, medido no mesmo teste: 1 dos 5 contatos da amostra tinha a última venda
 * registrada aqui 4 dias ANTES de virar contato na SlickText — ele comprou de novo por um gateway
 * que não ingerimos (JVZoo/BuyGoods, confirmado sem handler no nosso lado). Esta função só conta
 * venda que NÓS recebemos; comprador que entrou na lista por outro caminho fica de fora daqui
 * mesmo estando na lista de verdade. Por isso ela não substitui o retrato — o retrato mede o
 * tamanho real da lista, venha o contato de onde vier, e a DIFERENÇA entre os dois números é o
 * sinal de venda não capturada, não um erro deste cálculo.
 *
 * Cobre só o lado COMPRA de propósito: não existe handler de carrinho abandonado para produto
 * vendido via Digistore (só para CartPanda) — o abandono desses produtos é tratado inteiramente
 * pelo n8n, sem gravar nada aqui. Sem evento nosso para ancorar, o lado abandono continua
 * dependendo do retrato.
 *
 * SÓ CONTA PRODUTO COM UMA LISTA DE COMPRA (sem slot 2), de propósito. Uma venda nossa não diz em
 * QUAL das duas listas o comprador caiu quando o produto tem gateway duplo (ex.: Thermo Burn,
 * 105431 + 145156) — só sabemos que ele comprou. Uma versão anterior desta função tentava contar
 * as duas listas separadamente com um CROSS JOIN, e cada venda desses produtos entrava DUAS vezes
 * (uma por lista) — 14.460 "leads" onde o total real de vendas do período inteiro era 8.237.
 * Produto com duas listas fica de fora daqui e cai no retrato, que mede o tamanho real de cada
 * lista sem precisar saber de qual gateway veio cada contato — aproximado, mas não inflado.
 */
async function leadsDeCompraViaWebhookLogs(
  clientId: string,
  compraListIds: string[],
  from: string,
  to: string
): Promise<{ total: number; porLista: Map<string, number> } | null> {
  if (compraListIds.length === 0) return null;

  const rows = await query<{ list_id: string; leads: string }>(
    `SELECT k.st_list_compra_id AS list_id, COUNT(*)::text AS leads
     FROM webhook_logs w
     JOIN kits k ON k.client_id = w.client_id AND k.platform = w.source AND k.external_id = w.product_external_id
     WHERE w.client_id = $1 AND w.event_type = 'order.paid'
       AND k.st_list_compra_id = ANY($2)
       AND k.st_list_compra_id_2 IS NULL
       AND w.created_at >= $3::date AND w.created_at < ($4::date + INTERVAL '1 day')
     GROUP BY k.st_list_compra_id`,
    [clientId, compraListIds, from, to]
  );

  if (rows.length === 0) return null;
  const porLista = new Map(rows.map(r => [r.list_id, parseInt(r.leads)]));
  const total = [...porLista.values()].reduce((a, b) => a + b, 0);
  return { total, porLista };
}

/**
 * Resolve as credenciais de UMA conta específica (por accountId — null = principal), pra usar
 * em vínculos de mensagem (sms_campaign_map.st_account_id) onde só uma conta importa.
 */
async function getSlickTextAccountById(clientId: number | string, accountId: number | null): Promise<{ st_api_token: string; st_brand_id: string } | null> {
  if (accountId == null) {
    const client = await queryOne<{ st_api_token: string | null; st_brand_id: string | null }>(
      `SELECT st_api_token, st_brand_id FROM clients WHERE id = $1`, [clientId]
    );
    return client?.st_api_token && client?.st_brand_id ? { st_api_token: client.st_api_token, st_brand_id: client.st_brand_id } : null;
  }
  const row = await queryOne<{ st_api_token: string; st_brand_id: string }>(
    `SELECT st_api_token, st_brand_id FROM client_slicktext_accounts WHERE id = $1 AND client_id = $2`,
    [accountId, clientId]
  );
  return row || null;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDayLabel(d: Date): string {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const adminRouter = Router();

// ── Login Page (GET /admin/login) ──
adminRouter.get('/login', (_req: Request, res: Response) => {
  const loginDir = fs.existsSync(path.join(process.cwd(), 'src', 'admin'))
    ? path.join(process.cwd(), 'src', 'admin')
    : path.join(__dirname);

  const loginPath = path.join(loginDir, 'login.html');
  if (fs.existsSync(loginPath)) {
    res.sendFile(loginPath);
  } else {
    res.send(`<html><body><h1>Login</h1><form method="POST" action="/admin/login"><input name="password" type="password" placeholder="Senha"><button type="submit">Entrar</button></form></body></html>`);
  }
});

// ── Login POST (POST /admin/login) ──
adminRouter.post('/login', (req: Request, res: Response) => {
  const { password } = req.body;

  if (verifyAdminPassword(password)) {
    const token = createSession();
    res.setHeader('Set-Cookie', sessionCookieHeader(token));
    res.redirect('/admin');
    logger.info(CTX, '🔐 Login successful');
  } else {
    res.redirect('/admin/login?error=1');
    logger.warn(CTX, '🔒 Login failed — wrong password');
  }
});

// ── Logout (GET /admin/logout) ──
adminRouter.get('/logout', (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (token) destroySession(token);

  res.setHeader('Set-Cookie', clearCookieHeader());
  res.redirect('/admin/login');
});

// ── Auth Middleware (protects everything except /login, /logout) ──
adminRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/login' || req.path === '/logout') {
    next();
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];

  if (!isValidSession(token)) {
    // API requests get 401, HTML requests get redirected
    if (req.path.startsWith('/dashboard/') || req.path.startsWith('/clientes') || req.path.startsWith('/integration/') || req.path.startsWith('/bootstrap')) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      res.redirect('/admin/login');
    }
    return;
  }

  next();
});

// Middleware: check DB before API routes (skip HTML pages)
adminRouter.use((req: Request, res: Response, next: NextFunction) => {
  // Allow HTML pages to load without DB (they fetch data via JS)
  const htmlPaths = ['/', '/integration', '/client-detail'];
  if (htmlPaths.includes(req.path)) {
    next();
    return;
  }
  if (!isDatabaseReady()) {
    res.status(503).json({ error: 'Database not connected' });
    return;
  }
  next();
});

// Wrap async handlers
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Helper to resolve HTML files
function getHtmlPath(filename: string): string {
  const srcPath = path.join(process.cwd(), 'src', 'admin', filename);
  if (fs.existsSync(srcPath)) return srcPath;
  return path.join(__dirname, filename);
}

function serveHtml(filename: string, res: Response): void {
  const filePath = getHtmlPath(filename);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.type('html').send(content);
  } else {
    logger.error(CTX, `HTML not found: ${filePath}`);
    res.status(404).send('Page not found');
  }
}

// ── Pages ──

// GET /admin - Dashboard HTML
adminRouter.get('/', (_req: Request, res: Response) => {
  serveHtml('dashboard.html', res);
});

// GET /admin/integration - Integration page
adminRouter.get('/integration', (_req: Request, res: Response) => {
  serveHtml('integration.html', res);
});

// GET /admin/client-detail - Client detail page
adminRouter.get('/client-detail', (_req: Request, res: Response) => {
  serveHtml('client-detail.html', res);
});

// ── Dashboard API Endpoints ──

// GET /admin/dashboard/overview - Overview KPIs + chart data
adminRouter.get('/dashboard/overview', asyncHandler(async (_req: Request, res: Response) => {
  // ── Sales from order.paid webhooks ──
  const salesData = await queryOne<{ count: string, total_revenue: string }>(`
    SELECT 
      COUNT(*) as count,
      ${SQL_REVENUE} as total_revenue
    FROM webhook_logs 
    WHERE event_type = 'order.paid' AND status = 'processed'
      AND ${SQL_EXCLUDE_PAUSED_CLIENTS}
  `);
  // MailX attribution: sales where utm contains 'mailx' (case-insensitive)
  const salesDataMailx = await queryOne<{ count: string, total_revenue: string }>(`
    SELECT 
      COUNT(*) as count,
      ${SQL_REVENUE} as total_revenue
    FROM webhook_logs 
    WHERE event_type = 'order.paid' AND status = 'processed'
      AND ${SQL_IS_MAILX}
      AND ${SQL_EXCLUDE_PAUSED_CLIENTS}
  `);
  // MailX abandoned cart recoveries: MailX attribution + recovery UTM
  const mailxRecoveries = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count,
      ${SQL_REVENUE} as revenue
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status = 'processed'
      AND ${SQL_IS_MAILX}
      AND ${SQL_IS_RECOVERY}
      AND ${SQL_EXCLUDE_PAUSED_CLIENTS}
  `);
  const refundCount = await queryOne<{ count: string }>(`
    SELECT COUNT(*) FROM webhook_logs WHERE event_type = 'order.refunded'
      AND ${SQL_EXCLUDE_PAUSED_CLIENTS}
  `);

  const totalSales = parseInt(salesData?.count || '0');
  const totalRevenue = parseFloat(salesData?.total_revenue || '0');
  const ticketMedio = totalSales > 0 ? totalRevenue / totalSales : 0;
  const refunds = parseInt(refundCount?.count || '0');
  const taxaReembolso = totalSales > 0 ? ((refunds / totalSales) * 100).toFixed(1) : '0';
  const mailxSales = parseInt(salesDataMailx?.count || '0');
  const mailxRevenue = parseFloat(salesDataMailx?.total_revenue || '0');
  const mailxRecoveryCount = parseInt(mailxRecoveries?.count || '0');
  const mailxRecoveryRevenue = parseFloat(mailxRecoveries?.revenue || '0');

  // ── Webhooks by hour ──
  const hourlyWebhooks = await query<{ hour: string, count: string }>(`
    SELECT EXTRACT(HOUR FROM created_at)::text as hour, COUNT(*) as count
    FROM webhook_logs
    WHERE ${SQL_EXCLUDE_PAUSED_CLIENTS}
    GROUP BY EXTRACT(HOUR FROM created_at)
    ORDER BY EXTRACT(HOUR FROM created_at)
  `);
  const hourlyValues = Array.from({ length: 24 }, (_, i) => {
    const match = hourlyWebhooks.find(r => parseInt(r.hour) === i);
    return match ? parseInt(match.count) : 0;
  });

  // ── Top 5 Produtos (from webhook payloads) ──
  const topKits = await query<{ name: string, count: string, revenue: string }>(`
    SELECT 
      product_name as name,
      COUNT(*) as count,
      ${SQL_REVENUE} as revenue
    FROM webhook_logs 
    WHERE event_type = 'order.paid' AND product_name IS NOT NULL
      AND ${SQL_EXCLUDE_PAUSED_CLIENTS}
    GROUP BY product_name ORDER BY count DESC LIMIT 5
  `);

  // ── Top 5 Tags ──
  const eventDist = await query<{ event_type: string, count: string }>(`
    SELECT event_type, COUNT(*) as count
    FROM webhook_logs
    WHERE ${SQL_EXCLUDE_PAUSED_CLIENTS}
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 5
  `);

  // ── Conversion Funnel (envios/cliques por venda) ──
  const totalWebhooks = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM webhook_logs WHERE ${SQL_EXCLUDE_PAUSED_CLIENTS}`);
  const totalWh = parseInt(totalWebhooks?.count || '0');
  const enviosPorVenda = totalSales > 0 ? Math.round(totalWh / totalSales) : 0;

  // Format currency
  // Assume USD — dashboards agregados ainda não têm suporte a multi-moeda (ver client-level fix)
  const fmtBRL = (v: number) => '$\u00A0' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  res.json({
    kpis: {
      faturamento_aprovado: fmtBRL(totalRevenue),
      vendas_totais: totalSales.toLocaleString('pt-BR'),
      ticket_medio: fmtBRL(ticketMedio),
      taxa_reembolso: `${taxaReembolso}%`,
      representatividade: totalRevenue > 0
        ? `${((mailxRevenue / totalRevenue) * 100).toFixed(1)}%`
        : '0%',
      faturamento_mailx: fmtBRL(mailxRevenue),
      vendas_mailx: mailxSales.toLocaleString('pt-BR'),
      recuperacoes_mailx: mailxRecoveryCount,
      faturamento_recuperacoes: fmtBRL(mailxRecoveryRevenue),
    },
    charts: {
      hourly: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`),
        values: hourlyValues,
      },
      top_products: {
        labels: topKits.length > 0 ? topKits.map(k => k.name) : ['Nenhum kit'],
        values: topKits.length > 0 ? topKits.map(k => parseInt(k.count)) : [0],
      },
      top_event_types: {
        labels: eventDist.length > 0 ? eventDist.map(e => e.event_type) : ['Nenhum evento'],
        values: eventDist.length > 0 ? eventDist.map(e => parseInt(e.count)) : [0],
      },
    },
    funnel: {
      total_envios: totalWh,
      total_vendas: totalSales,
      envios_por_venda: enviosPorVenda,
    },
  });
}));

// GET /admin/dashboard/revenue-charts - Revenue time-series for dashboard charts
adminRouter.get('/dashboard/revenue-charts', asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const clientId = req.query.client_id as string | undefined;
  const channel = req.query.channel as string | undefined;

  if (!from || !to || !DATE_YMD_RE.test(from) || !DATE_YMD_RE.test(to)) {
    res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
    return;
  }

  const range = validateYmdRange(from, to);
  if ('error' in range) {
    res.status(400).json({ error: range.error });
    return;
  }
  const { fromDate, toDate } = range;

  const { fromTime, toTime, hasTime } = parseOptionalTimeRange(req);

  // channel escopa as SÉRIES da MailX (automação, campanha, recuperação, upsell) — nunca a série
  // `total`, que é o faturamento do cliente inteiro e serve de régua no gráfico. Escopar o total
  // junto faria as duas linhas coincidirem e o gráfico perderia justamente o que ele mostra: o
  // tamanho da fatia MailX dentro do que o cliente fatura.
  const channelExtra =
    channel === 'email' ? `AND NOT ${SQL_IS_SMS}`
    : channel === 'sms' ? `AND ${SQL_IS_SMS}`
    : '';
  const params: (string | number)[] = [from, to];
  const dateFilterSql = createdAtRangeSql(params, hasTime, fromTime, toTime);
  let clientFilter = '';
  let cid: number | undefined;
  if (clientId) {
    cid = parseInt(clientId, 10);
    if (Number.isNaN(cid)) {
      res.status(400).json({ error: 'Invalid client_id' });
      return;
    }
    params.push(cid);
    clientFilter = `AND client_id = $${params.length}`;
  }

  const rows = await query<{
    day: string | Date;
    total: string;
    automacao: string;
    campanha: string;
    recuperacao: string;
    upsell: string;
  }>(`
    SELECT
      DATE(created_at) AS day,
      COALESCE(SUM(total_price), 0) AS total,
      COALESCE(SUM(total_price) FILTER (WHERE ${SQL_IS_MAILX} AND ${SQL_MEDIUM_AUTO} ${channelExtra}), 0) AS automacao,
      COALESCE(SUM(total_price) FILTER (WHERE ${SQL_IS_MAILX} AND ${SQL_MEDIUM_CAMPAIGN} ${channelExtra}), 0) AS campanha,
      COALESCE(SUM(total_price) FILTER (WHERE ${SQL_IS_MAILX} AND ${SQL_IS_RECOVERY} ${channelExtra}), 0) AS recuperacao,
      COALESCE(SUM(total_price) FILTER (WHERE ${SQL_IS_MAILX} AND ${SQL_IS_UPSELL} ${channelExtra}), 0) AS upsell
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status = 'processed'
      AND ${dateFilterSql}
      ${clientFilter}
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at)
  `, params);

  const byDay = new Map<string, typeof rows[0]>();
  for (const row of rows) {
    const key = typeof row.day === 'string'
      ? row.day.slice(0, 10)
      : dayKey(new Date(row.day));
    byDay.set(key, row);
  }

  const labels: string[] = [];
  const total: number[] = [];
  const automacao: number[] = [];
  const campanha: number[] = [];
  const recuperacao: number[] = [];
  const upsell: number[] = [];

  for (let d = new Date(fromDate); d <= toDate; d = addDays(d, 1)) {
    const key = dayKey(d);
    const row = byDay.get(key);
    labels.push(formatDayLabel(d));
    total.push(row ? parseFloat(row.total) : 0);
    automacao.push(row ? parseFloat(row.automacao) : 0);
    campanha.push(row ? parseFloat(row.campanha) : 0);
    recuperacao.push(row ? parseFloat(row.recuperacao) : 0);
    upsell.push(row ? parseFloat(row.upsell) : 0);
  }

  const currency = cid ? await resolveClientCurrency(cid) : 'USD';

  res.json({
    labels,
    total,
    automacao,
    campanha,
    recuperacao,
    upsell,
    from_time: hasTime ? fromTime : null,
    to_time: hasTime ? toTime : null,
    currency,
  });
}));

// GET /admin/dashboard/revenue-vs-refund - Approved revenue vs refund totals for doughnut chart
adminRouter.get('/dashboard/revenue-vs-refund', asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const clientId = req.query.client_id as string | undefined;

  if (!from || !to || !DATE_YMD_RE.test(from) || !DATE_YMD_RE.test(to)) {
    res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
    return;
  }

  const range = validateYmdRange(from, to);
  if ('error' in range) {
    res.status(400).json({ error: range.error });
    return;
  }

  const { fromTime, toTime, hasTime } = parseOptionalTimeRange(req);

  const params: (string | number)[] = [from, to];
  const dateFilterSql = createdAtRangeSql(params, hasTime, fromTime, toTime);
  let clientFilter = '';
  let cid: number | undefined;
  if (clientId) {
    cid = parseInt(clientId, 10);
    if (Number.isNaN(cid)) {
      res.status(400).json({ error: 'Invalid client_id' });
      return;
    }
    params.push(cid);
    clientFilter = `AND client_id = $${params.length}`;
  }

  // Mesmo escopo por canal dos gráficos de série. Aqui ele vale para TODAS as fatias (aprovado,
  // reembolso e chargeback): a rosca compara pedaços do mesmo bolo, então misturar aprovado de um
  // canal com reembolso de todos daria uma taxa de reembolso inventada.
  const canalRefund = req.query.channel as string | undefined;
  const escopoCanal =
    canalRefund === 'email' ? `AND ${SQL_IS_MAILX} AND NOT ${SQL_IS_SMS}`
    : canalRefund === 'sms' ? `AND ${SQL_MAILX_SMS}`
    : '';

  const row = await queryOne<{ aprovado: string; reembolso: string; chargeback_custo: string }>(`
    SELECT
      COALESCE(SUM(total_price) FILTER (WHERE event_type = 'order.paid' AND status = 'processed'), 0) AS aprovado,
      COALESCE(SUM(ABS(total_price)) FILTER (WHERE event_type = 'order.refunded'), 0) AS reembolso,
      COALESCE(SUM(ABS(total_price)) FILTER (WHERE event_type = 'order.chargeback'), 0) AS chargeback_custo
    FROM webhook_logs
    WHERE ${dateFilterSql}
      ${clientFilter}
      ${escopoCanal}
  `, params);

  const currency = cid ? await resolveClientCurrency(cid) : 'USD';

  res.json({
    aprovado: parseFloat(row?.aprovado || '0'),
    reembolso: parseFloat(row?.reembolso || '0'),
    chargeback_custo: parseFloat(row?.chargeback_custo || '0'),
    // Escopo declarado no dado, não só no título da tela: quem consome a API direto precisa saber
    // se está olhando o cliente inteiro ou um canal, senão compara números de universos diferentes.
    escopo: canalRefund === 'email' ? 'MailX · Email' : canalRefund === 'sms' ? 'MailX · SMS' : 'cliente inteiro (todos os canais)',
    currency,
    from_time: hasTime ? fromTime : null,
    to_time: hasTime ? toTime : null,
  });
}));

// GET /admin/dashboard/history - Historical KPIs
adminRouter.get('/dashboard/history', asyncHandler(async (_req: Request, res: Response) => {
  // ── Sales totals from webhook data ──
  const salesTotal = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND status = 'processed'
  `);
  const totalSales = parseInt(salesTotal?.count || '0');
  const totalRevenue = parseFloat(salesTotal?.revenue || '0');
  const ticketMedio = totalSales > 0 ? totalRevenue / totalSales : 0;
  // Comissão MailX = 30% do faturamento (padrão — pode ser configurável)
  const comissaoMailx = totalRevenue * 0.30;

  // ── Monthly data ──
  const monthlyActivity = await query<{ month: string, order_paid: string, abandoned: string }>(`
    SELECT 
      TO_CHAR(created_at, 'Mon') as month,
      COUNT(*) FILTER (WHERE event_type = 'order.paid') as order_paid,
      COUNT(*) FILTER (WHERE event_type = 'abandoned_cart') as abandoned
    FROM webhook_logs
    WHERE created_at >= NOW() - INTERVAL '12 months'
    GROUP BY TO_CHAR(created_at, 'Mon'), DATE_TRUNC('month', created_at)
    ORDER BY DATE_TRUNC('month', created_at)
  `);

  const monthlyClients = await query<{ month: string, count: string }>(`
    SELECT TO_CHAR(created_at, 'Mon') as month, COUNT(*) as count
    FROM clients
    WHERE created_at >= NOW() - INTERVAL '12 months'
    GROUP BY TO_CHAR(created_at, 'Mon'), DATE_TRUNC('month', created_at)
    ORDER BY DATE_TRUNC('month', created_at)
  `);

  const months = monthlyActivity.length > 0 ? monthlyActivity.map(m => m.month) : ['Sem dados'];
  const monthsClients = monthlyClients.length > 0 ? monthlyClients.map(m => m.month) : ['Sem dados'];

  // Assume USD — dashboards agregados ainda não têm suporte a multi-moeda (ver client-level fix)
  const fmtBRL = (v: number) => '$\u00A0' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  res.json({
    sales: {
      faturamento: fmtBRL(totalRevenue),
      comissoes_mailx: fmtBRL(comissaoMailx),
      vendas: totalSales.toLocaleString('pt-BR'),
      ticket_medio: fmtBRL(ticketMedio),
    },
    email: {
      entrada_contatos: '--',
      ctr: '--',
      taxa_abertura: '--',
      ctor: '--',
      rpm: '--',
      epc: '--',
    },
    charts: {
      email_perf: {
        labels: months,
        order_paid: monthlyActivity.map(m => parseInt(m.order_paid)),
        abandoned: monthlyActivity.map(m => parseInt(m.abandoned)),
      },
      contacts: {
        labels: monthsClients,
        values: monthlyClients.length > 0 ? monthlyClients.map(m => parseInt(m.count)) : [0],
      },
    },
  });
}));

// GET /admin/dashboard/email - Aggregated email marketing KPIs across all clients
adminRouter.get('/dashboard/email', asyncHandler(async (_req: Request, res: Response) => {
  // Sales aggregates filtered to email-driven MailX traffic
  // Email = utm_source/campaign containing 'mailx' but NOT 'mailxsms'
  const emailSales = await queryOne<{ count: string; revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs
    WHERE event_type = 'order.paid'
      AND ${SQL_MAILX_EMAIL}
  `);
  const emailRecoveries = await queryOne<{ count: string; revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs
    WHERE event_type = 'order.paid'
      AND ${SQL_MAILX_EMAIL}
      AND ${SQL_IS_RECOVERY}
  `);

  // AC reporting aggregated across all clients with credentials
  const clientsWithAc = await query<{ id: number; ac_api_url: string; ac_api_key: string }>(
    `SELECT id, ac_api_url, ac_api_key FROM clients WHERE ac_api_url IS NOT NULL AND ac_api_key IS NOT NULL`
  );

  const acTotals = { send_amt: 0, opens: 0, uniqueopens: 0, linkclicks: 0, uniquelinkclicks: 0, contacts: 0 };
  let clientsWithAcSuccess = 0;
  const acResults = await Promise.all(
    clientsWithAc.map(async (c) => {
      try {
        const ac = new ActiveCampaignClient(c.ac_api_url, c.ac_api_key);
        const [agg, newContacts] = await Promise.all([
          ac.getCampaignsAggregate(30),
          ac.getNewContactsCount(30),
        ]);
        return { ok: true as const, agg, newContacts };
      } catch (err: any) {
        logger.warn(CTX, `Dashboard email: AC fetch failed for client ${c.id}: ${err.message}`);
        return { ok: false as const };
      }
    })
  );
  for (const r of acResults) {
    if (!r.ok) continue;
    acTotals.send_amt += r.agg.send_amt;
    acTotals.opens += r.agg.opens;
    acTotals.uniqueopens += r.agg.uniqueopens;
    acTotals.linkclicks += r.agg.linkclicks;
    acTotals.uniquelinkclicks += r.agg.uniquelinkclicks;
    acTotals.contacts += r.newContacts;
    clientsWithAcSuccess++;
  }

  // Assume USD — dashboards agregados ainda não têm suporte a multi-moeda (ver client-level fix)
  const fmtBRL = (v: number) => '$\u00A0' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const emailRev = parseFloat(emailSales?.revenue || '0');
  const ctr = acTotals.send_amt > 0 ? (acTotals.uniquelinkclicks / acTotals.send_amt) * 100 : 0;
  const openRate = acTotals.send_amt > 0 ? (acTotals.uniqueopens / acTotals.send_amt) * 100 : 0;
  const ctor = acTotals.uniqueopens > 0 ? (acTotals.uniquelinkclicks / acTotals.uniqueopens) * 100 : 0;
  const rpm = acTotals.send_amt > 0 ? (emailRev / acTotals.send_amt) * 1000 : 0;
  const epc = acTotals.uniquelinkclicks > 0 ? emailRev / acTotals.uniquelinkclicks : 0;

  res.json({
    revenue: {
      faturamento_email: fmtBRL(emailRev),
      vendas_email: parseInt(emailSales?.count || '0'),
      recuperacoes_email: parseInt(emailRecoveries?.count || '0'),
      faturamento_recuperacoes_email: fmtBRL(parseFloat(emailRecoveries?.revenue || '0')),
    },
    email_kpis: {
      entrada_contatos: acTotals.contacts.toLocaleString('pt-BR'),
      ctr: `${ctr.toFixed(2)}%`,
      taxa_abertura: `${openRate.toFixed(2)}%`,
      ctor: `${ctor.toFixed(2)}%`,
      rpm: fmtBRL(rpm),
      epc: fmtBRL(epc),
    },
    clients_with_ac: clientsWithAcSuccess,
  });
}));

// GET /admin/dashboard/sms - Aggregated SMS marketing KPIs across all clients
adminRouter.get('/dashboard/sms', asyncHandler(async (_req: Request, res: Response) => {
  // Sales aggregates filtered to SMS-driven MailX traffic
  const smsSales = await queryOne<{ count: string; revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs
    WHERE event_type = 'order.paid'
      AND ${SQL_MAILX_SMS}
  `);
  const smsRecoveries = await queryOne<{ count: string; revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs
    WHERE event_type = 'order.paid'
      AND ${SQL_MAILX_SMS}
      AND ${SQL_IS_RECOVERY}
  `);

  // SlickText aggregated across all clients com credenciais — um cliente pode ter mais de uma
  // conta SlickText rodando em paralelo (ver getSlickTextAccounts), soma todas.
  const clientIdsWithSt = await query<{ id: number }>(`
    SELECT id FROM clients WHERE st_api_token IS NOT NULL AND st_brand_id IS NOT NULL
    UNION
    SELECT DISTINCT client_id as id FROM client_slicktext_accounts
  `);

  const stTotals = { contacts: 0, total_credits: 0, credits_used: 0, credits_available: 0, lists: 0 };
  for (const c of clientIdsWithSt) {
    const clientAccounts = await getSlickTextAccounts(c.id);
    for (const acc of clientAccounts) {
      try {
        const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
        const [contactAnalytics, usage, lists] = await Promise.all([
          st.getContactAnalytics().catch(() => null),
          st.getBrandUsage().catch(() => null),
          st.getLists().catch(() => []),
        ]);
        if (contactAnalytics?.totals?.total) stTotals.contacts += contactAnalytics.totals.total;
        if (usage) {
          stTotals.total_credits += usage.total_credits || 0;
          stTotals.credits_used += usage.credits_used || 0;
          stTotals.credits_available += usage.credits_available || 0;
        }
        stTotals.lists += Array.isArray(lists) ? lists.length : 0;
      } catch (err: any) {
        logger.warn(CTX, `Dashboard sms: SlickText fetch failed for client ${c.id} (conta ${acc.label}): ${err.message}`);
      }
    }
  }

  // Assume USD — dashboards agregados ainda não têm suporte a multi-moeda (ver client-level fix)
  const fmtBRL = (v: number) => '$\u00A0' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  res.json({
    revenue: {
      faturamento_sms: fmtBRL(parseFloat(smsSales?.revenue || '0')),
      vendas_sms: parseInt(smsSales?.count || '0'),
      recuperacoes_sms: parseInt(smsRecoveries?.count || '0'),
      faturamento_recuperacoes_sms: fmtBRL(parseFloat(smsRecoveries?.revenue || '0')),
    },
    sms_kpis: {
      total_contatos: stTotals.contacts.toLocaleString('pt-BR'),
      creditos_disponiveis: stTotals.credits_available.toLocaleString('pt-BR'),
      creditos_usados: stTotals.credits_used.toLocaleString('pt-BR'),
      total_creditos: stTotals.total_credits.toLocaleString('pt-BR'),
      listas_sms: stTotals.lists.toLocaleString('pt-BR'),
    },
    clients_with_st: clientIdsWithSt.length,
  });
}));

// GET /admin/dashboard/pipeline-kpis - Per-client KPIs for pipeline cards
adminRouter.get('/dashboard/pipeline-kpis', asyncHandler(async (_req: Request, res: Response) => {
  // Faturamento + vendas totais por cliente (últimos 30 dias e total)
  const sales = await query<{
    client_id: number;
    vendas_total: string;
    faturamento_total: string;
    vendas_30d: string;
    faturamento_30d: string;
  }>(`
    SELECT
      client_id,
      COUNT(*) FILTER (WHERE event_type = 'order.paid' AND status = 'processed') AS vendas_total,
      COALESCE(SUM(total_price) FILTER (WHERE event_type = 'order.paid' AND status = 'processed'), 0) AS faturamento_total,
      COUNT(*) FILTER (WHERE event_type = 'order.paid' AND status = 'processed' AND created_at >= NOW() - INTERVAL '30 days') AS vendas_30d,
      COALESCE(SUM(total_price) FILTER (WHERE event_type = 'order.paid' AND status = 'processed' AND created_at >= NOW() - INTERVAL '30 days'), 0) AS faturamento_30d
    FROM webhook_logs
    WHERE client_id IS NOT NULL
    GROUP BY client_id
  `);

  // Emails disparados = webhooks processados que geram email (order.paid + abandoned_cart + card.declined)
  const emails = await query<{ client_id: number; emails_disparados: string }>(`
    SELECT
      client_id,
      COUNT(*) AS emails_disparados
    FROM webhook_logs
    WHERE client_id IS NOT NULL
      AND status = 'processed'
      AND event_type IN ('order.paid', 'abandoned_cart', 'card.declined')
    GROUP BY client_id
  `);

  // Faturamento diário últimos 7 dias por cliente (para sparkline)
  const daily = await query<{ client_id: number; day: string; faturamento: string }>(`
    SELECT
      client_id,
      TO_CHAR(DATE_TRUNC('day', created_at), 'DD/MM') AS day,
      COALESCE(SUM(total_price), 0) AS faturamento
    FROM webhook_logs
    WHERE client_id IS NOT NULL
      AND event_type = 'order.paid'
      AND status = 'processed'
      AND created_at >= NOW() - INTERVAL '7 days'
    GROUP BY client_id, DATE_TRUNC('day', created_at)
    ORDER BY client_id, DATE_TRUNC('day', created_at)
  `);

  // Assume USD — dashboards agregados ainda não têm suporte a multi-moeda (ver client-level fix)
  const fmtBRL = (v: number) => '$\u00A0' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Build a map indexed by client_id
  const emailsMap = new Map(emails.map(e => [e.client_id, parseInt(e.emails_disparados)]));
  const dailyMap = new Map<number, { labels: string[]; values: number[] }>();
  for (const row of daily) {
    const id = row.client_id;
    if (!dailyMap.has(id)) dailyMap.set(id, { labels: [], values: [] });
    dailyMap.get(id)!.labels.push(row.day);
    dailyMap.get(id)!.values.push(parseFloat(row.faturamento));
  }

  const kpis: Record<number, object> = {};
  for (const row of sales) {
    const id = row.client_id;
    const fat30d = parseFloat(row.faturamento_30d);
    const fatTotal = parseFloat(row.faturamento_total);
    kpis[id] = {
      vendas_total: parseInt(row.vendas_total),
      faturamento_total: fmtBRL(fatTotal),
      vendas_30d: parseInt(row.vendas_30d),
      faturamento_30d: fmtBRL(fat30d),
      emails_disparados: emailsMap.get(id) ?? 0,
      sparkline: dailyMap.get(id) ?? { labels: [], values: [] },
    };
  }

  res.json({ kpis });
}));

// ── Store Integration Endpoints ──

// POST /admin/integration/test - Test if CartPanda store URL is reachable
adminRouter.post('/integration/test', asyncHandler(async (req: Request, res: Response) => {
  const { shop_slug } = req.body;

  if (!shop_slug) {
    res.status(400).json({ ok: false, error: 'shop_slug é obrigatório' });
    return;
  }

  const storeUrl = `https://${shop_slug}.cartpanda.com`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(storeUrl, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (response.ok || response.status === 301 || response.status === 302 || response.status === 403) {
      // Store exists (even 403 means the domain resolves to CartPanda)
      res.json({ ok: true, status: response.status, url: storeUrl });
    } else {
      res.json({ ok: false, error: `Loja retornou status ${response.status}`, url: storeUrl });
    }
  } catch (e: any) {
    logger.warn(CTX, `Store test failed for ${shop_slug}: ${e.message}`);
    res.json({ ok: false, error: 'Não foi possível acessar a loja. Verifique o slug.', url: storeUrl });
  }
}));

// POST /admin/integration/store - Save new store integration
adminRouter.post('/integration/store', asyncHandler(async (req: Request, res: Response) => {
  const { shop_slug, api_token, events, platform, display_name } = req.body;

  if (!shop_slug || !api_token) {
    res.status(400).json({ error: 'shop_slug and api_token are required' });
    return;
  }

  const storePlatform = platform || 'cartpanda';
  logger.info(CTX, `New store integration: ${storePlatform}/${shop_slug}`, { events });

  // Store the integration in the database with 'pending' status (not yet validated via webhook)
  await query(
    `INSERT INTO store_integrations (platform, shop_slug, api_token, events, status, display_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (shop_slug, platform) DO UPDATE SET api_token = $3, events = $4, updated_at = NOW()`,
    [storePlatform, shop_slug, api_token, JSON.stringify(events || {}), 'pending', display_name || null]
  );

  res.json({ ok: true, shop_slug, platform: storePlatform });
}));

// ── Existing API Endpoints ──

// GET /admin/server-today - Data atual segundo o próprio Postgres (evita depender do
// fuso-horário do navegador de quem está usando o filtro "Hoje").
adminRouter.get('/server-today', asyncHandler(async (_req: Request, res: Response) => {
  const row = await queryOne<{ today: string }>(`SELECT CURRENT_DATE::text as today`);
  res.json({ date: row?.today });
}));

// GET /admin/stats - Dashboard counters
adminRouter.get('/stats', asyncHandler(async (_req: Request, res: Response) => {
  const clientsCount = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM clients`);
  const webhooksToday = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE created_at >= CURRENT_DATE`
  );

  res.json({
    clients: parseInt(clientsCount?.count || '0'),
    webhooks_today: parseInt(webhooksToday?.count || '0'),
    status: 'online',
    db: 'connected'
  });
}));

// GET /admin/clientes - List all clients
adminRouter.get('/clientes', asyncHandler(async (_req: Request, res: Response) => {
  const clients = await query(`
    SELECT
      c.id,
      c.company_name,
      c.cnpj,
      c.website,
      c.contact_email,
      c.contact_whatsapp,
      c.cartpanda_store_url,
      CASE
        WHEN c.cartpanda_api_token IS NOT NULL
        THEN REPEAT('•', GREATEST(LENGTH(c.cartpanda_api_token) - 6, 0)) || RIGHT(c.cartpanda_api_token, 6)
        ELSE NULL
      END AS cartpanda_api_token,
      c.ac_api_url,
      CASE
        WHEN c.ac_api_key IS NOT NULL
        THEN REPEAT('•', GREATEST(LENGTH(c.ac_api_key) - 6, 0)) || RIGHT(c.ac_api_key, 6)
        ELSE NULL
      END AS ac_api_key,
      c.ac_plan,
      CASE
        WHEN c.st_api_token IS NOT NULL
        THEN REPEAT('•', GREATEST(LENGTH(c.st_api_token) - 6, 0)) || RIGHT(c.st_api_token, 6)
        ELSE NULL
      END AS st_api_token,
      c.st_brand_id,
      c.dns_registrar,
      c.dns_manages_own,
      c.logo_url,
      c.brand_color_primary,
      c.brand_color_secondary,
      c.tone_of_voice,
      c.google_postmaster_access,
      c.google_drive_folder_url,
      c.status,
      c.created_at,
      c.updated_at,
      (SELECT json_agg(k.*) FROM kits k WHERE k.client_id = c.id) as kits
    FROM clients c
    WHERE c.status IS DISTINCT FROM 'paused'
    ORDER BY c.created_at DESC
  `);
  res.json({ count: clients.length, clients });
}));

// GET /admin/clientes/:id - Single client
adminRouter.get('/clientes/:id', asyncHandler(async (req: Request, res: Response) => {
  const clients = await query(`
    SELECT
      c.id,
      c.company_name,
      c.cnpj,
      c.website,
      c.contact_email,
      c.contact_whatsapp,
      c.cartpanda_store_url,
      CASE
        WHEN c.cartpanda_api_token IS NOT NULL
        THEN REPEAT('•', GREATEST(LENGTH(c.cartpanda_api_token) - 6, 0)) || RIGHT(c.cartpanda_api_token, 6)
        ELSE NULL
      END AS cartpanda_api_token,
      c.ac_api_url,
      CASE
        WHEN c.ac_api_key IS NOT NULL
        THEN REPEAT('•', GREATEST(LENGTH(c.ac_api_key) - 6, 0)) || RIGHT(c.ac_api_key, 6)
        ELSE NULL
      END AS ac_api_key,
      c.ac_plan,
      CASE
        WHEN c.st_api_token IS NOT NULL
        THEN REPEAT('•', GREATEST(LENGTH(c.st_api_token) - 6, 0)) || RIGHT(c.st_api_token, 6)
        ELSE NULL
      END AS st_api_token,
      c.st_brand_id,
      c.dns_registrar,
      c.dns_manages_own,
      c.logo_url,
      c.brand_color_primary,
      c.brand_color_secondary,
      c.tone_of_voice,
      c.google_postmaster_access,
      c.google_drive_folder_url,
      c.status,
      c.created_at,
      c.updated_at,
      (SELECT json_agg(k.*) FROM kits k WHERE k.client_id = c.id) as kits
    FROM clients c
    WHERE c.id = $1
  `, [req.params.id]);

  if (clients.length === 0) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  res.json(clients[0]);
}));

// PATCH /admin/clientes/:id/status - Change status
adminRouter.patch('/clientes/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'configuring', 'dns_pending', 'active', 'paused'];

  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status` });
    return;
  }

  await query(
    `UPDATE clients SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, req.params.id]
  );
  logger.info(CTX, `Client ${req.params.id} status updated to ${status}`);
  res.json({ ok: true });
}));

// PATCH /admin/clientes/:id/ac-credentials - Update AC credentials
adminRouter.patch('/clientes/:id/ac-credentials', asyncHandler(async (req: Request, res: Response) => {
  const { ac_api_url, ac_api_key } = req.body;

  if (!ac_api_url || !ac_api_key) {
    res.status(400).json({ error: 'ac_api_url and ac_api_key are required' });
    return;
  }

  await query(
    `UPDATE clients SET ac_api_url = $1, ac_api_key = $2, updated_at = NOW() WHERE id = $3`,
    [ac_api_url, ac_api_key, req.params.id]
  );
  logger.info(CTX, `Client ${req.params.id} AC credentials updated`);
  res.json({ ok: true });
}));

// PATCH /admin/clientes/:id/st-credentials - Update SlickText credentials
adminRouter.patch('/clientes/:id/st-credentials', asyncHandler(async (req: Request, res: Response) => {
  const { st_api_token, st_brand_id } = req.body;

  if (!st_api_token || !st_brand_id) {
    res.status(400).json({ error: 'st_api_token and st_brand_id are required' });
    return;
  }

  await query(
    `UPDATE clients SET st_api_token = $1, st_brand_id = $2, updated_at = NOW() WHERE id = $3`,
    [st_api_token, st_brand_id, req.params.id]
  );
  logger.info(CTX, `Client ${req.params.id} SlickText credentials updated`);
  res.json({ ok: true });
}));

interface AcAccountRef { accountId: number | null; label: string; ac_api_url: string; ac_api_key: string; }

/**
 * Todas as contas de ActiveCampaign de um cliente: a principal (clients.ac_api_url/ac_api_key)
 * mais as adicionais de client_activecampaign_accounts. Mesmo desenho de getSlickTextAccounts —
 * confirmado com o Murilo que um cliente pode ter mais de uma conta, com divisão de
 * responsabilidade entre elas (ex: uma cuidando de compra aprovada e outra de abandono).
 */
async function getActiveCampaignAccounts(clientId: number | string): Promise<AcAccountRef[]> {
  const client = await queryOne<{ ac_api_url: string | null; ac_api_key: string | null }>(
    `SELECT ac_api_url, ac_api_key FROM clients WHERE id = $1`, [clientId]
  );
  const extra = await query<{ id: number; label: string | null; ac_api_url: string; ac_api_key: string }>(
    `SELECT id, label, ac_api_url, ac_api_key FROM client_activecampaign_accounts WHERE client_id = $1 ORDER BY id`,
    [clientId]
  );

  const accounts: AcAccountRef[] = [];
  if (client?.ac_api_url && client?.ac_api_key) {
    accounts.push({ accountId: null, label: 'Principal', ac_api_url: client.ac_api_url, ac_api_key: client.ac_api_key });
  }
  for (const row of extra) {
    accounts.push({ accountId: row.id, label: row.label || `Conta ${row.id}`, ac_api_url: row.ac_api_url, ac_api_key: row.ac_api_key });
  }
  return accounts;
}

// GET /admin/clientes/:id/ac-accounts - Lista contas ActiveCampaign adicionais (a principal fica
// em clients.ac_api_url/ac_api_key). Chave mascarada na resposta.
adminRouter.get('/clientes/:id/ac-accounts', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const rows = await query<{ id: number; label: string | null; ac_api_url: string; ac_api_key: string }>(
    `SELECT id, label, ac_api_url, ac_api_key FROM client_activecampaign_accounts WHERE client_id = $1 ORDER BY id`,
    [clientId]
  );
  res.json({
    accounts: rows.map(r => ({
      id: r.id,
      label: r.label,
      ac_api_url: r.ac_api_url,
      ac_api_key_masked: r.ac_api_key ? `${r.ac_api_key.slice(0, 6)}...${r.ac_api_key.slice(-4)}` : null,
    })),
  });
}));

// POST /admin/clientes/:id/ac-accounts - Adiciona uma conta ActiveCampaign ADICIONAL.
adminRouter.post('/clientes/:id/ac-accounts', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const { label, ac_api_url, ac_api_key } = req.body;

  if (!ac_api_url || !ac_api_key) {
    res.status(400).json({ error: 'ac_api_url e ac_api_key são obrigatórios' });
    return;
  }

  const row = await queryOne<{ id: number }>(
    `INSERT INTO client_activecampaign_accounts (client_id, label, ac_api_url, ac_api_key)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [clientId, label || null, String(ac_api_url).replace(/\/+$/, ''), ac_api_key]
  );
  logger.info(CTX, `Client ${clientId}: conta ActiveCampaign adicional criada (id=${row?.id})`);
  res.json({ ok: true, id: row?.id });
}));

// DELETE /admin/clientes/:id/ac-accounts/:accountId - Remove uma conta ActiveCampaign adicional.
adminRouter.delete('/clientes/:id/ac-accounts/:accountId', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const accountId = parseInt(req.params.accountId as string);
  await query(`DELETE FROM client_activecampaign_accounts WHERE id = $1 AND client_id = $2`, [accountId, clientId]);
  res.json({ ok: true });
}));

// GET /admin/clientes/:id/st-accounts - Lista contas SlickText adicionais do cliente (além da
// principal, que fica em clients.st_api_token/st_brand_id). Token mascarado na resposta.
adminRouter.get('/clientes/:id/st-accounts', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const rows = await query<{ id: number; label: string | null; st_brand_id: string; st_api_token: string }>(
    `SELECT id, label, st_brand_id, st_api_token FROM client_slicktext_accounts WHERE client_id = $1 ORDER BY id`,
    [clientId]
  );
  res.json({
    accounts: rows.map(r => ({
      id: r.id,
      label: r.label,
      st_brand_id: r.st_brand_id,
      st_api_token_masked: r.st_api_token ? `${r.st_api_token.slice(0, 6)}...${r.st_api_token.slice(-4)}` : null,
    })),
  });
}));

// POST /admin/clientes/:id/st-accounts - Adiciona uma conta SlickText ADICIONAL pro cliente (o
// mesmo cliente pode rodar SMS por mais de um número/marca em paralelo pro mesmo produto).
adminRouter.post('/clientes/:id/st-accounts', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const { label, st_api_token, st_brand_id } = req.body;

  if (!st_api_token || !st_brand_id) {
    res.status(400).json({ error: 'st_api_token e st_brand_id são obrigatórios' });
    return;
  }

  const row = await queryOne<{ id: number }>(
    `INSERT INTO client_slicktext_accounts (client_id, label, st_api_token, st_brand_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [clientId, label || null, st_api_token, st_brand_id]
  );
  logger.info(CTX, `Client ${clientId}: conta SlickText adicional criada (id=${row?.id}, brand=${st_brand_id})`);
  res.json({ ok: true, id: row?.id });
}));

// DELETE /admin/clientes/:id/st-accounts/:accountId - Remove uma conta SlickText adicional.
adminRouter.delete('/clientes/:id/st-accounts/:accountId', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const accountId = parseInt(req.params.accountId as string);
  await query(`DELETE FROM client_slicktext_accounts WHERE id = $1 AND client_id = $2`, [accountId, clientId]);
  res.json({ ok: true });
}));

// POST /admin/clientes/:id/bootstrap - Run AC setup
adminRouter.post('/clientes/:id/bootstrap', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  logger.info(CTX, `Triggering bootstrap for client ${clientId} via API`);

  const result = await runBootstrap(clientId);

  if (result.success) {
    res.json({ ok: true, result });
  } else {
    res.status(400).json({ ok: false, errors: result.errors });
  }
}));

// GET /admin/clientes/:id/dns - Get DNS records for domain
adminRouter.get('/clientes/:id/dns', asyncHandler(async (req: Request, res: Response) => {
  const client = await queryOne<{ id: number, google_drive_folder_url: string }>(
    `SELECT id, google_drive_folder_url FROM clients WHERE id = $1`,
    [req.params.id]
  );

  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }

  const domain = process.env.SENDING_DOMAIN || 'envio.mailxgroup.com';
  const records = generateDnsRecords(domain, `client-${client.id}`);

  res.json({ domain, records });
}));

// GET /admin/clientes/:id/stats - Per-client KPIs and activity
adminRouter.get('/clientes/:id/stats', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const currency = await resolveClientCurrency(clientId);
  const symbol = currencySymbol(currency);

  // Período de análise: "Hoje" (?today=1), intervalo from/to, ou vitalício (nenhum dos dois).
  // Aplicado em TODAS as métricas de negócio abaixo — antes só afetava 2-3 gráficos.
  const period = resolvePeriodFilter(req);
  const periodFrom = period.from;
  const periodTo = period.to;
  const periodActive = period.isToday || !!(period.from && period.to);

  // Get all store slugs for this client to filter webhook_logs
  const stores = await query<{ shop_slug: string, platform: string }>(
    `SELECT shop_slug, COALESCE(platform, 'cartpanda') as platform FROM store_integrations WHERE client_id = $1`,
    [clientId]
  );

  // Sales KPIs — filtered by client_id + período
  const salesParams: (string | number)[] = [clientId];
  const salesPeriod = periodSql(period, salesParams);
  const salesData = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND status IN ('processed', 'processing') AND client_id = $1
      ${salesPeriod ? `AND ${salesPeriod}` : ''}
  `, salesParams);

  const whParams: (string | number)[] = [clientId];
  const whPeriod = periodSql(period, whParams);
  const totalWebhooks = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE client_id = $1 ${whPeriod ? `AND ${whPeriod}` : ''}`, whParams
  );
  // "Hoje" é sempre literal (independe do período de análise selecionado) — diagnóstico de saúde da integração.
  const webhooksToday = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE created_at >= CURRENT_DATE AND client_id = $1`, [clientId]
  );
  const refundParams: (string | number)[] = [clientId];
  const refundPeriod = periodSql(period, refundParams);
  const refundCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE event_type IN ('order.refunded', 'order.chargeback') AND client_id = $1
      ${refundPeriod ? `AND ${refundPeriod}` : ''}`, refundParams
  );

  const totalSales = parseInt(salesData?.count || '0');
  const totalRevenue = parseFloat(salesData?.revenue || '0');
  const ticketMedio = totalSales > 0 ? totalRevenue / totalSales : 0;
  const totalWh = parseInt(totalWebhooks?.count || '0');

  const abandonedParams: (string | number)[] = [clientId];
  const abandonedPeriod = periodSql(period, abandonedParams);
  const abandonedCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE event_type = 'abandoned_cart' AND client_id = $1
      ${abandonedPeriod ? `AND ${abandonedPeriod}` : ''}`, abandonedParams
  );
  const declinedParams: (string | number)[] = [clientId];
  const declinedPeriod = periodSql(period, declinedParams);
  const declinedCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE event_type = 'card.declined' AND client_id = $1
      ${declinedPeriod ? `AND ${declinedPeriod}` : ''}`, declinedParams
  );
  const abandoned = parseInt(abandonedCount?.count || '0');
  const declined = parseInt(declinedCount?.count || '0');
  const totalOpps = totalSales + abandoned + declined;
  const successRate = totalOpps > 0 ? ((totalSales / totalOpps) * 100).toFixed(1) : '0';

  // MailX UTM metrics — filtered by client_id + período
  const mailxParams: (string | number)[] = [clientId];
  const mailxPeriod = periodSql(period, mailxParams);
  const mailxData = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_IS_MAILX}
      ${mailxPeriod ? `AND ${mailxPeriod}` : ''}
  `, mailxParams);
  const mailxRecParams: (string | number)[] = [clientId];
  const mailxRecPeriod = periodSql(period, mailxRecParams);
  const mailxRecoveries = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_IS_MAILX}
      AND ${SQL_IS_RECOVERY}
      ${mailxRecPeriod ? `AND ${mailxRecPeriod}` : ''}
  `, mailxRecParams);

  const emailMailxParams: (string | number)[] = [clientId];
  const emailPeriod = periodSql(period, emailMailxParams);
  const emailMailxData = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_MAILX_EMAIL}
      ${emailPeriod ? `AND ${emailPeriod}` : ''}
  `, emailMailxParams);
  const emailMailxRecParams: (string | number)[] = [clientId];
  const emailRecPeriod = periodSql(period, emailMailxRecParams);
  const emailMailxRecoveries = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_MAILX_EMAIL}
      AND ${SQL_IS_RECOVERY}
      ${emailRecPeriod ? `AND ${emailRecPeriod}` : ''}
  `, emailMailxRecParams);
  const emailMailxUpsellParams: (string | number)[] = [clientId];
  const emailUpsellPeriod = periodSql(period, emailMailxUpsellParams);
  const emailMailxUpsell = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_MAILX_EMAIL}
      AND ${SQL_IS_UPSELL}
      ${emailUpsellPeriod ? `AND ${emailUpsellPeriod}` : ''}
  `, emailMailxUpsellParams);

  // Top 5 products — filtered by client_id + período
  const topProductsParams: (string | number)[] = [clientId];
  const topProductsPeriod = periodSql(period, topProductsParams);
  const topProducts = await query<{ name: string, count: string, revenue: string }>(`
    SELECT
      product_name as name,
      COUNT(*) as count,
      ${SQL_REVENUE} as revenue
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND client_id = $1
      AND product_name IS NOT NULL
      ${topProductsPeriod ? `AND ${topProductsPeriod}` : ''}
    GROUP BY product_name ORDER BY count DESC LIMIT 5
  `, topProductsParams);

  // Recent webhooks — feed operacional, sempre os mais recentes (não segue o período de análise)
  const recentWebhooks = await query(`
    SELECT id, event_type, source, status, error, created_at, processed_at
    FROM webhook_logs
    WHERE client_id = $1
    ORDER BY created_at DESC
    LIMIT 10
  `, [clientId]);

  // Daily activity — últimos 7 dias, diagnóstico de saúde da integração (não segue o período de análise)
  const dailyActivity = await query<{ day: string, count: string }>(`
    SELECT TO_CHAR(created_at, 'DD/MM') as day, COUNT(*) as count
    FROM webhook_logs
    WHERE created_at >= NOW() - INTERVAL '7 days' AND client_id = $1
    GROUP BY TO_CHAR(created_at, 'DD/MM'), DATE(created_at)
    ORDER BY DATE(created_at)
  `, [clientId]);

  // ── Vendas por Hora — filtered by client_id + período ──
  const hourlyParams: (string | number)[] = [clientId];
  const hourlyPeriod = periodSql(period, hourlyParams);
  const hourlyWebhooks = await query<{ hour: string, count: string }>(`
    SELECT EXTRACT(HOUR FROM created_at)::text as hour, COUNT(*) as count
    FROM webhook_logs
    WHERE client_id = $1 ${hourlyPeriod ? `AND ${hourlyPeriod}` : ''}
    GROUP BY EXTRACT(HOUR FROM created_at)
    ORDER BY EXTRACT(HOUR FROM created_at)
  `, hourlyParams);
  const hourlyValues = Array.from({ length: 24 }, (_, i) => {
    const match = hourlyWebhooks.find(r => parseInt(r.hour) === i);
    return match ? parseInt(match.count) : 0;
  });

  // ── Top 5 Tipos de Evento — filtered by client_id + período ──
  const eventDistParams: (string | number)[] = [clientId];
  const eventDistPeriod = periodSql(period, eventDistParams);
  const eventDist = await query<{ event_type: string, count: string }>(`
    SELECT event_type, COUNT(*) as count
    FROM webhook_logs
    WHERE client_id = $1 ${eventDistPeriod ? `AND ${eventDistPeriod}` : ''}
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 5
  `, eventDistParams);

  // ── Conversion Funnel (envios por venda) ──
  const enviosPorVenda = totalSales > 0 ? Math.round(totalWh / totalSales) : 0;

  const fmtBRL = (v: number) => `${symbol}\u00A0` + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Desempenho por Caminho (utm_term) — o teste de variação ──
  // O UTMS_DASH define utm_term como "Produto-CaminhoA/B/C": são variações da mesma mensagem
  // rodando em paralelo. O dado era gravado e nunca usado, então não havia como saber qual
  // caminho converte melhor. Agrupa por canal também, porque email e SMS testam separado.
  const caminhoParams: (string | number)[] = [clientId];
  const caminhoPeriod = periodSql(period, caminhoParams);
  const caminhosRaw = await query<{ caminho: string; canal: string; vendas: string; receita: string }>(`
    SELECT
      UPPER(SUBSTRING(utm_term FROM 'aminho[^a-zA-Z0-9]*([A-Za-z0-9])')) AS caminho,
      CASE WHEN ${SQL_IS_SMS} THEN 'SMS' ELSE 'Email' END AS canal,
      COUNT(*) AS vendas, ${SQL_REVENUE} AS receita
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing') AND client_id = $1
      AND ${SQL_IS_MAILX}
      AND utm_term ~* 'aminho'
      ${caminhoPeriod ? `AND ${caminhoPeriod}` : ''}
    GROUP BY 1, 2
    HAVING UPPER(SUBSTRING(utm_term FROM 'aminho[^a-zA-Z0-9]*([A-Za-z0-9])')) IS NOT NULL
    ORDER BY 2, 1
  `, caminhoParams);

  const desempenhoPorCaminho = (() => {
    const totalPorCanal = new Map<string, number>();
    caminhosRaw.forEach(r => totalPorCanal.set(r.canal, (totalPorCanal.get(r.canal) ?? 0) + parseFloat(r.receita)));
    return caminhosRaw.map(r => {
      const receita = parseFloat(r.receita);
      const totalCanal = totalPorCanal.get(r.canal) ?? 0;
      return {
        caminho: `Caminho ${r.caminho}`,
        canal: r.canal,
        vendas: parseInt(r.vendas),
        receita,
        receita_fmt: fmtBRL(receita),
        // Fatia DENTRO do canal — comparar caminho de SMS com caminho de email não diria nada.
        share_no_canal: totalCanal > 0 ? parseFloat((receita / totalCanal * 100).toFixed(1)) : 0,
      };
    });
  })();

  // ── Email: automação x campanha (os três mediums do UTMS_DASH) ──
  // auto-email é automação; campaign-editorial e campaing-promo (a documentação tem essa grafia)
  // são campanhas. A dash somava tudo em "Faturamento Email" sem distinguir.
  const emailMediumParams: (string | number)[] = [clientId];
  const emailMediumPeriod = periodSql(period, emailMediumParams);
  const emailPorTipo = await queryOne<Record<string, string>>(`
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(utm_medium, '') ILIKE '%auto-email%') AS automacao_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE COALESCE(utm_medium, '') ILIKE '%auto-email%'), 0) AS automacao_receita,
      COUNT(*) FILTER (WHERE COALESCE(utm_medium, '') ILIKE '%editorial%') AS editorial_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE COALESCE(utm_medium, '') ILIKE '%editorial%'), 0) AS editorial_receita,
      COUNT(*) FILTER (WHERE COALESCE(utm_medium, '') ILIKE '%promo%') AS promo_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE COALESCE(utm_medium, '') ILIKE '%promo%'), 0) AS promo_receita,
      COUNT(*) FILTER (WHERE COALESCE(utm_medium, '') NOT ILIKE '%auto-email%'
        AND COALESCE(utm_medium, '') NOT ILIKE '%editorial%'
        AND COALESCE(utm_medium, '') NOT ILIKE '%promo%') AS outro_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE COALESCE(utm_medium, '') NOT ILIKE '%auto-email%'
        AND COALESCE(utm_medium, '') NOT ILIKE '%editorial%'
        AND COALESCE(utm_medium, '') NOT ILIKE '%promo%'), 0) AS outro_receita
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing') AND client_id = $1
      AND ${SQL_MAILX_EMAIL}
      ${emailMediumPeriod ? `AND ${emailMediumPeriod}` : ''}
  `, emailMediumParams);

  const emailAutomacaoVsCampanha = (() => {
    const n = (k: string) => parseInt(emailPorTipo?.[k] || '0');
    const v = (k: string) => parseFloat(emailPorTipo?.[k] || '0');
    return [
      { tipo: 'Automação', medium: 'auto-email', vendas: n('automacao_vendas'), receita: v('automacao_receita') },
      { tipo: 'Campanha · Editorial', medium: 'campaign-editorial', vendas: n('editorial_vendas'), receita: v('editorial_receita') },
      { tipo: 'Campanha · Promo', medium: 'campaing-promo', vendas: n('promo_vendas'), receita: v('promo_receita') },
      { tipo: 'Outro medium', medium: '—', vendas: n('outro_vendas'), receita: v('outro_receita') },
    ].filter(i => i.vendas > 0).map(i => ({ ...i, receita_fmt: fmtBRL(i.receita) }));
  })();

  // ── Origem do faturamento: para onde vai o dinheiro que NÃO é MailX ──
  // Motivo: o inventário de UTMs mostrou 4.072 vendas / ~$1 milhão "não atribuídas", o que dava a
  // impressão de rastreio quebrado. O payload do Digistore revelou que 99% delas têm afiliado
  // identificado — é receita de afiliado, que chega pelo rastreio próprio do gateway (aff=) e não
  // carrega UTM. O dado existia na coluna affiliate_name e não era mostrado em lugar nenhum.
  // Explicitar isso responde de imediato por que a representatividade da MailX é o que é.
  const origemParams: (string | number)[] = [clientId];
  const origemPeriod = periodSql(period, origemParams);
  const origem = await queryOne<Record<string, string>>(`
    SELECT
      COUNT(*) FILTER (WHERE ${SQL_MAILX_SMS}) AS sms_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE ${SQL_MAILX_SMS}), 0) AS sms_receita,
      COUNT(*) FILTER (WHERE ${SQL_MAILX_EMAIL}) AS email_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE ${SQL_MAILX_EMAIL}), 0) AS email_receita,
      COUNT(*) FILTER (WHERE NOT ${SQL_IS_MAILX} AND NULLIF(TRIM(COALESCE(affiliate_name, '')), '') IS NOT NULL) AS afiliado_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE NOT ${SQL_IS_MAILX} AND NULLIF(TRIM(COALESCE(affiliate_name, '')), '') IS NOT NULL), 0) AS afiliado_receita,
      COUNT(*) FILTER (WHERE NOT ${SQL_IS_MAILX} AND NULLIF(TRIM(COALESCE(affiliate_name, '')), '') IS NULL
        AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)) AS outra_utm_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE NOT ${SQL_IS_MAILX} AND NULLIF(TRIM(COALESCE(affiliate_name, '')), '') IS NULL
        AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)), 0) AS outra_utm_receita,
      COUNT(*) FILTER (WHERE NOT ${SQL_IS_MAILX} AND NULLIF(TRIM(COALESCE(affiliate_name, '')), '') IS NULL
        AND utm_source IS NULL AND utm_medium IS NULL AND utm_campaign IS NULL) AS sem_rastreio_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE NOT ${SQL_IS_MAILX} AND NULLIF(TRIM(COALESCE(affiliate_name, '')), '') IS NULL
        AND utm_source IS NULL AND utm_medium IS NULL AND utm_campaign IS NULL), 0) AS sem_rastreio_receita
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed', 'processing') AND client_id = $1
      ${origemPeriod ? `AND ${origemPeriod}` : ''}
  `, origemParams);

  const origemDoFaturamento = (() => {
    const n = (k: string) => parseInt(origem?.[k] || '0');
    const v = (k: string) => parseFloat(origem?.[k] || '0');
    const itens = [
      { origem: 'MailX · SMS', vendas: n('sms_vendas'), receita: v('sms_receita'), e_mailx: true },
      { origem: 'MailX · Email', vendas: n('email_vendas'), receita: v('email_receita'), e_mailx: true },
      { origem: 'Afiliado', vendas: n('afiliado_vendas'), receita: v('afiliado_receita'), e_mailx: false,
        nota: 'Rastreio próprio do gateway (aff=), sem UTM — não passa pela MailX.' },
      { origem: 'Outra origem com UTM', vendas: n('outra_utm_vendas'), receita: v('outra_utm_receita'), e_mailx: false,
        nota: 'Mídia paga do próprio cliente (Facebook, Taboola etc).' },
      { origem: 'Sem rastreio', vendas: n('sem_rastreio_vendas'), receita: v('sem_rastreio_receita'), e_mailx: false,
        nota: 'Nem UTM nem afiliado — direto, orgânico ou link sem marcação.' },
    ];
    const totalReceita = itens.reduce((a, i) => a + i.receita, 0);
    return itens
      .filter(i => i.vendas > 0)
      .map(i => ({ ...i, receita_fmt: fmtBRL(i.receita), share: totalReceita > 0 ? parseFloat((i.receita / totalReceita * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.receita - a.receita);
  })();

  // ── Conversão por Segmento: leads via SlickText (lista Compra/Abandono). ──
  // Vitalício — CONFIRMADO via probe em produção que /analytics/contacts NÃO aceita filtro
  // por lista (list_id e _list_id devolvem o mesmo total do brand inteiro, igual sem filtro
  // nenhum: 66.774 nos três casos). Trocado pra GET /lists/{id}/contacts/count, o mesmo
  // endpoint já usado (e confirmado certo) no card "Listas por Produto" — não filtra por
  // período, mas ao menos devolve o número CORRETO de cada lista.
  // Vendas continuam vindo do nosso banco (já são exatas, é conversão real registrada).
  let abandonoLeads = 0;
  let compradorLeads = 0;
  type FonteDeLeads = 'webhook_exato' | 'slicktext_list' | 'snapshot_delta' | 'unavailable';
  let leadsSource: FonteDeLeads = 'unavailable';
  // Fonte dos leads de COMPRA especificamente — pode divergir da do abandono (ver comentário mais
  // abaixo, perto de onde ela é calculada).
  let compradorLeadsSource: FonteDeLeads = 'unavailable';
  let leadsWarning: string | null = null;
  let leadsPeriodoInfo: { de: string; ate: string; janela_bate: boolean } | null = null;
  // Janela dos leads de COMPRA especificamente — quando vem do webhook, é sempre exata (não tem
  // folga de retrato pra estourar o período), então não pode compartilhar leadsPeriodoInfo com o
  // abandono, que continua podendo ter janela aproximada.
  let leadsPeriodoInfoCompra: { de: string; ate: string; janela_bate: boolean } | null = null;
  let leadsRetratos: { primeiro_retrato: string; dias_com_retrato: number } | null = null;
  // Contraprova: quantos leads o retrato mediu na lista de compra contra quantos a gente
  // conseguiu explicar por venda registrada — a diferença é o tamanho do que entrou por um
  // caminho que não capturamos (ver leadsDeCompraViaWebhookLogs).
  let compraDivergencia: { do_retrato: number; explicado_por_venda: number; diferenca: number } | null = null;
  // Insumos da conversão POR PRODUTO (pedido 3.4 do documento: "precisa ser dividido por produto").
  let contagemPorLista = new Map<string, number>();
  let kitsComListas: Array<{ nome: string; listasAbandono: string[]; listasCompra: string[] }> = [];
  // Quais listas, dentro de contagemPorLista, têm número DO PERÍODO (snapshot_delta ou
  // webhook_exato) — as únicas em que dividir vendas do período por esses leads produz uma taxa
  // de verdade. As de fora têm número VITALÍCIO (tamanho atual da lista inteira, acumulado desde
  // sempre) misturado com venda de um recorte de dias — dividir os dois não é taxa "aproximada",
  // é comparar coisas de janelas de tempo diferentes, e o resultado pode ficar uma ou duas ordens
  // de grandeza menor que a conversão real (visto em produção: 0,98% quando o denominador tinha
  // 9+ meses de gente acumulada contra 30 dias de venda). Produto cuja lista caia fora daqui não
  // ganha taxa nenhuma — "não calculável" é mais honesto que um número pequeno demais.
  let listasComNumeroDoPeriodo = new Set<string>();
  // Status de retrato de CADA lista de produto ativo — não só a em standby, a Murilo pediu pra
  // ver as datas das já estabelecidas também. Lista recém-conectada (troca de conta/lista no
  // workflow, gateway novo, produto migrado) ainda sem retrato suficiente pra entrar em cálculo
  // de período nenhum entra com standby:true. Sem isso, uma troca no meio do mês passa muda: a
  // tela continua respondendo (cai no vitalício, que sempre tem número), e ninguém percebe que
  // aquela lista ficou sem histórico até a taxa estranhar semanas depois. Quem troca lista/conta
  // no workflow é o Murilo — precisa ver na hora, não descobrir por reclamação do Nicollas.
  let listasRetratoStatus: Array<{ produto: string; segmento: 'abandono' | 'compra'; list_id: string; standby: boolean; desde: string | null; dias_gravados: number; datas: string[] }> = [];

  {
    // Todas as contas SlickText do cliente, não só a principal. Bug encontrado ao validar o SMS:
    // este bloco lia apenas clients.st_api_token, então as listas que vivem na segunda conta
    // devolviam 0 (getListContactCount engole o erro) e entravam na soma como se estivessem
    // vazias — leads subcontados e taxa de conversão inflada, sem nenhum aviso na tela.
    const contas = await getSlickTextAccounts(clientId as string);
    if (contas.length > 0) {
      try {
        const clients = contas.map(acc => ({ acc, st: new SlickTextClient(acc.st_api_token, acc.st_brand_id) }));
        // Auto-vínculo roda na primeira conta (é onde vivem as listas de produto); as demais só
        // Auto-vínculo de produto -> lista roda em TODAS as contas, uma depois da outra.
        //
        // Antes rodava só na primeira, com a suposição de que "é onde vivem as listas de produto".
        // A suposição quebra no momento em que alguém cadastra uma conta nova e coloca listas nela:
        // o produto ficava eternamente sem lista, os leads dele não entravam na conta, e o único
        // sintoma era um aviso de "produto sem lista vinculada" que não tinha como ser resolvido
        // clicando em nada — porque o Auto-vincular da tela cuida de mensagem -> workflow, e não
        // de produto -> lista.
        //
        // Sequencial de propósito: cada chamada lista as listas de uma marca e grava os vínculos que
        // achou; em paralelo, duas contas poderiam gravar em cima do mesmo kit. Um produto é
        // considerado sem lista só quando NENHUMA conta tinha a lista dele — por isso o unmatched
        // final é a interseção, não o da última conta.
        let unmatched: Array<{ kitId: number; kitName: string }> = [];
        for (let i = 0; i < clients.length; i++) {
          const r = await autoLinkSlickTextLists(clients[i]!.st, parseInt(clientId as string));
          unmatched = i === 0 ? r.unmatched : unmatched.filter(u => r.unmatched.some(x => x.kitId === u.kitId));
        }
        const kits = await query<{ name: string; st_list_abandono_id: string | null; st_list_abandono_id_2: string | null; st_list_compra_id: string | null; st_list_compra_id_2: string | null }>(
          `SELECT DISTINCT name, st_list_abandono_id, st_list_abandono_id_2, st_list_compra_id, st_list_compra_id_2
           FROM kits WHERE client_id = $1 AND enabled = true`,
          [clientId]
        );

        // flatMap via listasDoKit, e não só a coluna 1: um produto pode ter uma segunda lista de
        // outro gateway de lead (ver comentário em listasDoKit), e as duas contam.
        const abandonoIds = [...new Set(kits.flatMap(k => listasDoKit(k).abandono))];
        const compraIds = [...new Set(kits.flatMap(k => listasDoKit(k).compra))];

        // Um list_id existe em UMA das contas; nas outras a chamada falha e vira 0. Por isso o
        // total de cada lista é o MAIOR valor entre as contas, não a soma — somar contaria a
        // mesma lista de novo se duas contas respondessem.
        const contarLista = async (listId: string): Promise<{ count: number; accountId: number | null }> => {
          const porConta = await Promise.all(
            clients.map(async c => ({ accountId: c.acc.accountId, count: await c.st.getListContactCount(parseInt(listId)) }))
          );
          return porConta.reduce((melhor, atual) => (atual.count > melhor.count ? atual : melhor), { count: 0, accountId: null as number | null });
        };

        const abandonoPorLista = await Promise.all(abandonoIds.map(async id => ({ id, ...(await contarLista(id)) })));
        const compraPorLista = await Promise.all(compraIds.map(async id => ({ id, ...(await contarLista(id)) })));

        // Contagem por list_id, pra conversão POR PRODUTO reaproveitar sem repetir chamada na
        // SlickText: as mesmas listas são as dos produtos, só agrupadas de outro jeito.
        contagemPorLista = new Map<string, number>();
        for (const l of [...abandonoPorLista, ...compraPorLista]) contagemPorLista.set(l.id, l.count);
        kitsComListas = kits.map(k => {
          const l = listasDoKit(k);
          return { nome: k.name, listasAbandono: l.abandono, listasCompra: l.compra };
        });

        // Status de retrato de TODA lista de produto ativo — não só as em standby, o Murilo pediu
        // pra ver as datas das já estabelecidas também. A consulta vem antes de
        // gravarSnapshotDeListas, e não depois: uma lista trocada ontem tem que continuar
        // aparecendo como nova hoje, não "resetar" porque acabou de ganhar o retrato do dia.
        const STANDBY_DIAS_MIN = 4; // abaixo disso a lista nunca serviu de base nem com a tolerância de 3 dias
        const retratoPorLista = await query<{ list_id: string; primeiro: string; dias: string; datas: string[] }>(
          `SELECT list_id, MIN(snapshot_date)::text AS primeiro, COUNT(DISTINCT snapshot_date) AS dias,
                  ARRAY_AGG(DISTINCT snapshot_date::text ORDER BY snapshot_date::text) AS datas
           FROM list_contact_snapshots WHERE client_id = $1 AND list_id = ANY($2)
           GROUP BY list_id`,
          [clientId, [...abandonoIds, ...compraIds]]
        ).catch(() => []);
        const retratoPorListaMap = new Map(retratoPorLista.map(r => [r.list_id, { primeiro: r.primeiro.slice(0, 10), dias: parseInt(r.dias), datas: r.datas }]));

        // A lista é da FAMÍLIA, mas kit.name é por SKU — "M2 - NeuroMind Pro (3 Bottles)",
        // "UP1 - NeuroMind Pro (6 Bottles)" etc. apontam pra MESMA lista. Sem agrupar por
        // list_id, a mesma lista nova aparecia 6 vezes na tela (visto em produção: 34 linhas pra
        // só ~10 listas de verdade) — o oposto de "fácil de ver o que é novo". Tira o prefixo de
        // código (M1/M2/UP1-V3/DW1...) e o sufixo de tamanho pra chegar no nome da família.
        const nomeFamilia = (nomeSku: string): string =>
          nomeSku
            .replace(/^\s*[A-Za-z]{1,4}\d*(-[A-Za-z]?\d+)?\s*-\s*/, '')
            .replace(/\s*\(\d+\s*[Bb]ottles?\)\s*$/, '')
            .trim() || nomeSku;

        const retratoAgrupado = new Map<string, { segmento: 'abandono' | 'compra'; familias: Set<string>; desde: string | null; dias: number; datas: string[] }>();
        for (const k of kits) {
          const l = listasDoKit(k);
          const familia = nomeFamilia(k.name);
          const juntar = (id: string, segmento: 'abandono' | 'compra') => {
            const r = retratoPorListaMap.get(id);
            const atual = retratoAgrupado.get(id) ?? { segmento, familias: new Set<string>(), desde: r?.primeiro ?? null, dias: r?.dias ?? 0, datas: r?.datas ?? [] };
            atual.familias.add(familia);
            retratoAgrupado.set(id, atual);
          };
          l.abandono.forEach(id => juntar(id, 'abandono'));
          l.compra.forEach(id => juntar(id, 'compra'));
        }
        listasRetratoStatus = [...retratoAgrupado.entries()]
          .map(([list_id, v]) => ({
            produto: [...v.familias].join(' / '),
            segmento: v.segmento,
            list_id,
            standby: v.dias < STANDBY_DIAS_MIN,
            desde: v.desde,
            dias_gravados: v.dias,
            datas: v.datas,
          }))
          .sort((a, b) => a.produto.localeCompare(b.produto));

        // Retrato do dia — de graça, os números já estão em mãos. É o que permite leads por
        // período nas próximas consultas (ver tabela list_contact_snapshots).
        await gravarSnapshotDeListas(clientId as string, [...abandonoPorLista, ...compraPorLista]);

        // Desde quando existem retratos, para a tela poder MOSTRAR isso. Enquanto os leads ainda
        // são vitalícios (falta o segundo retrato cobrindo o período), nada na tela indicava que o
        // mecanismo estava rodando — era pedir para confiar. Com a data do primeiro retrato à
        // vista, quem olha vê que a série começou e a partir de quando ela cobre.
        const retratos = await queryOne<{ primeiro: string | null; dias: string }>(
          `SELECT MIN(snapshot_date)::text AS primeiro, COUNT(DISTINCT snapshot_date) AS dias
           FROM list_contact_snapshots WHERE client_id = $1`,
          [clientId]
        ).catch(() => null);
        leadsRetratos = retratos?.primeiro
          ? { primeiro_retrato: retratos.primeiro.slice(0, 10), dias_com_retrato: parseInt(retratos.dias) }
          : null;

        const abandonoVitalicio = abandonoPorLista.reduce((a, b) => a + b.count, 0);
        const compraVitalicio = compraPorLista.reduce((a, b) => a + b.count, 0);

        // "Hoje" chega com period.isToday e SEM from/to (ver resolvePeriodFilter) — trata como
        // período ativo de hoje-a-hoje, usando a contagem AO VIVO que acabamos de buscar (linha
        // acima) como ponta final, em vez de esperar o retrato do dia. Sem isso, o filtro "Hoje"
        // caía sempre no vitalício, porque `period.from`/`period.to` vinham vazios.
        const hojeStr = period.isToday
          ? (await queryOne<{ hoje: string }>(`SELECT CURRENT_DATE::text AS hoje`))?.hoje.slice(0, 10)
          : null;
        const periodoDe = period.isToday ? hojeStr! : period.from;
        const periodoAte = period.isToday ? hojeStr! : period.to;
        const periodoAtivo = !!(periodoDe && periodoAte);

        // Leads DO PERÍODO via diferença de retratos, quando existem os dois lados. Só com
        // período ativo — sem período o vitalício é a resposta certa, não uma aproximação.
        const delta = periodoAtivo
          ? await leadsPorPeriodoViaSnapshots(clientId as string, abandonoIds, compraIds, periodoDe!, periodoAte!, period.isToday ? contagemPorLista : undefined)
          : null;
        // Independente do retrato: venda que a gente recebeu já diz, com precisão de segundos,
        // quando o comprador virou lead. Não depende de dois retratos existirem — funciona mesmo
        // em período retroativo a antes de o mecanismo de retrato ligar.
        const comprasExatas = periodoAtivo
          ? await leadsDeCompraViaWebhookLogs(clientId as string, compraIds, periodoDe!, periodoAte!)
          : null;

        if (delta) {
          // A tabela por produto passa a ler daqui também — mesma fonte, mesmo universo, taxas
          // comparáveis entre as duas partes do card.
          contagemPorLista = new Map(delta.deltaPorLista);
          abandonoLeads = delta.abandono;
          compradorLeads = delta.compra;
          leadsSource = 'snapshot_delta';
          // Todo mundo em delta.deltaPorLista já é DO PERÍODO — a diferença entre dois retratos
          // conta só quem entrou entre eles.
          listasComNumeroDoPeriodo = new Set([...abandonoIds, ...compraIds]);
          // A janela dos leads coincide com o período pedido?
          //
          // A busca de retratos aceita até 3 dias de folga em cada ponta, porque o retrato é gravado
          // quando alguém abre a tela e o dia exato pode faltar. Só que quando a folga é usada, a
          // janela dos LEADS fica maior que a das VENDAS — visto em produção: filtro de 05 a 06/08
          // devolvendo leads de 03 a 06/08, três dias contra dois. Nesse caso a taxa tem denominador
          // de uma janela e numerador de outra, e continuar chamando isso de "taxa exata" é pior que
          // o vitalício rotulado, porque o vitalício ao menos anuncia que é aproximado.
          //
          // O esperado para a ponta inicial é a VÉSPERA do primeiro dia do período: quem entrou no
          // dia 05 aparece na diferença entre o retrato do dia 04 e o do dia 06.
          const vespera = new Date(`${periodoDe}T00:00:00Z`);
          vespera.setUTCDate(vespera.getUTCDate() - 1);
          const esperadoDe = vespera.toISOString().slice(0, 10);
          leadsPeriodoInfo = {
            de: delta.baseDate,
            ate: delta.endDate,
            // Quando false, a tela para de dizer "exata" e mostra a janela que realmente foi usada.
            // Em "Hoje" a ponta final é sempre a contagem ao vivo (delta.endDate === periodoAte por
            // construção), então isso só falha se a ponta inicial não achou retrato de véspera.
            janela_bate: delta.baseDate === esperadoDe && delta.endDate === periodoAte,
          };
        } else {
          abandonoLeads = abandonoVitalicio;
          compradorLeads = compraVitalicio;
          leadsSource = 'slicktext_list';
        }

        // compradorLeadsSource começa igual a leadsSource (mesmo texto que o abandono, valendo o
        // aviso de vitalício quando for o caso) e só diverge quando o webhook der resposta —
        // abandono nunca usa este caminho, porque não existe evento nosso pra ancorar aquele lado
        // (ver comentário em leadsDeCompraViaWebhookLogs).
        compradorLeadsSource = leadsSource;
        leadsPeriodoInfoCompra = leadsPeriodoInfo;
        if (comprasExatas) {
          for (const [id, leads] of comprasExatas.porLista) {
            contagemPorLista.set(id, leads);
            listasComNumeroDoPeriodo.add(id); // exato e do período, mesmo quando delta falhou
          }
          // Recalcula o total somando TODAS as listas de compra pela fonte que cada uma tem —
          // exata pra produto de lista única, aproximada (retrato/vitalício) pra produto com duas
          // listas, que fica de fora de comprasExatas de propósito (ver o comentário da função).
          // Um total só, misturando as duas fontes por lista, é mais correto que escolher uma das
          // duas fontes inteira — e é exatamente o que contagemPorLista já representa aqui.
          compradorLeads = compraIds.reduce((soma, id) => soma + (contagemPorLista.get(id) ?? 0), 0);

          // Só chama de "exata" quando TODA lista de compra do cliente coube no cálculo exato. Com
          // produto de duas listas na mistura, o total é parcialmente aproximado, e dizer "exata"
          // pra ele seria a mesma classe de erro que motivou o resto desta auditoria: legenda
          // afirmando mais certeza do que o número tem.
          const cobreTudo = comprasExatas.porLista.size === compraIds.length;
          if (cobreTudo) {
            compradorLeadsSource = 'webhook_exato';
            // Janela exata por construção — não há folga de retrato pra estourar o período pedido.
            leadsPeriodoInfoCompra = { de: periodoDe!, ate: periodoAte!, janela_bate: true };
          }

          // O retrato também mediu este período? Compara só as listas que o webhook cobriu —
          // comparar contra delta.compra (que inclui produto de duas listas, fora do escopo do
          // webhook) acusaria "venda não capturada" no Thermo por engano, quando a diferença ali é
          // só o segundo gateway de lead que o retrato já soma legitimamente.
          if (delta) {
            const retratoDasMesmasListas = [...comprasExatas.porLista.keys()]
              .reduce((soma, id) => soma + (delta.deltaPorLista.get(id) ?? 0), 0);
            compraDivergencia = {
              do_retrato: retratoDasMesmasListas,
              explicado_por_venda: comprasExatas.total,
              diferenca: retratoDasMesmasListas - comprasExatas.total,
            };
          }
        }

        const avisos: string[] = [];
        if (unmatched.length > 0) {
          avisos.push(`${unmatched.length} produto(s) sem lista SlickText vinculada: ${unmatched.map(u => u.kitName).join(', ')}`);
        }
        if (leadsSource === 'slicktext_list' && periodoAtivo && !comprasExatas) {
          avisos.push('Leads são o total atual de cada lista (vitalício) contra vendas do período — a SlickText não conta contatos por lista e por data ao mesmo tempo. A partir de agora um retrato diário é gravado, e períodos futuros passam a ter leads exatos.');
        }
        leadsWarning = avisos.length > 0 ? avisos.join(' · ') : null;
      } catch (err: any) {
        logger.error('Admin', `Falha ao buscar leads via SlickText (client ${clientId}): ${err.message}`);
        leadsSource = 'unavailable';
        leadsWarning = 'Falha ao consultar SlickText — Leads de Carrinho Abandonado e Compradores temporariamente indisponíveis';
      }
    } else {
      leadsWarning = 'SlickText não configurado — Leads de Carrinho Abandonado e Compradores indisponíveis';
    }
  }

  const mailxRecoveryCount = parseInt(mailxRecoveries?.count || '0');

  // ── Conversão por Segmento ISOLADA por canal (pedido do Murilo: a spec pede a mesma
  // divisão Carrinho Abandonado/Compradores por dentro de cada aba, não só no consolidado). ──
  // Vendas escopadas aos MESMOS produtos que entram nos Leads (pedido do Murilo: sem isso a
  // Taxa comparava leads de só alguns produtos com vendas de TODOS — inflava a taxa). Leads já
  // exclui produto sem lista/tag vinculada (ver abandonoIds/compraIds acima); aqui o filtro
  // espelha isso via product_name = kits.name (mesma correspondência usada em top_products).
  // Uma query só devolve os 4 números (escopado + total de cada segmento) — o total é usado pra
  // NOTA DE RECONCILIAÇÃO no card: explica a diferença contra os KPIs de cima, que contam todos
  // os produtos (achado da auditoria: número diferente na mesma tela sem explicação vira dúvida).
  const smsSegParams: (string | number)[] = [clientId];
  const smsSegPeriod = periodSql(period, smsSegParams);
  // ESCOPO PELA AUTOMAÇÃO DE ORIGEM, não pelo nome do produto.
  //
  // Antes: a venda entrava na conta se o PRODUTO tivesse lista da SlickText vinculada. Isso funciona
  // pra produto de entrada e quebra pra upsell, que nunca vai ter lista própria: ninguém abandona um
  // carrinho de NightCalm — a pessoa entra pelo fluxo do NeuroMind, recebe a oferta do upsell ali
  // dentro, e o lead dela está na lista do NeuroMind. Exigir lista do NightCalm era exigir uma coisa
  // que não existe e não deveria existir. No cliente de referência isso jogava 64 vendas e 46
  // recuperações fora da tabela em 30 dias, todas de upsell.
  //
  // Agora: a venda entra se a MENSAGEM que a gerou está vinculada a uma automação (existe em
  // sms_campaign_map). É o que alinha numerador e denominador de verdade — a venda veio de um fluxo
  // cujas listas estão sendo contadas nos leads. Upsell entra pelo fluxo que o vendeu, que é onde o
  // lead realmente está.
  //
  // O que continua fora, e a nota da tela lista: venda de SMS sem mensagem vinculada. Aí não se sabe
  // de qual automação veio, então não há denominador a que ela pertença.
  const smsSeg = await queryOne<{
    rec_escopo: string; rec_total: string; compra_escopo: string; compra_total: string;
    nao_classificado: string; total_canal: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY} AND ${SQL_ESCOPO_POR_AUTOMACAO}) AS rec_escopo,
      COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY}) AS rec_total,
      -- NOT recovery: as duas linhas da tabela são segmentos EXCLUDENTES, não um dentro do outro.
      -- Antes "Compradores" contava TODAS as vendas, inclusive as de carrinho abandonado, e as
      -- duas linhas se sobrepunham: na tela do North Scale aparecia Carrinho Abandonado 2 e
      -- Compradores 3, com 3 vendas no período — ou seja, "Compradores" era o total. Pior, o
      -- resumo do topo da mesma página dizia "2 de recuperação e 1 de upsell", o número certo:
      -- a tela mostrava o certo e o errado ao mesmo tempo. Como leads de compradores e leads de
      -- abandono são listas diferentes, o numerador errado inflava a taxa de Compradores.
      -- RECONHECIMENTO POSITIVO, não por eliminação. Antes "Compradores" era "tudo que não é
      -- recuperação" — um balde de resto. Qualquer venda com utm fora do padrão (WFI001, Lost,
      -- uma automação nova) caía ali sem ninguém saber, inflando a conversão do segmento.
      -- Agora só entra quem CASA com upsell/compra aprovada; o que não casa com nenhum dos dois
      -- vai para "não classificado", que aparece na tela e vira lista de trabalho pra arrumar o
      -- link na SlickText. É também o que faz a identidade fechar de verdade:
      --   recuperação + comprador + não classificado = total
      COUNT(*) FILTER (WHERE ${SQL_IS_UPSELL} AND ${SQL_ESCOPO_POR_AUTOMACAO}) AS compra_escopo,
      COUNT(*) FILTER (WHERE ${SQL_IS_UPSELL}) AS compra_total,
      COUNT(*) FILTER (WHERE NOT ${SQL_IS_RECOVERY} AND NOT ${SQL_IS_UPSELL}) AS nao_classificado,
      COUNT(*) AS total_canal
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND client_id = $1 AND ${SQL_MAILX_SMS}
      ${smsSegPeriod ? `AND ${smsSegPeriod}` : ''}
  `, smsSegParams);
  const smsSegNaoClassificado = parseInt(smsSeg?.nao_classificado || '0');
  const smsSegTotalCanal = parseInt(smsSeg?.total_canal || '0');
  const smsSegRecoveryCount = parseInt(smsSeg?.rec_escopo || '0');
  const smsSegSalesCount = parseInt(smsSeg?.compra_escopo || '0');
  const smsSegRecoveryFora = parseInt(smsSeg?.rec_total || '0') - smsSegRecoveryCount;
  const smsSegSalesFora = parseInt(smsSeg?.compra_total || '0') - smsSegSalesCount;

  // QUAIS vendas ficaram fora, e por quê. A nota de reconciliação dizia só a quantidade ("2 vendas
  // do período não aparecem aqui") e atribuía a causa a "produto sem lista vinculada" — o que é um
  // chute: pode ser produto que nunca foi cadastrado, produto desativado, ou cadastrado e sem lista.
  // São três causas com três ações diferentes, e uma nota que diz a errada é pior que uma que diz só
  // o número, porque manda a pessoa arrumar a coisa que não está quebrada. Nomear o produto e o
  // motivo transforma o aviso em algo acionável.
  const foraParams: (string | number)[] = [clientId];
  const foraPeriod = periodSql(period, foraParams);
  const foraDetalhe = await query<{
    produto: string | null; utm: string | null; rec_fora: string; compra_fora: string; motivo: string;
  }>(`
    WITH vendas AS (
      SELECT product_name, utm_campaign, (${SQL_IS_RECOVERY}) AS is_rec,
             EXISTS (SELECT 1 FROM sms_campaign_map m
                     WHERE m.client_id = $1 AND m.utm_campaign = webhook_logs.utm_campaign) AS vinculada
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND client_id = $1 AND ${SQL_MAILX_SMS}
        ${foraPeriod ? `AND ${foraPeriod}` : ''}
    )
    SELECT
      v.product_name AS produto,
      v.utm_campaign AS utm,
      COUNT(*) FILTER (WHERE v.is_rec) AS rec_fora,
      -- NOT is_rec pelo mesmo motivo da tabela: a nota dizia "70 vendas e 52 recuperações" com
      -- as 52 DENTRO das 70, e quem lê soma 122. Agora os dois números são disjuntos e somam.
      COUNT(*) FILTER (WHERE NOT v.is_rec) AS compra_fora,
      -- Agora que o escopo é pela automação, o motivo de ficar fora é sempre o mesmo: não há
      -- mensagem vinculada. O que muda é o que fazer, e isso depende de existir utm_campaign.
      CASE
        WHEN v.utm_campaign IS NULL OR TRIM(v.utm_campaign) = ''
          THEN 'venda sem utm_campaign — o link não identifica a mensagem'
        ELSE 'mensagem não vinculada a nenhuma automação — rode o Auto-vincular'
      END AS motivo
    FROM vendas v
    WHERE NOT v.vinculada
    GROUP BY v.product_name, v.utm_campaign
    ORDER BY 4 DESC, 3 DESC
    LIMIT 12
  `, foraParams).catch(() => []);

  // ── Conversão por Segmento POR PRODUTO (pedido 3.4: "precisa ser dividido por produto tmb") ──
  //
  // O agrupamento é pelo produto que está no utm_campaign da venda — que é o produto da AUTOMAÇÃO,
  // não o SKU do pedido. É a única chave que funciona aqui: a venda de um upsell traz o SKU do
  // upsell, mas quem a gerou foi o fluxo da família, e é na lista da família que o lead está.
  //
  // E o resultado sai por FAMÍLIA ("NeuroMind Pro"), não por SKU ("M1 - NeuroMind Pro 2 Bottles"),
  // porque a lista da SlickText é uma só para a família toda. Quebrar por SKU contaria a mesma lista
  // várias vezes — foi exatamente o erro que fez os contatos aparecerem como 498 mil numa conta de
  // 83 mil.
  const porProdParams: (string | number)[] = [clientId];
  const porProdPeriod = periodSql(period, porProdParams);
  const vendasPorUtm = await query<{ utm_campaign: string | null; rec: string; upsell: string; nao_class: string; total: string }>(`
    SELECT utm_campaign,
           COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY}) AS rec,
           -- Os mesmos três estados da tabela principal. Esta query ficou de fora do primeiro
           -- conserto e continuava usando COUNT(*) como "vendas": a tela mostrava 21 recuperações
           -- e 27 vendas para o NeuromindPro, onde 27 era o total (21 + 6 de upsell). Corrigir a
           -- tabela de cima e deixar a de baixo com a semântica antiga é pior que não corrigir
           -- nenhuma — os dois números convivem na mesma tela e um desmente o outro.
           COUNT(*) FILTER (WHERE ${SQL_IS_UPSELL}) AS upsell,
           COUNT(*) FILTER (WHERE NOT ${SQL_IS_RECOVERY} AND NOT ${SQL_IS_UPSELL}) AS nao_class,
           COUNT(*) AS total
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND client_id = $1 AND ${SQL_MAILX_SMS}
      AND EXISTS (SELECT 1 FROM sms_campaign_map m
                  WHERE m.client_id = $1 AND m.utm_campaign = webhook_logs.utm_campaign)
      ${porProdPeriod ? `AND ${porProdPeriod}` : ''}
    GROUP BY utm_campaign
  `, porProdParams).catch(() => []);

  const conversaoPorProduto = (() => {
    if (vendasPorUtm.length === 0 || kitsComListas.length === 0) return [];

    // Casamento por chave normalizada (sem espaço, hífen, acento ou caixa), igual ao auto-vínculo de
    // listas: o utm traz "NeuromindPro" e o kit se chama "M1 - NeuroMind Pro (2 Bottles)".
    const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');


    type Agrupado = { produto: string; rec: number; vendas: number; naoClass: number; total: number; listasAb: Set<string>; listasCo: Set<string> };
    const porProduto = new Map<string, Agrupado>();

    for (const v of vendasPorUtm) {
      if (!v.utm_campaign) continue;
      const produto = familiaDoProduto(parseUtmCampaign(v.utm_campaign).produto);
      if (!produto) continue;
      const chave = norm(produto);
      if (!chave) continue;

      const atual = porProduto.get(chave) ?? { produto, rec: 0, vendas: 0, naoClass: 0, total: 0, listasAb: new Set<string>(), listasCo: new Set<string>() };
      atual.rec += parseInt(v.rec);
      // vendas = upsell/compra aprovada, NÃO o total. Ver comentário na query.
      atual.vendas += parseInt(v.upsell);
      atual.naoClass += parseInt(v.nao_class);
      atual.total += parseInt(v.total);

      // Todo kit cuja família casa com esse produto contribui suas listas. Set porque vários SKUs da
      // mesma família apontam para a MESMA lista, e somar seria contar a lista de novo.
      for (const k of kitsComListas) {
        const nk = norm(k.nome);
        if (!nk.includes(chave) && !chave.includes(nk)) continue;
        k.listasAbandono.forEach(id => atual.listasAb.add(id));
        k.listasCompra.forEach(id => atual.listasCo.add(id));
      }
      porProduto.set(chave, atual);
    }

    const somaListas = (ids: Set<string>) => [...ids].reduce((t, id) => t + (contagemPorLista.get(id) ?? 0), 0);
    // Taxa só quando TODAS as listas do produto, daquele lado, têm número do período. Uma lista
    // vitalício sozinha no meio já invalida a divisão inteira — não dá pra fazer "meia taxa".
    const todasDoPeriodo = (ids: Set<string>) => ids.size > 0 && [...ids].every(id => listasComNumeroDoPeriodo.has(id));

    return [...porProduto.values()]
      .map(a => {
        const leadsAb = somaListas(a.listasAb);
        const leadsCo = somaListas(a.listasCo);
        const abDoPeriodo = todasDoPeriodo(a.listasAb);
        const coDoPeriodo = todasDoPeriodo(a.listasCo);
        return {
          produto: a.produto,
          // null, não 0, quando o produto do utm não casou com nenhum kit com lista: a taxa não é
          // calculável, e 0 leads com vendas > 0 renderizaria uma taxa infinita ou um zero mentiroso.
          //
          // taxa null também quando o lead é vitalício: dividir venda DO PERÍODO por lead
          // VITALÍCIO (tamanho da lista inteira, acumulado desde sempre) não é taxa aproximada, é
          // comparar janelas de tempo diferentes — visto em produção rendendo 0,98% quando o
          // denominador tinha 9+ meses de gente contra 30 dias de venda. leads e vendas continuam
          // aparecendo (são fatos), só a razão entre eles some quando não é uma razão de verdade.
          carrinho_abandonado: {
            leads: a.listasAb.size > 0 ? leadsAb : null,
            vendas: a.rec,
            taxa: (leadsAb > 0 && abDoPeriodo) ? parseFloat(((a.rec / leadsAb) * 100).toFixed(2)) : null,
            taxa_nao_calculavel_motivo: (leadsAb > 0 && !abDoPeriodo) ? 'leads_vitalicio' : null,
          },
          compradores: {
            leads: a.listasCo.size > 0 ? leadsCo : null,
            vendas: a.vendas,
            taxa: (leadsCo > 0 && coDoPeriodo) ? parseFloat(((a.vendas / leadsCo) * 100).toFixed(2)) : null,
            taxa_nao_calculavel_motivo: (leadsCo > 0 && !coDoPeriodo) ? 'leads_vitalicio' : null,
          },
          // O terceiro estado também aqui: sem ele, a soma das duas colunas não bate com o total
          // do produto e não há como saber se falta venda ou se sobra.
          nao_classificado: a.naoClass,
          total: a.total,
          // Estampa que a lista é da família, para ninguém procurar uma lista por SKU que não existe.
          listas_usadas: { abandono: a.listasAb.size, compradores: a.listasCo.size },
        };
      })
      .sort((x, y) => y.compradores.vendas - x.compradores.vendas);
  })();

  // Agrupado por produto E mensagem: com escopo por automação, saber a MENSAGEM é o que permite
  // agir (é o que se vincula), e o produto é o que identifica a venda pra quem lê.
  const smsSegForaDetalhe = foraDetalhe.map(f => ({
    produto: f.produto || '(sem nome de produto no webhook)',
    mensagem: f.utm || null,
    recuperacoes_fora: parseInt(f.rec_fora),
    vendas_fora: parseInt(f.compra_fora),
    motivo: f.motivo,
  }));

  // Email: leads via TAG do ActiveCampaign, em TODAS as contas do cliente.
  // Realidade confirmada em produção: as tags são nomeadas por FAMÍLIA de produto
  // ("[Glyco Pulse] Compra Aprovada") enquanto os produtos chegam do gateway por SKU
  // ("M2 - Glyco Pulse (3 Bottles)") — buscar por nome exato nunca achava nada. O casamento é
  // por substring normalizada, igual ao que já funciona pras listas da SlickText. E como o mesmo
  // produto pode ter tag em mais de uma conta, os contatos somam as contas (nunca a mesma tag
  // duas vezes). Vitalício: a API não filtra contatos por tag e por período ao mesmo tempo.
  let emailAbandonoLeads = 0;
  let emailCompradorLeads = 0;
  let emailLeadsSource: 'ac_tag' | 'unavailable' = 'unavailable';
  let emailLeadsWarning: string | null = null;
  {
    const acAccounts = await getActiveCampaignAccounts(clientId);
    const enabledKits = await query<{ id: number; name: string }>(
      `SELECT id, name FROM kits WHERE client_id = $1 AND enabled = true`, [clientId]
    );

    if (acAccounts.length === 0) {
      emailLeadsWarning = 'ActiveCampaign não configurado — Leads de Carrinho Abandonado e Compradores indisponíveis';
    } else if (enabledKits.length === 0) {
      emailLeadsWarning = 'Nenhum produto ativado — sem base para calcular leads';
    } else {
      const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '');
      const kitKeys = enabledKits.map(k => ({ id: k.id, name: k.name, key: norm(k.name) }));
      const cobertos = new Set<number>();
      // Chave "conta:tagId" garante que a mesma tag não seja contada duas vezes, mas a mesma
      // família em contas diferentes conta as duas (são contatos distintos).
      const contarCompra = new Map<string, () => Promise<number>>();
      const contarAbandono = new Map<string, () => Promise<number>>();
      let falhas = 0;

      for (const acc of acAccounts) {
        const ac = new ActiveCampaignClient(acc.ac_api_url, acc.ac_api_key);
        let tags: Array<{ id: string; tag: string }>;
        try {
          tags = await ac.listTags();
        } catch (err: any) {
          logger.warn('Admin', `Falha ao listar tags do AC (client ${clientId}, conta ${acc.label}): ${err.message}`);
          falhas++;
          continue;
        }

        for (const t of tags) {
          // "[Família] Compra Aprovada" / "[Família] Abandono" — o padrão que o bootstrap cria
          // e que o Nicollas mantém à mão. Ignora Reembolso/Chargeback/Rastreio/Cartão Recusado.
          const m = t.tag.match(/^\[(.+?)\]\s*(compra aprovada|abandono)\s*$/i);
          if (!m) continue;
          const familiaKey = norm(m[1]);
          if (!familiaKey) continue;
          const kitsDaFamilia = kitKeys.filter(k => k.key.includes(familiaKey));
          if (kitsDaFamilia.length === 0) continue; // tag de produto de outro cliente na mesma conta

          kitsDaFamilia.forEach(k => cobertos.add(k.id));
          const alvo = /compra/i.test(m[2]) ? contarCompra : contarAbandono;
          alvo.set(`${acc.accountId ?? 'principal'}:${t.id}`, () => ac.getContactCountByTag(t.id));

          // Persiste o vínculo: é o que o escopo de vendas usa pra saber quais produtos contar.
          const coluna = /compra/i.test(m[2]) ? 'ac_tag_compra_id' : 'ac_tag_abandono_id';
          await query(
            `UPDATE kits SET ${coluna} = $1, ac_account_id = $2
             WHERE client_id = $3 AND enabled = true AND id = ANY($4::int[]) AND ${coluna} IS NULL`,
            [t.id, acc.accountId, clientId, kitsDaFamilia.map(k => k.id)]
          );
        }
      }

      const [compras, abandonos] = await Promise.all([
        Promise.all([...contarCompra.values()].map(fn => fn().catch(() => 0))),
        Promise.all([...contarAbandono.values()].map(fn => fn().catch(() => 0))),
      ]);
      emailCompradorLeads = compras.reduce((a, b) => a + b, 0);
      emailAbandonoLeads = abandonos.reduce((a, b) => a + b, 0);

      const semTag = kitKeys.filter(k => !cobertos.has(k.id));
      if (falhas === acAccounts.length) {
        emailLeadsWarning = 'Falha ao consultar ActiveCampaign — Leads de Carrinho Abandonado e Compradores temporariamente indisponíveis';
      } else {
        emailLeadsSource = 'ac_tag';
        if (semTag.length > 0) {
          emailLeadsWarning = `${semTag.length} produto(s) sem tag do ActiveCampaign: ${semTag.map(k => k.name).join(', ')}`;
        }
      }
    }
  }

  // Vendas de Email escopadas aos mesmos produtos que entram nos Leads acima (mesmo motivo do
  // SMS: sem isso a Taxa compara leads de só alguns produtos com vendas de TODOS). Também numa
  // query só, devolvendo o total de cada segmento pra nota de reconciliação.
  const emailSegParams: (string | number)[] = [clientId];
  const emailSegPeriod = periodSql(period, emailSegParams);
  const emailSeg = await queryOne<{
    rec_escopo: string; rec_total: string; compra_escopo: string; compra_total: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY}
        AND product_name IN (SELECT name FROM kits WHERE client_id = $1 AND enabled = true AND ac_tag_abandono_id IS NOT NULL)) AS rec_escopo,
      COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY}) AS rec_total,
      -- Mesma correção do SMS: Compradores exclui recuperação, senão as duas linhas se sobrepõem.
      COUNT(*) FILTER (WHERE NOT ${SQL_IS_RECOVERY}
        AND product_name IN (SELECT name FROM kits WHERE client_id = $1 AND enabled = true AND ac_tag_compra_id IS NOT NULL)) AS compra_escopo,
      COUNT(*) FILTER (WHERE NOT ${SQL_IS_RECOVERY}) AS compra_total
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND client_id = $1 AND ${SQL_MAILX_EMAIL}
      ${emailSegPeriod ? `AND ${emailSegPeriod}` : ''}
  `, emailSegParams);
  const emailSegRecoveryCount = parseInt(emailSeg?.rec_escopo || '0');
  const emailSegSalesCount = parseInt(emailSeg?.compra_escopo || '0');
  const emailSegRecoveryFora = parseInt(emailSeg?.rec_total || '0') - emailSegRecoveryCount;
  const emailSegSalesFora = parseInt(emailSeg?.compra_total || '0') - emailSegSalesCount;

  // ── Email Marketing KPIs (ActiveCampaign reporting) ──
  // API do AC só aceita "N dias atrás de agora" — "Hoje" mapeia certinho (1 dia),
  // presets/personalizado terminando hoje também; terminando no passado, fica
  // limitado a 30 dias fixos e avisamos isso (ac_period_limited).
  const today = new Date().toISOString().slice(0, 10);
  let acDaysBack = 30;
  let acPeriodLimited = false;
  if (period.isToday) {
    acDaysBack = 1;
  } else if (periodTo && periodTo === today && periodFrom) {
    acDaysBack = Math.round((parseYmd(periodTo).getTime() - parseYmd(periodFrom).getTime()) / 86400000) + 1;
  } else if (periodFrom && periodTo) {
    acDaysBack = 30;
    acPeriodLimited = true;
  }

  const emailMetrics = {
    entrada_contatos: '--' as string,
    ctr: '--' as string,
    taxa_abertura: '--' as string,
    ctor: '--' as string,
    rpm: '--' as string,
    epc: '--' as string,
    ac_period_limited: acPeriodLimited,
    status: 'not_configured' as 'not_configured' | 'error' | 'ok',
    status_message: 'ActiveCampaign não configurado para este cliente.' as string,
  };
  // Soma TODAS as contas de ActiveCampaign do cliente, não só a principal — mesmo tratamento já
  // dado a contatos/créditos das contas SlickText. Sem isso, uma conta adicional que dispara email
  // (a Group Future Now, por exemplo) ficava invisível no engajamento.
  const acAccountsForMetrics = await getActiveCampaignAccounts(clientId);
  if (acAccountsForMetrics.length > 0) {
    try {
      const porConta = await Promise.all(acAccountsForMetrics.map(async (acc) => {
        const ac = new ActiveCampaignClient(acc.ac_api_url, acc.ac_api_key);
        const [agg, novos] = await Promise.all([
          ac.getCampaignsAggregate(acDaysBack),
          ac.getNewContactsCount(acDaysBack),
        ]);
        return { agg, novos };
      }));
      const agg = porConta.reduce((acc, r) => ({
        campaigns: acc.campaigns + r.agg.campaigns,
        send_amt: acc.send_amt + r.agg.send_amt,
        opens: acc.opens + r.agg.opens,
        uniqueopens: acc.uniqueopens + r.agg.uniqueopens,
        linkclicks: acc.linkclicks + r.agg.linkclicks,
        uniquelinkclicks: acc.uniquelinkclicks + r.agg.uniquelinkclicks,
      }), { campaigns: 0, send_amt: 0, opens: 0, uniqueopens: 0, linkclicks: 0, uniquelinkclicks: 0 });
      const newContacts = porConta.reduce((sum, r) => sum + r.novos, 0);
      const mailxRev = parseFloat(emailMailxData?.revenue || '0');
      const ctr = agg.send_amt > 0 ? (agg.uniquelinkclicks / agg.send_amt) * 100 : 0;
      const openRate = agg.send_amt > 0 ? (agg.uniqueopens / agg.send_amt) * 100 : 0;
      const ctor = agg.uniqueopens > 0 ? (agg.uniquelinkclicks / agg.uniqueopens) * 100 : 0;
      const rpm = agg.send_amt > 0 ? (mailxRev / agg.send_amt) * 1000 : 0;
      const epc = agg.uniquelinkclicks > 0 ? mailxRev / agg.uniquelinkclicks : 0;

      emailMetrics.entrada_contatos = newContacts.toLocaleString('pt-BR');
      emailMetrics.ctr = `${ctr.toFixed(2)}%`;
      emailMetrics.taxa_abertura = `${openRate.toFixed(2)}%`;
      emailMetrics.ctor = `${ctor.toFixed(2)}%`;
      emailMetrics.rpm = fmtBRL(rpm);
      emailMetrics.epc = fmtBRL(epc);
      emailMetrics.status = 'ok';
      emailMetrics.status_message = '';
    } catch (err: any) {
      logger.warn(CTX, `Failed to fetch AC stats for client ${clientId}: ${err.message}`);
      emailMetrics.status = 'error';
      emailMetrics.status_message = 'Erro ao conectar com o ActiveCampaign — verifique as credenciais ou tente novamente em instantes.';
    }
  }

  res.json({
    currency,
    period: {
      active: periodActive,
      is_today: period.isToday,
      from: periodFrom || null,
      to: periodTo || null,
    },
    kpis: {
      faturamento: fmtBRL(totalRevenue),
      vendas: totalSales,
      ticket_medio: fmtBRL(ticketMedio),
      webhooks_total: totalWh,
      webhooks_hoje: parseInt(webhooksToday?.count || '0'),
      taxa_sucesso: `${successRate}%`,
      reembolsos: parseInt(refundCount?.count || '0'),
      lojas_integradas: stores.length,
      // MailX UTM metrics
      faturamento_mailx: fmtBRL(parseFloat(mailxData?.revenue || '0')),
      vendas_mailx: parseInt(mailxData?.count || '0'),
      recuperacoes_mailx: parseInt(mailxRecoveries?.count || '0'),
      faturamento_recuperacoes: fmtBRL(parseFloat(mailxRecoveries?.revenue || '0')),
    },
    email: emailMetrics,
    email_mailx: {
      faturamento_email: fmtBRL(parseFloat(emailMailxData?.revenue || '0')),
      vendas_email: parseInt(emailMailxData?.count || '0'),
      ticket_medio_email: (() => {
        const vendasEmail = parseInt(emailMailxData?.count || '0');
        const revEmail = parseFloat(emailMailxData?.revenue || '0');
        return fmtBRL(vendasEmail > 0 ? revEmail / vendasEmail : 0);
      })(),
      recuperacoes_email: parseInt(emailMailxRecoveries?.count || '0'),
      faturamento_recuperacoes_email: fmtBRL(parseFloat(emailMailxRecoveries?.revenue || '0')),
      vendas_upsell_email: parseInt(emailMailxUpsell?.count || '0'),
      faturamento_upsell_email: fmtBRL(parseFloat(emailMailxUpsell?.revenue || '0')),
      // Representatividade do canal EMAIL dentro do faturamento total do cliente (mesmo período)
      // — espelha representatividade_sms (sms-stats), seção 3.2 da spec aplicada por canal.
      faturamento_total_cliente: fmtBRL(totalRevenue),
      vendas_total_cliente: totalSales,
      representatividade_email: totalRevenue > 0
        ? parseFloat(((parseFloat(emailMailxData?.revenue || '0') / totalRevenue) * 100).toFixed(1))
        : 0,
    },
    top_products: topProducts.map(p => ({
      name: p.name,
      sales: parseInt(p.count),
      revenue: parseFloat(p.revenue),
    })),
    recent_webhooks: recentWebhooks,
    daily_activity: {
      labels: dailyActivity.map(d => d.day),
      values: dailyActivity.map(d => parseInt(d.count)),
    },
    charts: {
      hourly: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`),
        values: hourlyValues,
      },
      top_event_types: {
        labels: eventDist.length > 0 ? eventDist.map(e => e.event_type) : ['Nenhum evento'],
        values: eventDist.length > 0 ? eventDist.map(e => parseInt(e.count)) : [0],
      },
    },
    funnel: {
      total_envios: totalWh,
      total_vendas: totalSales,
      envios_por_venda: enviosPorVenda,
    },
    stores: stores.map(s => ({ slug: s.shop_slug, platform: s.platform })),
    // New metrics from spec doc
    representatividade: totalRevenue > 0
      ? parseFloat(((parseFloat(mailxData?.revenue || '0') / totalRevenue) * 100).toFixed(1))
      : 0,
    // Consolidado = soma dos dois canais, dos dois lados da conta (leads SlickText + tag do AC,
    // vendas SMS + Email já escopadas aos produtos com lista/tag vinculada). Antes somava leads
    // de SMS só com vendas de TODOS os canais/produtos, o que inflava a taxa.
    origem_do_faturamento: origemDoFaturamento,
    desempenho_por_caminho: desempenhoPorCaminho,
    email_automacao_vs_campanha: emailAutomacaoVsCampanha,
    //
    // LEADS NÃO SÃO SOMADOS AQUI, e a taxa consolidada não existe.
    //
    // A mesma pessoa está na lista da SlickText E na tag do ActiveCampaign: quem abandonou o
    // carrinho recebe SMS e email do mesmo fluxo. Somar os dois lados conta cada pessoa duas
    // vezes — no cliente de referência dava 77.845 leads (39.173 do SMS + 38.672 do AC) para uma
    // base que não tem 77 mil pessoas. Com o denominador dobrado, a taxa consolidada saía pela
    // METADE da real, e o canal parecia converter menos do que converte.
    //
    // Não existe conserto por cálculo: para desduplicar seria preciso cruzar telefone com email
    // pessoa a pessoa, dado que nenhuma das duas APIs entrega. Então a tela deixa de somar em vez
    // de mostrar um número que parece certo. Vendas continuam somadas — venda é evento distinto,
    // não pessoa, e a mesma compra não aparece nos dois canais.
    conversao_por_segmento: {
      carrinho_abandonado: {
        leads: null,
        vendas: smsSegRecoveryCount + emailSegRecoveryCount,
        vendas_fora_escopo: smsSegRecoveryFora + emailSegRecoveryFora,
        taxa: null,
        leads_nao_somavel: true,
        leads_por_canal: { sms: abandonoLeads, email: emailAbandonoLeads },
        leads_source: leadsSource,
        leads_warning: leadsWarning,
      },
      compradores: {
        leads: null,
        vendas: smsSegSalesCount + emailSegSalesCount,
        vendas_fora_escopo: smsSegSalesFora + emailSegSalesFora,
        taxa: null,
        leads_nao_somavel: true,
        leads_por_canal: { sms: compradorLeads, email: emailCompradorLeads },
        leads_source: compradorLeadsSource,
        leads_warning: leadsWarning,
      },
    },
    // Isolado por canal — mesmo cálculo, escopado a cada aba (Email/SMS), pedido do Murilo
    // pra bater com a spec ("toda a separação feita isolada para cada aba").
    // Conferência das identidades que TÊM que fechar. Roda a cada resposta e vai junto com os
    // números, não num relatório separado: relatório que ninguém abre não protege ninguém.
    invariantes: conferirInvariantes({
      segmentoSms: {
        recuperacoes: smsSegRecoveryCount + smsSegRecoveryFora,
        compradores: smsSegSalesCount + smsSegSalesFora,
        naoClassificado: smsSegNaoClassificado,
        totalCanal: smsSegTotalCanal,
      },
      escopoSms: {
        dentroRec: smsSegRecoveryCount,
        dentroCompra: smsSegSalesCount,
        foraRec: smsSegRecoveryFora,
        foraCompra: smsSegSalesFora,
        naoClassificado: smsSegNaoClassificado,
        totalCanal: smsSegTotalCanal,
      },
    }),
    conversao_por_segmento_sms: {
      // Terceiro estado, exposto de propósito. Venda que não casa nem com carrinho abandonado nem
      // com upsell/compra aprovada não é "comprador por eliminação" — é venda cujo link não diz de
      // onde veio, e isso é trabalho a fazer na SlickText, não número a esconder.
      nao_classificado: smsSegNaoClassificado,
      total_canal: smsSegTotalCanal,
      carrinho_abandonado: {
        leads: abandonoLeads,
        vendas: smsSegRecoveryCount,
        vendas_fora_escopo: smsSegRecoveryFora,
        taxa: abandonoLeads > 0 ? parseFloat(((smsSegRecoveryCount / abandonoLeads) * 100).toFixed(2)) : 0,
        leads_source: leadsSource,
        leads_periodo: leadsPeriodoInfo,
        leads_retratos: leadsRetratos,
        leads_warning: leadsWarning,
      },
      compradores: {
        leads: compradorLeads,
        vendas: smsSegSalesCount,
        vendas_fora_escopo: smsSegSalesFora,
        taxa: compradorLeads > 0 ? parseFloat(((smsSegSalesCount / compradorLeads) * 100).toFixed(2)) : 0,
        leads_source: compradorLeadsSource,
        leads_periodo: leadsPeriodoInfoCompra,
        leads_retratos: leadsRetratos,
        leads_warning: leadsWarning,
        // Só preenchido quando leads_source é 'webhook_exato' E o retrato também mediu o mesmo
        // período — é a contraprova: quanto a lista cresceu de verdade contra quanto a gente
        // conseguiu explicar por venda registrada. Positivo = venda por gateway não capturado.
        divergencia_retrato: compraDivergencia,
      },
      // Quais produtos ficaram fora e por quê — a nota da tela lista isso em vez de só contar.
      fora_escopo_detalhe: smsSegForaDetalhe,
      // Pedido 3.4 do documento: a mesma divisão, aberta por produto (por família, ver o bloco).
      por_produto: conversaoPorProduto,
      // Status de retrato de TODA lista de produto ativo, com as datas gravadas de cada uma —
      // não só a recém-trocada (standby:true), a já estabelecida também, pra dar visão completa
      // de quem mexe nos vínculos do workflow.
      listas_retrato_status: listasRetratoStatus,
    },
    conversao_por_segmento_email: {
      carrinho_abandonado: {
        leads: emailAbandonoLeads,
        vendas: emailSegRecoveryCount,
        vendas_fora_escopo: emailSegRecoveryFora,
        taxa: emailAbandonoLeads > 0 ? parseFloat(((emailSegRecoveryCount / emailAbandonoLeads) * 100).toFixed(2)) : 0,
        leads_source: emailLeadsSource,
        leads_warning: emailLeadsWarning,
      },
      compradores: {
        leads: emailCompradorLeads,
        vendas: emailSegSalesCount,
        vendas_fora_escopo: emailSegSalesFora,
        taxa: emailCompradorLeads > 0 ? parseFloat(((emailSegSalesCount / emailCompradorLeads) * 100).toFixed(2)) : 0,
        leads_source: emailLeadsSource,
        leads_warning: emailLeadsWarning,
      },
    },
    metrics_only: METRICS_ONLY,
  });
}));

function parseUtmCampaign(campaign: string): {
  mensagem: string; tipo_automacao: string; produto: string;
  produto_bruto: string; oferta_colada_no_produto: boolean;
} {
  const msgMatch = campaign.match(/MS\d{4}[A-Z]/i);
  const mensagem = msgMatch ? msgMatch[0].toUpperCase() : campaign;

  const beforeMsg = campaign.split(/-MS\d{4}[A-Z]/i)[0] ?? '';
  const tipo_automacao = beforeMsg
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .replace('Carrinho Abandonado', 'Carrinho Abandonado')
    .replace('Compra Aprovada', 'Compra Aprovada (Upsell)')
    || beforeMsg;

  const afterParts = campaign.split(/-MS\d{4}[A-Z]-/i);
  const produtoBruto = afterParts[1]?.split('-')[0] ?? '';

  // A OFERTA colada no nome do produto.
  //
  // Pelo padrão, oferta é utm_content ("Buy62OFF") e o produto é só o produto. Alguns links foram
  // montados com a oferta emendada sem hífen no fim do produto — "NeuromindProBuy62OFF" — e o
  // parser, que separa por hífen, não tinha como cortar. O efeito na tela: o mesmo NeuroMind Pro
  // aparecia como três produtos diferentes na visão Por Produto e como três chips no filtro, cada um
  // com um pedaço da receita, e nenhum deles somando o produto de verdade.
  //
  // Corta só o que tem cara de oferta no FIM do nome (Buy<numeros>OFF, com ou sem espaço). Um corte
  // mais largo — qualquer coisa depois do nome conhecido — arriscaria juntar produtos distintos, que
  // é um erro pior: receita de um entrando na conta do outro.
  const OFERTA_COLADA = /Buy\s*\d+\s*\d*\s*OFF$/i;
  const temOfertaColada = OFERTA_COLADA.test(produtoBruto);
  const produto = temOfertaColada ? produtoBruto.replace(OFERTA_COLADA, '') : produtoBruto;

  // O agrupamento sai certo, mas o link continua fora do padrão — e quem arruma isso é quem edita o
  // link na SlickText. Por isso a tela estampa o aviso em vez de limpar em silêncio: limpeza
  // silenciosa faz o problema nunca ser corrigido na origem.
  return { mensagem, tipo_automacao, produto, produto_bruto: produtoBruto, oferta_colada_no_produto: temOfertaColada };
}

// GET /admin/clientes/:id/sms-granular - SMS performance per automation message
// GET /admin/clientes/:id/envios-por-automacao - Total de mensagens enviadas por AUTOMAÇÃO no
// período.
//
// Faltava na tela. A aba SMS mostrava envios por MENSAGEM (cada linha da tabela) e créditos
// agrupados em dois baldes (Carrinho Abandonado e Upsell), mas não o total de cada automação — que é
// a pergunta natural de quem quer saber qual fluxo está trabalhando mais. O dado sempre existiu:
// o total por workflow no período é filtrado por data de verdade pela API, ao contrário do total por
// mensagem.
//
// Traz TODAS as automações da conta, inclusive as sem mensagem vinculada, e marca quais são. Mostrar
// só as vinculadas daria a impressão de que a conta tem menos automação do que tem — e é justamente
// nas não vinculadas que mora o envio que ninguém está medindo.
adminRouter.get('/clientes/:id/envios-por-automacao', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const { start, end } = await resolveSlickTextDateRange(req);
  const period = resolvePeriodFilter(req);

  const vinculos = await query<{ slicktext_campaign_id: number | null; st_account_id: number | null }>(
    `SELECT DISTINCT slicktext_campaign_id, st_account_id FROM sms_campaign_map
     WHERE client_id = $1 AND source_type = 'Workflow' AND slicktext_campaign_id IS NOT NULL`,
    [clientId]
  );

  const contas = await getSlickTextAccounts(clientId);
  const automacoes: Array<{
    automacao: string; conta: string; workflow_id: number;
    envios: number | null; tem_mensagem_vinculada: boolean;
  }> = [];

  for (const acc of contas) {
    const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
    const workflows = await st.getWorkflows().catch(() => null);
    if (!workflows) continue;
    const vinculadosDaConta = new Set(
      vinculos.filter(v => v.st_account_id === acc.accountId).map(v => v.slicktext_campaign_id)
    );

    const resultados = await Promise.all(workflows.map(async wf => ({
      automacao: wf.name,
      conta: acc.label,
      workflow_id: wf.workflow_id,
      // null quando a chamada falha — a linha diz "indisponível" em vez de 0, que leria como
      // "essa automação não enviou nada".
      envios: await st.getMessageAnalyticsForSource('Workflow', wf.workflow_id, start, end)
        .then(d => d?.totals?.total ?? null)
        .catch(() => null),
      tem_mensagem_vinculada: vinculadosDaConta.has(wf.workflow_id),
    })));
    automacoes.push(...resultados);
  }

  const naoResponderam = automacoes.filter(a => a.envios === null);
  const comEnvio = automacoes.filter(a => (a.envios ?? 0) > 0);
  const total = comEnvio.reduce((s, a) => s + (a.envios ?? 0), 0);
  const incompleto = naoResponderam.length > 0;

  res.json({
    periodo: { de: start.slice(0, 10), ate: end.slice(0, 10), ativo: period.isToday || !!(period.from && period.to) },
    total_de_envios: incompleto ? null : total,
    total_incompleto: incompleto,
    // Soma do que respondeu. Existe separado do total justamente porque não é o total: serve para a
    // tela poder dizer "1.253 entre as que responderam" em vez de esconder tudo.
    soma_das_que_responderam: total,
    automacoes_que_nao_responderam: naoResponderam.length,
    // Automação sem envio no período não vira linha (fluxo pausado encheria a tabela de zeros), mas
    // o total de quantas ficaram de fora fica dito.
    automacoes_sem_envio_no_periodo: automacoes.length - comEnvio.length - naoResponderam.length,
    // As que não responderam entram na lista com envios null. Antes eram descartadas em silêncio: a
    // tabela mostrava dez linhas somando 100% de participação enquanto o cabeçalho dizia "total
    // indisponível" — ou seja, negava o total e ao mesmo tempo repartia porcentagem dele. Quem lê
    // precisa ver QUAIS automações estão faltando, não só que falta alguma.
    automacoes: [
      ...comEnvio.sort((a, b) => (b.envios ?? 0) - (a.envios ?? 0)),
      ...naoResponderam,
    ].map(a => ({
      ...a,
      // Participação só quando o total é conhecido. Com uma automação faltando, o denominador está
      // errado e toda porcentagem sai maior do que é.
      share: !incompleto && total > 0 && a.envios != null
        ? parseFloat(((a.envios / total) * 100).toFixed(1))
        : null,
    })),
  });
}));

adminRouter.get('/clientes/:id/sms-granular', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const currency = await resolveClientCurrency(clientId);

  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const useCustomRange = !!(from && to && DATE_YMD_RE.test(from) && DATE_YMD_RE.test(to));
  const { fromTime, toTime, hasTime } = parseOptionalTimeRange(req);

  let dateFilterSql: string;
  const params: (string | number)[] = [clientId];
  let period: number | null = null;
  let rangeFrom: string | null = null;
  let rangeTo: string | null = null;

  if (useCustomRange) {
    const range = validateYmdRange(from!, to!);
    if ('error' in range) {
      res.status(400).json({ error: range.error });
      return;
    }
    rangeFrom = from!;
    rangeTo = to!;
    params.push(from!, to!);
    dateFilterSql = createdAtRangeSqlAt(params, 2, 3, hasTime, fromTime, toTime);
  } else {
    const periodRaw = req.query.period as string | undefined;
    period = ['7', '30', '90'].includes(periodRaw || '') ? parseInt(periodRaw!) : 30;
    params.push(String(period));
    dateFilterSql = `created_at >= NOW() - ($2 || ' days')::INTERVAL`;
  }

  const rawRows = await query<{
    utm_campaign: string;
    ofertas: string[] | null;
    caminhos: string[] | null;
    event_type: string;
    vendas: string;
    receita_bruta: string;
    reembolsos: string;
    valor_reembolso: string;
    chargebacks: string;
    valor_chargeback: string;
  }>(`
    SELECT
      utm_campaign,
      -- Oferta (utm_content) e caminho (utm_term) — partes variáveis definidas no UTMS_DASH que
      -- eram gravadas e nunca usadas. Agregadas como lista porque, em teoria, uma mesma mensagem
      -- pode ter mais de uma oferta/caminho; na prática é uma de cada.
      ARRAY_AGG(DISTINCT utm_content) FILTER (WHERE NULLIF(TRIM(COALESCE(utm_content, '')), '') IS NOT NULL) AS ofertas,
      ARRAY_AGG(DISTINCT utm_term)    FILTER (WHERE NULLIF(TRIM(COALESCE(utm_term, '')), '')    IS NOT NULL) AS caminhos,
      event_type,
      COUNT(*) FILTER (WHERE event_type = 'order.paid')                        AS vendas,
      COALESCE(SUM(total_price) FILTER (WHERE event_type = 'order.paid'), 0)   AS receita_bruta,
      COUNT(*) FILTER (WHERE event_type = 'order.refunded')                    AS reembolsos,
      COALESCE(ABS(SUM(total_price) FILTER (WHERE event_type = 'order.refunded')), 0) AS valor_reembolso,
      COUNT(*) FILTER (WHERE event_type = 'order.chargeback')                  AS chargebacks,
      COALESCE(ABS(SUM(total_price) FILTER (WHERE event_type = 'order.chargeback')), 0) AS valor_chargeback
    FROM webhook_logs
    WHERE
      client_id = $1
      -- Tolerante a caixa e espaço: com igualdade crua, um "MailX-SMS" ou um "auto-sms " com
      -- espaço sobrando derrubava a mensagem desta tabela e a mantinha no card de Faturamento
      -- SMS — o total e a tabela discordavam sem nenhum aviso. Ver /diagnostico/sms.
      AND LOWER(TRIM(COALESCE(utm_medium, ''))) = 'auto-sms'
      AND LOWER(TRIM(COALESCE(utm_source, ''))) = 'mailx-sms'
      AND utm_campaign IS NOT NULL
      AND utm_campaign NOT ILIKE '%teste%'
      AND ${dateFilterSql}
    GROUP BY utm_campaign, event_type
    ORDER BY receita_bruta DESC NULLS LAST
  `, params);

  type SmsGranularRow = {
    utm_campaign: string;
    vendas: number;
    receita_bruta: number;
    reembolsos: number;
    valor_reembolso: number;
    chargebacks: number;
    valor_chargeback: number;
    receita_liquida: number;
    mensagem: string;
    tipo_automacao: string;
    produto: string;
    produto_familia: string;
    produto_bruto: string;
    oferta_colada_no_produto: boolean;
    oferta: string | null;
    caminho: string | null;
  };

  const byCampaign = new Map<string, SmsGranularRow>();

  for (const row of rawRows) {
    let agg = byCampaign.get(row.utm_campaign);
    if (!agg) {
      const parsed = parseUtmCampaign(row.utm_campaign);
      agg = {
        utm_campaign: row.utm_campaign,
        vendas: 0,
        receita_bruta: 0,
        reembolsos: 0,
        valor_reembolso: 0,
        chargebacks: 0,
        valor_chargeback: 0,
        receita_liquida: 0,
        mensagem: parsed.mensagem,
        tipo_automacao: parsed.tipo_automacao,
        produto: parsed.produto,
        // Família calculada AQUI, não no navegador. A tela tinha a própria cópia da regra, e a
        // cópia já cobrou: corrigida no front, esquecida no servidor, o NeuromindProN8N virou
        // produto próprio e as vendas dele saíram do denominador. Agora existe um dono.
        produto_familia: familiaDoProduto(parsed.produto),
        // Nome cru e o aviso: a tela agrupa pelo produto limpo e estampa que o link está fora do
        // padrão, pra alguém corrigir na SlickText em vez de o dashboard remendar para sempre.
        produto_bruto: parsed.produto_bruto,
        oferta_colada_no_produto: parsed.oferta_colada_no_produto,
        // Só rotula quando há UM valor: várias ofertas/caminhos na mesma mensagem viraria um
        // número que não representa nenhum deles, então fica nulo e a coluna mostra "—".
        oferta: row.ofertas?.length === 1 ? row.ofertas[0] : null,
        // "SoulDetoxDrops-CaminhoA" -> "Caminho A"; guarda só a parte do caminho.
        caminho: (() => {
          if (row.caminhos?.length !== 1) return null;
          const m = row.caminhos[0].match(/caminho\s*([A-Z])/i);
          return m ? `Caminho ${m[1].toUpperCase()}` : row.caminhos[0];
        })(),
      };
      byCampaign.set(row.utm_campaign, agg);
    }

    agg.vendas += parseInt(row.vendas || '0', 10);
    agg.receita_bruta += parseFloat(row.receita_bruta || '0');
    agg.reembolsos += parseInt(row.reembolsos || '0', 10);
    agg.valor_reembolso += parseFloat(row.valor_reembolso || '0');
    agg.chargebacks += parseInt(row.chargebacks || '0', 10);
    agg.valor_chargeback += parseFloat(row.valor_chargeback || '0');
  }

  const rows = Array.from(byCampaign.values())
    .map((row) => ({
      ...row,
      receita_liquida: row.receita_bruta - row.valor_reembolso - row.valor_chargeback,
    }))
    .sort((a, b) => b.receita_liquida - a.receita_liquida);

  // Achado da auditoria (estado inconsistente): a célula de envios nascia como "Ver envios"
  // e só virava "Vincular" depois de uma consulta — parecia dado sumindo entre recargas.
  // Marcando cada linha com has_link, o frontend renderiza "Vincular" direto pras não
  // vinculadas, sem estado intermediário.
  const linkedRows = await query<{ utm_campaign: string }>(
    `SELECT utm_campaign FROM sms_campaign_map WHERE client_id = $1`, [clientId]
  );
  const linkedSet = new Set(linkedRows.map(r => r.utm_campaign));
  const rowsWithLink = rows.map(r => ({ ...r, has_link: linkedSet.has(r.utm_campaign) }));

  const total_vendas_sms = rows.reduce((sum, r) => sum + r.vendas, 0);
  const total_receita_liquida_sms = rows.reduce((sum, r) => sum + r.receita_liquida, 0);

  // Clareza de dados (achado da auditoria: card 428 vs tabela 427): o card "Vendas SMS"
  // conta TODAS as vendas mailxsms, mas a tabela só as com utm no padrão de automação
  // (utm_medium=auto-sms + utm_campaign rastreável). A diferença vira uma nota explícita
  // na tela em vez de uma discrepância silenciosa entre dois números "iguais".
  const totalAllSms = await queryOne<{ count: string }>(`
    SELECT COUNT(*) as count FROM webhook_logs
    WHERE client_id = $1 AND event_type = 'order.paid' AND ${SQL_MAILX_SMS}
      AND ${dateFilterSql}
  `, params);
  const vendas_sem_rastreio = Math.max(0, parseInt(totalAllSms?.count || '0', 10) - total_vendas_sms);

  res.json({
    period,
    from: rangeFrom,
    to: rangeTo,
    from_time: hasTime ? fromTime : null,
    to_time: hasTime ? toTime : null,
    currency,
    total_vendas_sms,
    total_receita_liquida_sms,
    vendas_sem_rastreio,
    rows: rowsWithLink,
  });
}));

// GET /admin/clientes/:id/sms-campaign-map - Lista os vínculos manuais utm_campaign -> campaign/workflow_id da SlickText
adminRouter.get('/clientes/:id/sms-campaign-map', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const rows = await query<{ utm_campaign: string; slicktext_campaign_id: number; source_type: string; workflow_node_id: number | null; st_account_id: number | null }>(
    `SELECT utm_campaign, slicktext_campaign_id, source_type, workflow_node_id, st_account_id FROM sms_campaign_map WHERE client_id = $1`,
    [clientId]
  );
  res.json({ mappings: rows });
}));

// POST /admin/clientes/:id/sms-campaign-map - Cria/atualiza o vínculo utm_campaign -> campaign/workflow_id da
// SlickText. Preenchido manualmente (não há como descobrir isso via API — ver countCampaignMessages).
// source_type: 'Campaign' (disparo manual em massa) ou 'Workflow' (automação — o caso comum do MailX,
// confirmado inspecionando o painel da SlickText). Default 'Campaign' por compatibilidade com vínculos antigos.
// workflow_node_id (opcional): quando o workflow tem VÁRIAS mensagens sequenciais (ex: MS0001A/02A/03A no
// mesmo fluxo), esse é o ID da mensagem específica dentro do workflow — confirmado via
// GET /analytics/workflows/{workflow_id}/nodes/{node_id}, que devolve envios/cliques só daquela mensagem,
// já filtrado por período. Sem isso, a contagem é do workflow inteiro (pode somar várias mensagens juntas).
// st_account_id (opcional): qual conta SlickText do cliente esse campaign/workflow_id pertence
// (null = conta principal) — necessário quando o cliente roda mais de uma conta em paralelo.
adminRouter.post('/clientes/:id/sms-campaign-map', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const { utm_campaign, slicktext_campaign_id, source_type, workflow_node_id, st_account_id } = req.body;
  const sourceType = source_type === 'Workflow' ? 'Workflow' : 'Campaign';
  const nodeId = Number.isInteger(workflow_node_id) ? workflow_node_id : null;
  const accountId = Number.isInteger(st_account_id) ? st_account_id : null;

  if (!utm_campaign || !Number.isInteger(slicktext_campaign_id)) {
    res.status(400).json({ error: 'utm_campaign (string) e slicktext_campaign_id (inteiro) são obrigatórios' });
    return;
  }

  await query(
    `INSERT INTO sms_campaign_map (client_id, utm_campaign, slicktext_campaign_id, source_type, workflow_node_id, st_account_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (client_id, utm_campaign)
     DO UPDATE SET slicktext_campaign_id = $3, source_type = $4, workflow_node_id = $5, st_account_id = $6, updated_at = NOW()`,
    [clientId, utm_campaign, slicktext_campaign_id, sourceType, nodeId, accountId]
  );

  res.json({ ok: true });
}));

/**
 * Extrai o utm_campaign de uma URL de link da SlickText. As URLs vêm com o utm_campaign
 * exato do checkout (ex: utm_campaign=Upsell-MS0001A-NeuromindPro-NovaConta630off) — a
 * mesma string gravada em webhook_logs.utm_campaign quando a venda entra. new URL() pode
 * falhar em URLs com placeholders {{email}}, então cai pro regex.
 */
function extractUtmCampaignFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const utm = parsed.searchParams.get('utm_campaign');
    if (utm) return utm;
  } catch { /* URL inválida (placeholders etc.) — tenta regex abaixo */ }
  const m = url.match(/[?&]utm_campaign=([^&\s]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// POST /admin/clientes/:id/sms-campaign-map/auto - Auto-vincula mensagens aos workflows/nodes da
// SlickText SEM digitação manual. Como: o analytics de cada workflow (GET /analytics/workflows?
// _workflow_id=X) devolve os LINKS do workflow, e cada link traz a URL completa do checkout — que
// contém o utm_campaign exato da venda — e o _sub_source_id, que é o workflow_node_id da mensagem
// que contém aquele link. Cruzando os dois, o vínculo utm_campaign -> (workflow, node, conta) sai
// sozinho. Se o mesmo utm_campaign aparecer em MAIS de um node/workflow (link reutilizado), cai pro
// vínculo de workflow inteiro (node null) pra não atribuir errado — e reporta a ambiguidade.
adminRouter.post('/clientes/:id/sms-campaign-map/auto', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const accounts = await getSlickTextAccounts(clientId);
  if (accounts.length === 0) {
    res.status(400).json({ error: 'SlickText não configurado para este cliente.' });
    return;
  }

  type Found = { workflowId: number; nodeId: number | null; accountId: number | null; accountLabel: string; workflowName?: string };
  const byUtm = new Map<string, Found[]>();
  // Links MANUAIS (criados direto no encurtador, sem workflow — o caso dos disparos N8N,
  // confirmado via dump em produção: source='manual', _source_id/_sub_source_id nulos).
  // Vínculo possível: utm -> conta (cliques por link no período; envios não existem via API).
  type FoundManual = { accountId: number | null; accountLabel: string };
  const manualByUtm = new Map<string, FoundManual[]>();
  const errors: string[] = [];
  // Clareza de dados: reporta o que foi varrido, pra "0 vinculados" nunca mais ser um mistério.
  const scanned: { workflow: string; account: string; links: number; linksComUtm: number }[] = [];

  for (const acc of accounts) {
    const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
    let workflows: { workflow_id: number; name: string }[] = [];
    try {
      workflows = await st.getWorkflows();
    } catch (err: any) {
      errors.push(`workflows (${acc.label}): ${err.message}`);
      continue;
    }
    // Sequencial por conta — respeita o rate limit de 8 req/s da SlickText.
    for (const wf of workflows) {
      try {
        // GET /links?_source_id — confirmado via probe em produção (o analytics com
        // _workflow_id na query NÃO devolve links via token; ver getWorkflowAnalytics).
        let links: any[] = await st.getLinks({ source: 'Workflow', _source_id: wf.workflow_id });
        if (!Array.isArray(links) || links.length === 0) {
          // Fallback: resumo vitalício do workflow, que também carrega os links.
          const byId = await st.getWorkflowAnalyticsById(wf.workflow_id).catch(() => null);
          links = byId?.links ? Object.values(byId.links) : [];
        }
        let linksComUtm = 0;
        for (const link of links) {
          const utm = extractUtmCampaignFromUrl(link?.url);
          if (!utm) continue;
          linksComUtm++;
          const nodeId = Number.isInteger(link?._sub_source_id) ? link._sub_source_id : null;
          const entry: Found = { workflowId: wf.workflow_id, nodeId, accountId: acc.accountId, accountLabel: acc.label, workflowName: wf.name };
          const list = byUtm.get(utm) || [];
          list.push(entry);
          byUtm.set(utm, list);
        }
        scanned.push({ workflow: wf.name, account: acc.label, links: links.length, linksComUtm });
      } catch (err: any) {
        errors.push(`links ${wf.name} (${acc.label}): ${err.message}`);
      }
    }

    // Segunda passada: links MANUAIS da conta (fora de qualquer workflow). Varre todos os
    // links paginados e pega os source='manual' com utm_campaign na URL de destino.
    try {
      const allLinks = await st.getAllLinks();
      const manualLinks = allLinks.filter((l: any) => l?.source === 'manual');
      let linksComUtm = 0;
      for (const link of manualLinks) {
        const utm = extractUtmCampaignFromUrl(link?.url);
        if (!utm) continue;
        linksComUtm++;
        const list = manualByUtm.get(utm) || [];
        list.push({ accountId: acc.accountId, accountLabel: acc.label });
        manualByUtm.set(utm, list);
      }
      scanned.push({ workflow: '(links manuais, sem workflow)', account: acc.label, links: manualLinks.length, linksComUtm });
    } catch (err: any) {
      errors.push(`links manuais (${acc.label}): ${err.message}`);
    }
  }

  const linked: { utm_campaign: string; workflow_id: number | null; workflow_node_id: number | null; account: string; ambiguous: boolean; manual?: boolean }[] = [];
  for (const [utm, entries] of byUtm) {
    // Dedup: o mesmo link pode aparecer mais de uma vez; o que importa é quantos
    // (workflow, node, conta) DISTINTOS apontam pra esse utm.
    const distinct = [...new Map(entries.map(e => [`${e.accountId}:${e.workflowId}:${e.nodeId}`, e])).values()];
    let choice: Found;
    let ambiguous = false;
    if (distinct.length === 1) {
      choice = distinct[0];
    } else {
      const workflowsDistinct = [...new Set(distinct.map(e => `${e.accountId}:${e.workflowId}`))];
      if (workflowsDistinct.length === 1) {
        // Mesmo workflow, nodes diferentes — o utm pertence ao workflow mas não dá pra cravar o
        // node; vincula no nível do workflow (a UI avisa com ⚠ que pode somar mensagens).
        choice = { ...distinct[0], nodeId: null };
        ambiguous = true;
      } else {
        // Workflows/contas diferentes disputando o mesmo utm — não vincula pra não atribuir errado.
        logger.warn(CTX, `Auto-vínculo: utm_campaign "${utm}" aparece em ${workflowsDistinct.length} workflows diferentes — pulado`);
        continue;
      }
    }
    await query(
      `INSERT INTO sms_campaign_map (client_id, utm_campaign, slicktext_campaign_id, source_type, workflow_node_id, st_account_id, updated_at)
       VALUES ($1, $2, $3, 'Workflow', $4, $5, NOW())
       ON CONFLICT (client_id, utm_campaign)
       DO UPDATE SET slicktext_campaign_id = $3, source_type = 'Workflow', workflow_node_id = $4, st_account_id = $5, updated_at = NOW()`,
      [clientId, utm, choice.workflowId, choice.nodeId, choice.accountId]
    );
    linked.push({ utm_campaign: utm, workflow_id: choice.workflowId, workflow_node_id: choice.nodeId, account: choice.accountLabel, ambiguous });
  }

  // Vínculos de links MANUAIS — só pros utms que NÃO saíram de workflow (workflow ganha:
  // tem envios por período e node; manual só tem cliques por link).
  for (const [utm, entries] of manualByUtm) {
    if (byUtm.has(utm)) continue;
    const accountsDistinct = [...new Map(entries.map(e => [`${e.accountId}`, e])).values()];
    if (accountsDistinct.length > 1) {
      logger.warn(CTX, `Auto-vínculo: utm_campaign "${utm}" tem links manuais em ${accountsDistinct.length} contas diferentes — pulado`);
      continue;
    }
    const choice = accountsDistinct[0];
    await query(
      `INSERT INTO sms_campaign_map (client_id, utm_campaign, slicktext_campaign_id, source_type, workflow_node_id, st_account_id, updated_at)
       VALUES ($1, $2, NULL, 'ManualLink', NULL, $3, NOW())
       ON CONFLICT (client_id, utm_campaign)
       DO UPDATE SET slicktext_campaign_id = NULL, source_type = 'ManualLink', workflow_node_id = NULL, st_account_id = $3, updated_at = NOW()`,
      [clientId, utm, choice.accountId]
    );
    linked.push({ utm_campaign: utm, workflow_id: null, workflow_node_id: null, account: choice.accountLabel, ambiguous: false, manual: true });
  }

  logger.info(CTX, `Auto-vínculo client ${clientId}: ${linked.length} utm_campaigns vinculados, ${scanned.length} workflows varridos (${errors.length} erros)`);
  res.json({ ok: true, linked, scanned, errors: errors.length ? errors : undefined });
}));

// GET /admin/clientes/:id/diagnostico/origem-dos-webhooks - DE QUAL conta Digistore vêm os
// webhooks, e quando cada uma parou de mandar.
//
// Pergunta que apareceu na operação: "qual Digistore, a nossa ou a do outro produtor?". Tinha
// resposta exata no banco desde sempre — o payload cru do IPN fica guardado em webhook_logs.payload,
// e o Digistore manda vendor/publisher/product em cada chamada. Sem isso a resposta seria
// especulação sobre a conta de alguém.
//
// Serve para duas coisas ao mesmo tempo: dizer de quem é a conta, e mostrar QUANDO cada origem
// recebeu o último webhook. Uma origem cujo último evento é de dias atrás enquanto outra continua
// chegando é entrega interrompida naquela conta específica, não venda que parou.
adminRouter.get('/clientes/:id/diagnostico/origem-dos-webhooks', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;

  // As chaves reais de UM payload, sem assumir nome de campo: o IPN da Digistore muda de formato
  // entre versões, e chutar nome de campo foi o que já produziu diagnóstico vazio antes.
  const amostra = await queryOne<{ chaves: string[]; quando: string }>(
    `SELECT ARRAY(SELECT jsonb_object_keys(payload)) AS chaves, created_at::text AS quando
     FROM webhook_logs
     WHERE client_id = $1 AND payload IS NOT NULL AND source = 'digistore24'
     ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  ).catch(() => null);

  // Agrupado pelos identificadores que a Digistore manda. COALESCE pra chave ausente virar '(não
  // veio no payload)' em vez de sumir a linha inteira do agrupamento.
  const porOrigem = await query<{
    vendor: string; publisher: string; produto: string; produto_nome: string; ipn_config: string;
    eventos: string; primeiro: string; ultimo: string; dias_sem_receber: string;
  }>(
    `SELECT
       -- merchant_id/merchant_name é o que o IPN da Digistore realmente manda; vendor_id não existe
       -- neste formato (conferido no dump de chaves de um payload real desta integração).
       COALESCE(payload->>'merchant_id', '(não veio no payload)') AS vendor,
       COALESCE(payload->>'merchant_name', '—') AS publisher,
       COALESCE(payload->>'product_id', '—') AS produto,
       COALESCE(payload->>'product_name', '—') AS produto_nome,
       COALESCE(payload->>'ipn_config_id', '—') AS ipn_config,
       COUNT(*) AS eventos,
       MIN(created_at)::date::text AS primeiro,
       MAX(created_at)::text AS ultimo,
       EXTRACT(DAY FROM NOW() - MAX(created_at))::int::text AS dias_sem_receber
     FROM webhook_logs
     WHERE client_id = $1 AND source = 'digistore24' AND payload IS NOT NULL
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY MAX(created_at) DESC`,
    [clientId]
  ).catch(() => []);

  // Último webhook por tipo de evento: uma conta pode continuar mandando reembolso e ter parado de
  // mandar pagamento, e o total geral esconderia isso.
  const porEvento = await query<{ event_type: string; eventos: string; ultimo: string }>(
    `SELECT event_type, COUNT(*) AS eventos, MAX(created_at)::text AS ultimo
     FROM webhook_logs WHERE client_id = $1
     GROUP BY event_type ORDER BY MAX(created_at) DESC`,
    [clientId]
  ).catch(() => []);

  const lojas = await query<{ shop_slug: string; platform: string; display_name: string | null }>(
    `SELECT shop_slug, platform, display_name FROM store_integrations WHERE client_id = $1`,
    [clientId]
  ).catch(() => []);

  // Resumo por CONTA, no topo. A pergunta é "qual Digistore", e ela se perdia em 38 linhas de
  // produto: cada produto virava uma linha e a conta aparecia repetida em todas.
  const porConta = new Map<string, { merchant: string; nome: string; eventos: number; ultimo: string }>();
  for (const o of porOrigem) {
    const chave = `${o.vendor}|${o.publisher}`;
    const atual = porConta.get(chave) ?? { merchant: o.vendor, nome: o.publisher, eventos: 0, ultimo: '' };
    atual.eventos += parseInt(o.eventos);
    if (o.ultimo > atual.ultimo) atual.ultimo = o.ultimo;
    porConta.set(chave, atual);
  }

  res.json({
    contas_que_enviaram: [...porConta.values()].sort((a, b) => (a.ultimo > b.ultimo ? -1 : 1)),
    como_ler: [
      'contas_que_enviaram é a resposta direta de "qual Digistore" — merchant_id e merchant_name vêm do próprio IPN.',
      'origens[] é o detalhe por produto dentro de cada conta.',
      'dias_sem_receber por origem: origem parada enquanto outra continua chegando é entrega interrompida NAQUELA conta, não venda que parou.',
      'chaves_de_um_payload mostra os campos que o IPN realmente traz nesta integração, para conferir se vendor/publisher existem mesmo.',
    ],
    lojas_cadastradas: lojas,
    chaves_de_um_payload: amostra?.chaves ?? null,
    ultimo_payload_em: amostra?.quando ?? null,
    origens: porOrigem.map(o => ({
      vendor: o.vendor,
      publisher: o.publisher,
      product_id: o.produto,
      product_name: o.produto_nome,
      // Qual configuração de IPN entregou. Se houver mais de uma, é mais de um cadastro de webhook
      // apontando pra cá — e uma delas pode ter sido desativada sem a outra.
      ipn_config_id: o.ipn_config,
      eventos: parseInt(o.eventos),
      primeiro_evento: o.primeiro,
      ultimo_evento: o.ultimo,
      dias_sem_receber: parseInt(o.dias_sem_receber),
    })),
    por_tipo_de_evento: porEvento.map(e => ({
      event_type: e.event_type,
      eventos: parseInt(e.eventos),
      ultimo: e.ultimo,
    })),
  });
}));

// GET /admin/clientes/:id/diagnostico/sem-utm - Investiga as vendas que chegam SEM UTM nenhuma
// (o grosso do não atribuído). Três perguntas, respondidas do payload cru salvo em JSONB:
//   1. são upsell/downsell dentro do funil? (produto começando com UP/DS/DW) — nesse caso a
//      compra secundária não herda a marcação da primeira e a atribuição se perde no meio do funil
//   2. o payload traz algum campo de rastreio que o extrator ignora? (campaignkey, tracking,
//      custom... — o extrator do Digistore deixa tracking_code sempre nulo)
//   3. quanto disso é reembolso/chargeback vs venda de verdade
// Só campos de rastreio são expostos, nada de dado pessoal.
adminRouter.get('/clientes/:id/diagnostico/sem-utm', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const SEM_UTM = `utm_source IS NULL AND utm_medium IS NULL AND utm_campaign IS NULL`;

  // 1. Concentração por tipo de produto: prefixo do SKU diz se é entrada (M), upsell (UP),
  //    downsell (DS) ou outra etapa (DW).
  const porTipo = await query<{ etapa: string; vendas: string; receita: string }>(`
    SELECT
      CASE
        WHEN product_name ~* '^\\s*UP'  THEN 'upsell (UP*)'
        WHEN product_name ~* '^\\s*DS'  THEN 'downsell (DS*)'
        WHEN product_name ~* '^\\s*DW'  THEN 'outra etapa (DW*)'
        WHEN product_name ~* '^\\s*M[0-9]' THEN 'entrada (M*)'
        WHEN product_name IS NULL THEN '(sem nome de produto)'
        ELSE 'outros'
      END AS etapa,
      COUNT(*) AS vendas, ${SQL_REVENUE} AS receita
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing')
      AND client_id = $1 AND ${SEM_UTM}
    GROUP BY 1 ORDER BY COUNT(*) DESC
  `, [clientId]);

  // Mesma quebra pras vendas COM UTM, pra comparar: se upsell é maioria só no grupo sem UTM,
  // a hipótese do funil se confirma.
  const porTipoComUtm = await query<{ etapa: string; vendas: string }>(`
    SELECT
      CASE
        WHEN product_name ~* '^\\s*UP'  THEN 'upsell (UP*)'
        WHEN product_name ~* '^\\s*DS'  THEN 'downsell (DS*)'
        WHEN product_name ~* '^\\s*DW'  THEN 'outra etapa (DW*)'
        WHEN product_name ~* '^\\s*M[0-9]' THEN 'entrada (M*)'
        WHEN product_name IS NULL THEN '(sem nome de produto)'
        ELSE 'outros'
      END AS etapa,
      COUNT(*) AS vendas
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing')
      AND client_id = $1 AND NOT (${SEM_UTM})
    GROUP BY 1 ORDER BY COUNT(*) DESC
  `, [clientId]);

  // 2. Quais chaves aparecem no payload dessas vendas — revela campo de rastreio não aproveitado.
  const chaves = await query<{ chave: string; ocorrencias: string; preenchidas: string }>(`
    SELECT k AS chave, COUNT(*) AS ocorrencias,
           COUNT(*) FILTER (WHERE NULLIF(TRIM(COALESCE(payload->>k, '')), '') IS NOT NULL) AS preenchidas
    FROM webhook_logs w, LATERAL jsonb_object_keys(w.payload) AS k
    WHERE w.event_type = 'order.paid' AND w.status IN ('processed','processing')
      AND w.client_id = $1 AND ${SEM_UTM.replace(/utm_/g, 'w.utm_')}
    GROUP BY k ORDER BY COUNT(*) DESC LIMIT 80
  `, [clientId]);

  // 3. Campos com cara de rastreio: mostra quantos vêm preenchidos e alguns valores distintos.
  const candidatos = ['campaignkey', 'tracking', 'tracking_key', 'trackingkey', 'custom',
    'affiliate', 'affiliate_name', 'sub_id', 'subid', 'tid', 'cid', 'coupon_code', 'voucher'];
  const rastreio: any[] = [];
  for (const campo of candidatos) {
    const r = await queryOne<{ preenchidos: string; exemplos: string[] }>(`
      SELECT COUNT(*) FILTER (WHERE NULLIF(TRIM(COALESCE(payload->>$2, '')), '') IS NOT NULL) AS preenchidos,
             (ARRAY_AGG(DISTINCT payload->>$2) FILTER (WHERE NULLIF(TRIM(COALESCE(payload->>$2, '')), '') IS NOT NULL))[1:5] AS exemplos
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND status IN ('processed','processing')
        AND client_id = $1 AND ${SEM_UTM}
    `, [clientId, campo]);
    const n = parseInt(r?.preenchidos || '0');
    if (n > 0) rastreio.push({ campo, vendas_com_valor: n, exemplos: r?.exemplos ?? [] });
  }

  res.json({
    sem_utm_por_etapa_do_funil: porTipo.map(r => ({ etapa: r.etapa, vendas: parseInt(r.vendas), receita: parseFloat(r.receita) })),
    com_utm_por_etapa_do_funil: porTipoComUtm.map(r => ({ etapa: r.etapa, vendas: parseInt(r.vendas) })),
    campos_de_rastreio_aproveitaveis: rastreio,
    chaves_do_payload: chaves.map(r => ({ chave: r.chave, ocorrencias: parseInt(r.ocorrencias), preenchidas: parseInt(r.preenchidas) })),
  });
}));

// GET /admin/clientes/:id/diagnostico/validacao-sms - Folha de conferência contra o painel da
// SlickText. NÃO recalcula envios/cliques de propósito: se recalculasse, estaríamos validando um
// segundo cálculo em vez da tela. O que ele faz é montar o roteiro — para cada mensagem vinculada,
// onde exatamente olhar no painel e com qual período — pra comparação ser sempre a mesma coisa
// contra a mesma coisa. Ordenado por receita: as mensagens que mais importam vêm primeiro.
adminRouter.get('/clientes/:id/diagnostico/validacao-sms', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const limite = Math.min(parseInt((req.query.limit as string) || '8'), 20);
  const period = resolvePeriodFilter(req);
  const { start, end } = await resolveSlickTextDateRange(req);

  // Vendas/receita por mensagem, com o mesmo filtro da tabela da tela.
  const vParams: (string | number)[] = [clientId];
  const vPeriod = periodSql(period, vParams);
  const vendasPorMsg = await query<{ utm_campaign: string; vendas: string; receita: string }>(`
    SELECT utm_campaign, COUNT(*) AS vendas, ${SQL_REVENUE} AS receita
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing') AND client_id = $1
      AND LOWER(TRIM(COALESCE(utm_medium, ''))) = 'auto-sms'
      AND LOWER(TRIM(COALESCE(utm_source, ''))) = 'mailx-sms'
      AND utm_campaign IS NOT NULL AND utm_campaign NOT ILIKE '%teste%'
      ${vPeriod ? `AND ${vPeriod}` : ''}
    GROUP BY utm_campaign ORDER BY ${SQL_REVENUE} DESC LIMIT ${limite}
  `, vParams);

  const vinculos = await query<{
    utm_campaign: string; slicktext_campaign_id: number | null; source_type: string;
    workflow_node_id: number | null; st_account_id: number | null;
  }>(`SELECT utm_campaign, slicktext_campaign_id, source_type, workflow_node_id, st_account_id
      FROM sms_campaign_map WHERE client_id = $1`, [clientId]);
  const porUtm = new Map(vinculos.map(v => [v.utm_campaign, v]));

  const contas = await getSlickTextAccounts(clientId);
  const contaPorId = new Map(contas.map(c => [c.accountId, c]));
  // Nome do fluxo por conta, pra folha dizer o nome que aparece no painel e não só o número.
  const nomeFluxo = new Map<string, string>();
  for (const acc of contas) {
    try {
      const wfs = await new SlickTextClient(acc.st_api_token, acc.st_brand_id).getWorkflows();
      wfs.forEach(w => nomeFluxo.set(`${acc.accountId}:${w.workflow_id}`, w.name));
    } catch { /* conta indisponível — a folha mostra só o id */ }
  }

  const linhas = vendasPorMsg.map(v => {
    const vinc = porUtm.get(v.utm_campaign);
    const conta = vinc ? contaPorId.get(vinc.st_account_id) : undefined;
    const brand = conta?.st_brand_id.replace(/\D/g, '') ?? null;
    const wf = vinc?.slicktext_campaign_id ?? null;
    return {
      mensagem: v.utm_campaign,
      vendas: parseInt(v.vendas),
      receita: parseFloat(v.receita),
      vinculo: vinc ? {
        tipo: vinc.source_type,
        conta: conta?.label ?? '(conta removida)',
        brand_id: brand,
        workflow_id: wf,
        workflow_nome: wf != null ? (nomeFluxo.get(`${vinc.st_account_id}:${wf}`) ?? '(nome não lido)') : null,
        node_id: vinc.workflow_node_id,
      } : null,
      // Onde olhar no painel. Sem isso a conferência vira caça ao tesouro e cada rodada compara
      // coisas diferentes — foi o que tornou a auditoria anterior trabalhosa.
      onde_conferir_no_painel: vinc && wf != null && brand
        ? {
            url: `https://app.slicktext.com/b${brand}/workflows/${wf}`,
            caminho: vinc.workflow_node_id
              ? `Analytics > Workflows > "${nomeFluxo.get(`${vinc.st_account_id}:${wf}`) ?? wf}" > mensagem (node ${vinc.workflow_node_id})`
              : `Analytics > Workflows > "${nomeFluxo.get(`${vinc.st_account_id}:${wf}`) ?? wf}" (fluxo inteiro)`,
            periodo_a_selecionar: { de: start.slice(0, 10), ate: end.slice(0, 10) },
          }
        : { aviso: vinc ? 'Vínculo sem workflow (link manual) — o painel não tem envios por mensagem nesse caso.' : 'Mensagem sem vínculo — rode o Auto-vincular antes de conferir.' },
      // Preencher com o que a TELA mostra e com o que o painel mostra.
      preencher: { dashboard_envios: null, painel_envios: null, dashboard_cliques: null, painel_cliques: null },
    };
  });

  res.json({
    instrucoes: [
      'Compare o que a TELA do dashboard mostra (não recalculado aqui) com o painel da SlickText.',
      `Selecione no painel exatamente o período ${start.slice(0, 10)} a ${end.slice(0, 10)}.`,
      'O painel usa horário de Nova York e o dashboard fecha o dia em UTC — diferença de poucos por cento é fuso, não erro.',
      'Preencha os quatro campos de cada linha e me devolva; eu calculo os desvios.',
    ],
    periodo: { de: start.slice(0, 10), ate: end.slice(0, 10), ativo: period.isToday || !!(period.from && period.to) },
    mensagens: linhas,
  });
}));

// GET /admin/clientes/:id/diagnostico/snapshots-listas - O retrato diário das listas está sendo
// gravado, e o cálculo de leads por período já resolve?
//
// Existe porque leads por período dependem de DOIS retratos (o do fim do período menos o da véspera
// do início), e o primeiro só passou a ser gravado no deploy de hoje. Sem uma forma de olhar, a
// única checagem possível seria esperar o dia virar e confiar — e um caminho de código que nunca
// rodou não é um caminho que funciona, é um que ainda não falhou.
//
// O que este endpoint mostra: se as linhas estão de fato sendo escritas (a gravação é silenciosa de
// propósito, para uma falha nela não derrubar o /stats), quais datas cada lista já tem, e — para o
// período pedido — qual das duas pontas falta em cada lista. Assim dá para ver hoje que a
// canalização está certa, e amanhã ver o número aparecer.
adminRouter.get('/clientes/:id/diagnostico/snapshots-listas', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const period = resolvePeriodFilter(req);

  const kits = await query<{ st_list_abandono_id: string | null; st_list_abandono_id_2: string | null; st_list_compra_id: string | null; st_list_compra_id_2: string | null }>(
    `SELECT DISTINCT st_list_abandono_id, st_list_abandono_id_2, st_list_compra_id, st_list_compra_id_2
     FROM kits WHERE client_id = $1 AND enabled = true`,
    [clientId]
  );
  const abandonoIds = [...new Set(kits.flatMap(k => listasDoKit(k).abandono))];
  const compraIds = [...new Set(kits.flatMap(k => listasDoKit(k).compra))];
  const todas = [...new Set([...abandonoIds, ...compraIds])];

  const retratos = await query<{ list_id: string; st_account_id: number | null; list_name: string | null; snapshot_date: string; contact_count: string }>(
    `SELECT list_id, st_account_id, list_name, snapshot_date::text AS snapshot_date, contact_count
     FROM list_contact_snapshots WHERE client_id = $1
     ORDER BY list_id, snapshot_date DESC`,
    [clientId]
  );

  const porLista = new Map<string, Array<{ data: string; contatos: number; conta: number | null }>>();
  const nomePorLista = new Map<string, string>();
  for (const r of retratos) {
    const arr = porLista.get(r.list_id) ?? [];
    arr.push({ data: r.snapshot_date.slice(0, 10), contatos: parseInt(r.contact_count), conta: r.st_account_id });
    porLista.set(r.list_id, arr);
    // Retratos vêm do mais recente para o mais antigo, então o primeiro nome visto é o atual.
    // Nome mudado no meio da série é sinal de alguém ter mexido na conta — vale ver a série inteira.
    if (r.list_name && !nomePorLista.has(r.list_id)) nomePorLista.set(r.list_id, r.list_name);
  }

  // Roda o MESMO cálculo que o /stats usa — não uma reimplementação. Se este devolver null, o da
  // tela devolve null também, e o motivo aparece na lista de pendências abaixo.
  const delta = period.from && period.to
    ? await leadsPorPeriodoViaSnapshots(clientId, abandonoIds, compraIds, period.from, period.to)
    : null;

  const diagnosticoPorLista = todas.map(id => {
    const rs = porLista.get(id) ?? [];
    const datas = rs.map(r => r.data);
    return {
      list_id: id,
      nome: nomePorLista.get(id) ?? null,
      segmento: abandonoIds.includes(id) ? (compraIds.includes(id) ? 'abandono e compra' : 'abandono') : 'compra',
      retratos_gravados: rs.length,
      datas,
      contagem_mais_recente: rs[0]?.contatos ?? null,
      falta: rs.length === 0
        ? 'nenhum retrato — abra a aba SMS do cliente uma vez para gravar o primeiro'
        : rs.length === 1
          ? `só o retrato de ${datas[0]} — falta um segundo dia para haver diferença`
          : null,
    };
  });

  const semRetrato = diagnosticoPorLista.filter(l => l.retratos_gravados === 0).length;
  const comUmSo = diagnosticoPorLista.filter(l => l.retratos_gravados === 1).length;

  res.json({
    periodo_pedido: { de: period.from ?? null, ate: period.to ?? null, ativo: !!(period.from && period.to) },
    gravacao: {
      listas_ativas: todas.length,
      listas_com_retrato: todas.length - semRetrato,
      listas_sem_nenhum_retrato: semRetrato,
      listas_com_apenas_um_dia: comUmSo,
      veredito: semRetrato === todas.length
        ? 'NADA GRAVADO — a gravação não está acontecendo. Abra a aba SMS do cliente e recarregue aqui; se continuar zero, é bug.'
        : semRetrato > 0
          ? 'Gravação funcionando, mas nem toda lista tem retrato — normal se alguma lista não respondeu à SlickText hoje.'
          : 'GRAVAÇÃO OK — todas as listas ativas têm retrato.',
    },
    calculo_de_leads_por_periodo: delta
      ? { resolve: true, leads_abandono: delta.abandono, leads_compra: delta.compra, retrato_inicial: delta.baseDate, retrato_final: delta.endDate }
      : {
          resolve: false,
          motivo: !(period.from && period.to)
            ? 'Sem período no parâmetro — passe ?from=YYYY-MM-DD&to=YYYY-MM-DD. Sem período a tela usa o total vitalício de propósito, não por falta de dado.'
            : comUmSo > 0 || semRetrato > 0
              ? 'Ainda não há dois retratos que cubram as duas pontas do período. É o esperado até o segundo dia de gravação — e é exatamente por isso que a tela cai no total vitalício ROTULADO, em vez de mostrar um número menor sem explicar.'
              : 'Há retratos, mas nenhum dentro da tolerância de 3 dias das pontas do período pedido. Tente um período que termine hoje.',
        },
    listas: diagnosticoPorLista,
    // Listas COM retrato que não estão vinculadas a kit nenhum. Existe por causa da migração do
    // NeuroMind: a lista vinculada estava congelada em 19.706 e a lista viva era outra, em outra
    // conta da SlickText, que o painel não olhava. O que decide qual é a viva não é o tamanho — é
    // qual CRESCE. Por isso aqui vai a variação da série, e não só a contagem atual.
    listas_sem_vinculo: [...porLista.keys()]
      .filter(id => !todas.includes(id))
      .map(id => {
        const rs = porLista.get(id)!;             // ordenada do mais recente para o mais antigo
        const atual = rs[0];
        const antiga = rs[rs.length - 1];
        return {
          list_id: id,
          nome: nomePorLista.get(id) ?? null,
          conta: atual.conta,
          contatos_agora: atual.contatos,
          retratos_gravados: rs.length,
          primeiro_retrato: antiga.data,
          // null, e não 0, enquanto há só um retrato: não medido é diferente de medido e parado, e
          // é justamente essa diferença que decide a religação.
          variacao: rs.length >= 2 ? atual.contatos - antiga.contatos : null,
          veredito: rs.length < 2
            ? 'sem série ainda — precisa de um segundo dia de retrato'
            : atual.contatos > antiga.contatos
              ? 'CRESCENDO — está recebendo contato novo'
              : 'PARADA — não entrou contato desde o primeiro retrato',
        };
      })
      .sort((a, b) => b.contatos_agora - a.contatos_agora),
    como_confirmar_amanha: [
      'Rode este endpoint com ?from= e ?to= terminando no dia de hoje.',
      'Quando calculo_de_leads_por_periodo.resolve virar true, a aba SMS passa a mostrar "entraram no período" com as datas na célula de Leads.',
      'Até lá a célula diz "total da lista (vitalício)" em amarelo — que é a resposta correta, não uma falha.',
    ],
  });
}));

// GET /admin/clientes/:id/diagnostico/probe-bot-clicks - Os cliques de bot estão DENTRO ou FORA do
// campo `clicks` do link?
//
// Importa porque os cliques das mensagens de link manual (N8N) são exibidos a partir de `clicks`,
// e um dos links tem 98 cliques com 26 bot_clicks — 26%. Se os bots estiverem dentro, a tela mostra
// 26% de clique a mais do que houve de pessoa. O tooltip afirmava que estavam "além desse total",
// mas essa afirmação não vinha de medição nenhuma: era suposição escrita como fato.
//
// Como decidir: um link de WORKFLOW tem clicks/bot_clicks no registro E aparece no
// /analytics/links/clicks. Pedindo o analytics com um período largo o bastante pra cobrir a vida
// inteira do link, o total tem que coincidir com `clicks` (bots fora) ou com `clicks + bot_clicks`
// (bots dentro). Compara os dois e diz qual bateu.
adminRouter.get('/clientes/:id/diagnostico/probe-bot-clicks', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const contas = await getSlickTextAccounts(clientId);
  const inicio = '2020-01-01 00:00:00';
  const fim = `${new Date().toISOString().slice(0, 10)} 23:59:59`;
  const saida = [];

  for (const acc of contas) {
    const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
    const workflows = await st.getWorkflows().catch(() => null);
    const casos = [];

    for (const wf of (workflows ?? []).slice(0, 3)) {
      const [links, clicksGrouped] = await Promise.all([
        st.getLinks({ source: 'Workflow', _source_id: wf.workflow_id }).catch(() => null),
        st.getLinkClicksGrouped(wf.workflow_id, inicio, fim).catch(() => null),
      ]);
      if (!links || !clicksGrouped) continue;

      const groups: any[] = Array.isArray(clicksGrouped?.groups) ? clicksGrouped.groups : [];
      for (const l of links) {
        const g = groups.find((x: any) => x?.name === l?.name);
        // Só serve como teste quem tem bot > 0: com bot 0 as duas hipóteses dão o mesmo número.
        if (!g || typeof l?.clicks !== 'number' || !l?.bot_clicks) continue;
        const analytics = g.total ?? null;
        casos.push({
          link_id: l.link_id,
          nome: l.name,
          clicks_do_registro: l.clicks,
          bot_clicks_do_registro: l.bot_clicks,
          soma_clicks_mais_bot: l.clicks + l.bot_clicks,
          total_do_analytics: analytics,
          // Tolerância de 1%: exigir igualdade exata dava "inconclusivo" em 8 de 8 casos reais,
          // quando o padrão era evidente — o analytics ficava 0,1–0,3% abaixo de `clicks` e a
          // 3–4x de distância de `clicks + bot_clicks`. A sobra de 2 a 7 cliques é ruído de borda
          // (clique de contato removido, corte de dia), não ambiguidade. Um teste que só aceita
          // coincidência perfeita não decide nada em dado de produção.
          bate_com: analytics == null ? 'sem total no analytics'
            : Math.abs(analytics - l.clicks) <= Math.max(10, l.clicks * 0.01) ? 'clicks (BOTS ESTÃO FORA)'
            : Math.abs(analytics - (l.clicks + l.bot_clicks)) <= Math.max(10, (l.clicks + l.bot_clicks) * 0.01) ? 'clicks + bot_clicks (BOTS ESTÃO DENTRO de clicks)'
            : 'nenhum dos dois — inconclusivo neste link',
        });
        if (casos.length >= 6) break;
      }
      if (casos.length >= 6) break;
    }

    const votos = casos.map(c => c.bate_com);
    const fora = votos.filter(v => v.startsWith('clicks (')).length;
    const dentro = votos.filter(v => v.startsWith('clicks + ')).length;
    saida.push({
      conta: acc.label,
      brand_id: acc.st_brand_id.replace(/\D/g, ''),
      casos,
      veredito: casos.length === 0
        ? 'Nenhum link de workflow com bot_clicks > 0 nos fluxos testados — sem caso de teste, inconclusivo.'
        : fora > dentro ? 'BOTS ESTÃO FORA do campo clicks — o número que exibimos já é só de pessoa.'
        : dentro > fora ? 'BOTS ESTÃO DENTRO do campo clicks — precisamos subtrair bot_clicks do que exibimos.'
        : 'Empate ou inconclusivo — não mudar nada com base nisso.',
    });
  }

  res.json({ periodo_usado: { de: inicio, ate: fim }, contas: saida });
}));

// GET /admin/clientes/:id/diagnostico/utm-fora-do-padrao - Vendas de SMS cujo utm_medium não é
// 'auto-sms', e o que cada uma custa em visibilidade.
//
// A spec (UTMS_DASH) manda `utm_source=mailx-sms` + `utm_medium=auto-sms`. Link que sai fora disso
// não deixa de vender — deixa de aparecer. Encontrado ao validar o SMS: os links do Horse Peak N8N
// usam `utm_medium=WFI001` e `WFI002-Upsell`. Antes da correção do SQL_IS_SMS essas vendas eram
// contadas como EMAIL; agora contam como SMS no card, mas continuam fora da tabela por mensagem,
// que exige `auto-sms` exato.
//
// Este endpoint lista cada combinação fora do padrão com vendas e receita, pra decidir entre
// corrigir os links na SlickText (preferível — resolve na origem e vale pra qualquer sistema) ou
// afrouxar o filtro da tabela (aceita o desvio pra sempre).
adminRouter.get('/clientes/:id/diagnostico/utm-fora-do-padrao', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const period = resolvePeriodFilter(req);
  const params: (string | number)[] = [clientId];
  const periodoSql = periodSql(period, params);

  const fora = await query<{
    utm_source: string | null; utm_medium: string | null; utm_campaign: string | null;
    vendas: string; receita: string; primeira: string; ultima: string;
  }>(`
    SELECT utm_source, utm_medium, utm_campaign,
           COUNT(*) AS vendas, ${SQL_REVENUE} AS receita,
           MIN(created_at)::date::text AS primeira, MAX(created_at)::date::text AS ultima
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing') AND client_id = $1
      AND REPLACE(COALESCE(utm_source, ''), '-', '') ILIKE '%mailxsms%'
      AND LOWER(TRIM(COALESCE(utm_medium, ''))) <> 'auto-sms'
      ${periodoSql ? `AND ${periodoSql}` : ''}
    GROUP BY utm_source, utm_medium, utm_campaign
    ORDER BY ${SQL_REVENUE} DESC
  `, params);

  const dentroParams: (string | number)[] = [clientId];
  const dentroPeriodo = periodSql(period, dentroParams);
  const dentro = await queryOne<{ vendas: string; receita: string }>(`
    SELECT COUNT(*) AS vendas, ${SQL_REVENUE} AS receita
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing') AND client_id = $1
      AND LOWER(TRIM(COALESCE(utm_source, ''))) = 'mailx-sms'
      AND LOWER(TRIM(COALESCE(utm_medium, ''))) = 'auto-sms'
      ${dentroPeriodo ? `AND ${dentroPeriodo}` : ''}
  `, dentroParams);

  const totalForaVendas = fora.reduce((s, f) => s + parseInt(f.vendas), 0);
  const totalForaReceita = fora.reduce((s, f) => s + parseFloat(f.receita), 0);

  res.json({
    periodo: { de: period.from ?? null, ate: period.to ?? null, ativo: period.isToday || !!(period.from && period.to) },
    no_padrao: { vendas: parseInt(dentro?.vendas || '0'), receita: parseFloat(dentro?.receita || '0') },
    fora_do_padrao: {
      vendas: totalForaVendas,
      receita: totalForaReceita,
      // O que essas vendas perdem: entram no card de SMS, mas não têm linha na tabela por mensagem,
      // então não recebem envios, cliques nem razão envios/venda.
      consequencia: 'Contam no faturamento SMS, mas ficam fora da tabela por mensagem (que exige utm_medium = auto-sms exato) — sem envios, cliques nem envios/venda.',
      combinacoes: fora.map(f => ({
        utm_source: f.utm_source,
        utm_medium: f.utm_medium,
        utm_campaign: f.utm_campaign,
        vendas: parseInt(f.vendas),
        receita: parseFloat(f.receita),
        primeira_venda: f.primeira,
        ultima_venda: f.ultima,
      })),
    },
    como_resolver: totalForaVendas > 0
      ? 'Preferível corrigir na origem: reeditar esses links na SlickText para utm_medium=auto-sms. Resolve para qualquer sistema e não deixa exceção no código. Alternativa: afrouxar o filtro da tabela, que aceita o desvio permanentemente.'
      : 'Nada fora do padrão neste período.',
  });
}));

// GET /admin/clientes/:id/diagnostico/probe-link-manual - Dá pra recuperar os envios das mensagens
// que usam link criado à mão?
//
// O problema: duas mensagens (os disparos N8N) usam link com source='manual', criado direto no
// encurtador. Link manual não pertence a workflow nem a node, e é justamente o node que a API usa
// pra contar envios por mensagem — então essas linhas mostram "envios n/d". Isso está no relatório
// como o único item sem solução do pedido 3.3.
//
// A saída possível: o link manual foi COLADO dentro da mensagem de algum workflow. Se o corpo das
// mensagens enviadas trouxer o texto, dá pra achar qual node contém aquele slk1.io e, com o node em
// mãos, a contagem por período volta a funcionar pelo caminho normal. Esta sonda testa isso: mostra
// os campos de um registro de /messages (o corpo está lá?) e procura o slug de cada link manual no
// corpo das mensagens de cada workflow da conta.
adminRouter.get('/clientes/:id/diagnostico/probe-link-manual', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const contas = await getSlickTextAccounts(clientId);
  const saida = [];

  for (const acc of contas) {
    const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
    const [todosLinks, workflows] = await Promise.all([
      st.getAllLinks().catch(() => null),
      st.getWorkflows().catch(() => null),
    ]);

    const manuaisCrus = (todosLinks ?? []).filter((l: any) => String(l?.source ?? '').toLowerCase() === 'manual');
    const manuais = manuaisCrus.map((l: any) => ({
      link_id: l?.link_id ?? l?.id ?? null,
      nome: l?.name ?? null,
      url_destino: l?.url ?? null,
      cliques_vitalicio: l?.clicks ?? null,
    }));
    const idsManuaisPrecoce = manuais.map(m => Number(m.link_id)).filter(n => Number.isFinite(n));

    // Formato de um registro de /messages: o corpo da mensagem está exposto? É a pergunta que
    // decide se o caminho existe. Sem nome de campo assumido — devolve as chaves como vieram.
    let amostraMensagem: any = null;
    const primeiroWf = workflows?.[0]?.workflow_id;
    if (primeiroWf) {
      amostraMensagem = await st.rawMessagesSample(primeiroWf).catch((e: any) => ({ erro: e.message }));
    }

    // Cada mensagem traz `_link_ids` — os links contidos nela. Se /messages aceitar filtro por
    // link, a contagem de envios do link manual sai direto, sem depender de node. Testa os nomes
    // de parâmetro plausíveis e VERIFICA se o retorno realmente ficou filtrado: um parâmetro
    // ignorado devolve 200 com as mensagens de sempre, e aceitar isso como sucesso produziria uma
    // contagem errada com cara de certa (foi exatamente o que aconteceu com filters[tagid] no AC).
    const alvo = manuais.find(m => m.link_id != null);
    const filtros: Record<string, any> = {};
    if (alvo) {
      const controle = await st.rawMessages({ limit: 5 }).catch(() => []);
      const idsControle = controle.map((m: any) => m?._id).join(',');

      const variantes: Record<string, any> = {
        '_link_id': { _link_id: alvo.link_id, limit: 5 },
        'link_id': { link_id: alvo.link_id, limit: 5 },
        '_link_ids': { _link_ids: alvo.link_id, limit: 5 },
        '_link_ids[]': { '_link_ids[]': alvo.link_id, limit: 5 },
      };
      for (const [nome, params] of Object.entries(variantes)) {
        try {
          const itens = await st.rawMessages(params);
          const contemOAlvo = itens.length > 0 && itens.every((m: any) =>
            Array.isArray(m?._link_ids) && m._link_ids.map(Number).includes(Number(alvo.link_id))
          );
          filtros[nome] = {
            devolveu: itens.length,
            todos_contem_o_link: contemOAlvo,
            igual_ao_controle_sem_filtro: itens.map((m: any) => m?._id).join(',') === idsControle,
            veredito: contemOAlvo ? 'FILTRO FUNCIONA' : 'ignorado ou não filtra por link',
            links_do_primeiro: itens[0]?._link_ids ?? null,
          };
        } catch (err: any) {
          filtros[nome] = { erro: err.message };
        }
      }
    }

    // Plano B: procurar o link_id dentro de `_link_ids` das mensagens de cada workflow. Acha o
    // workflow do link manual, e daí a contagem por período sai pelo caminho do workflow (que é
    // filtrado por data de verdade).
    //
    // SÓ com ?scan=1, e um workflow por chamada com ?workflow_id=. Varrer os 7 workflows das duas
    // contas numa requisição estourou o timeout do nginx (504) — a resposta demorada não é um
    // resultado ruim, é resultado nenhum. Separado assim, cada chamada é curta e o progresso fica
    // com quem chama.
    const idsManuais = idsManuaisPrecoce;
    const scan = req.query.scan === '1';
    const wfPedido = req.query.workflow_id ? parseInt(req.query.workflow_id as string) : null;
    const buscas = [];
    if (scan && workflows && idsManuais.length > 0) {
      const alvos = wfPedido != null
        ? workflows.filter(w => w.workflow_id === wfPedido)
        : workflows.slice(0, 2); // sem workflow_id, só os dois primeiros — pra não repetir o 504
      for (const wf of alvos) {
        const achados = await st.acharLinksEmMensagens(wf.workflow_id, idsManuais).catch(() => null);
        if (achados && achados.length > 0) buscas.push({ workflow_id: wf.workflow_id, nome: wf.name, achados });
      }
    }

    // Plano C: as mensagens mais recentes da marca, SEM filtro de source. Responde de uma vez se
    // existe disparo fora de workflow (o n8n mandando pela API) — hipótese que varrer fluxo por
    // fluxo nunca testaria, por mais fluxos que se varra.
    let fonteDasMensagens: any = null;
    if (req.query.fontes === '1' && idsManuaisPrecoce.length > 0) {
      fonteDasMensagens = await st.amostrarMensagensRecentes(idsManuaisPrecoce).catch((e: any) => ({ erro: e.message }));
    }

    const filtroOk = Object.values(filtros).some((f: any) => f?.todos_contem_o_link);
    saida.push({
      conta: acc.label,
      brand_id: acc.st_brand_id.replace(/\D/g, ''),
      links_manuais: manuais,
      registro_cru_de_um_link: manuaisCrus[0] ?? null,
      campos_de_um_registro_de_messages: amostraMensagem && !amostraMensagem.erro ? Object.keys(amostraMensagem) : amostraMensagem,
      filtro_de_messages_por_link: filtros,
      workflows_da_conta: (workflows ?? []).map(w => ({ workflow_id: w.workflow_id, nome: w.name })),
      varredura: scan
        ? { rodou: true, workflows_varridos: wfPedido != null ? [wfPedido] : (workflows ?? []).slice(0, 2).map(w => w.workflow_id) }
        : { rodou: false, como_rodar: 'Acrescente ?scan=1&workflow_id=<id> — um workflow por chamada, senão estoura o timeout.' },
      onde_o_link_manual_aparece: buscas,
      fontes_das_mensagens_recentes: fonteDasMensagens ?? { rodou: false, como_rodar: 'Acrescente ?fontes=1 — lista os valores de `source` que existem de fato e procura os links manuais neles.' },
      veredito: filtroOk
        ? 'ACHADO — /messages filtra por link. Envios do link manual saem direto, por período, sem depender de node.'
        : fonteDasMensagens?.com_link_manual?.length > 0
          ? 'ACHADO PELO PLANO C — o link manual aparece em mensagens reais; veja `source` e `_source_id` delas para saber por onde contar.'
          : buscas.length > 0
            ? 'ACHADO PELO PLANO B — o link manual aparece em mensagens de um workflow conhecido. Dá pra contar por ali.'
            : fonteDasMensagens && !fonteDasMensagens.erro
              ? 'Não achado. Se `fontes` mostra só Workflow/Campaign, os disparos com link manual não estão nas mensagens recentes desta marca — e aí "envios n/d" é definitivo.'
              : 'Nada achado ainda. Rode com ?fontes=1 (mais informativo) antes de varrer fluxo por fluxo.',
    });
  }

  res.json({ contas: saida });
}));

// GET /admin/clientes/:id/diagnostico/probe-envios - O total de /analytics/messages é MENSAGEM ou
// CRÉDITO?
//
// RESPONDIDO: é MENSAGEM ENVIADA. Todas as variantes com source=Workflow devolvem o mesmo total,
// attempted não altera nada, attempted=0 devolve vazio e não existe campo irmão de crédito em
// totals (só total e average). Validado contra o painel na marca 30571 em 01–29/07: 13.116 pela
// API contra 13.081 no painel — 0,27%, que é o fuso (painel em Nova York, nós em UTC).
//
// Fica de aviso o erro que motivou a sonda: comparou-se o 38.191 da marca 27972 com o 13.081 lido
// de uma tela de painel que era de OUTRA marca (a 30571), a razão deu 2,9x e pareceu que o
// endpoint contava trechos. Antes de acusar divergência contra o painel, confirme de qual brand a
// tela é — as duas contas do mesmo cliente têm volumes parecidos e é fácil trocar.
//
// A sonda fica no código porque a pergunta volta a cada conta nova: ela varia um parâmetro por vez
// e mostra o totals cru de cada variante, pra decidir por comparação em vez de por suposição.
adminRouter.get('/clientes/:id/diagnostico/probe-envios', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const { start, end } = await resolveSlickTextDateRange(req);
  const contas = await getSlickTextAccounts(clientId);
  const saida = [];

  for (const acc of contas) {
    const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
    const base = { start, end, compare: '', frequency: '', timezone: 'UTC', noCache: 0 };
    const variantes: Record<string, any> = {
      'source=Workflow + attempted=1 (o que usamos hoje)': { source: 'Workflow', attempted: 1, ...base },
      'source=Workflow sem attempted': { source: 'Workflow', ...base },
      'source=Workflow + attempted=0': { source: 'Workflow', attempted: 0, ...base },
      'sem source (marca inteira)': { ...base },
      'source=Workflow + direction=outgoing': { source: 'Workflow', direction: 'outgoing', ...base },
    };

    const resultados: Record<string, any> = {};
    for (const [nome, params] of Object.entries(variantes)) {
      try {
        const d = await st.rawMessageAnalytics(params);
        resultados[nome] = {
          total: d?.totals?.total ?? null,
          // Campos irmãos do total: se existir um credits/segments ao lado, a dúvida acaba aqui.
          outros_campos_em_totals: d?.totals ? Object.keys(d.totals) : null,
          totals_completo: d?.totals ?? null,
          nomes_dos_groups: Array.isArray(d?.groups) ? d.groups.map((g: any) => g?.name) : null,
        };
      } catch (err: any) {
        resultados[nome] = { erro: err.message };
      }
    }

    saida.push({ conta: acc.label, brand_id: acc.st_brand_id.replace(/\D/g, ''), variantes: resultados });
  }

  res.json({
    periodo: { de: start.slice(0, 10), ate: end.slice(0, 10) },
    ja_respondido: {
      conclusao: 'O total é MENSAGEM ENVIADA, não crédito.',
      evidencia: 'Marca 30571, 01–29/07: 13.116 pela API contra 13.081 no painel (0,27% — fuso horário).',
      creditos: 'Crédito é outra grandeza: a mesma marca consumiu 39.215 créditos nesses 13.081 envios, 3,0 créditos por envio (mensagem acima de 160 caracteres é cobrada por trecho).',
      cuidado: 'Ao conferir contra o painel, confirme de qual brand a tela é. As duas contas do cliente têm volumes parecidos e comparar marcas trocadas produz uma divergência de 2,9x que não existe.',
    },
    contas: saida,
  });
}));

// GET /admin/clientes/:id/diagnostico/probe-data-de-entrada?list_id=XXXXX - A SlickText devolve,
// por CONTATO, a data em que ele entrou NAQUELA LISTA?
//
// Por que importa: hoje "leads do período" é a diferença entre dois retratos diários da lista —
// funciona, mas tem margem de ±1 dia (o retrato pode não bater exatamente com a virada do dia) e
// só existe série a partir do dia em que o retrato começou a ser gravado. Se a API devolver, por
// contato, uma data de ENTRADA NA LISTA (não confundir com data de criação do contato em geral,
// que pode ser bem anterior — a pessoa pode ter entrado em outra lista meses atrás e só ter
// entrado NESTA agora), dá pra contar leads exatos de qualquer período, incluindo período de
// ANTES do primeiro retrato.
//
// Não SUBSTITUI o retrato — o retrato continua sendo a fonte para clientes sem esse campo, ou
// enquanto o probe não confirmar. É só o que decide se vale migrar.
//
// Sonda em duas camadas: primeiro pega uma amostra pequena e mostra TODOS os campos que vieram
// (pra decidir olhando os nomes reais, não adivinhando); depois, se algum campo parecer data de
// lista, cruza contra o próprio retrato: um contato com data de entrada dentro da janela dos
// últimos dois retratos tem que estar entre os que a diferença de retrato também contou. Se as
// contagens não baterem, o campo existe mas significa outra coisa, e o probe diz isso em vez de
// assumir que serve.
adminRouter.get('/clientes/:id/diagnostico/probe-data-de-entrada', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const listIdParam = req.query.list_id ? parseInt(String(req.query.list_id)) : null;
  const contas = await getSlickTextAccounts(clientId);

  if (contas.length === 0) {
    res.json({ erro: 'Cliente sem conta SlickText configurada.' });
    return;
  }

  // Sem list_id, usa a primeira lista de compra vinculada — sonda tem que ter algo concreto pra
  // olhar, e lista de compra é a que mais importa pro caso de uso (leads exatos de comprador).
  let listId = listIdParam;
  let listaEscolhidaAutomaticamente = false;
  if (!listId) {
    const kit = await queryOne<{ st_list_compra_id: string | null }>(
      `SELECT st_list_compra_id FROM kits WHERE client_id = $1 AND enabled = true AND st_list_compra_id IS NOT NULL LIMIT 1`,
      [clientId]
    );
    if (kit?.st_list_compra_id) { listId = parseInt(kit.st_list_compra_id); listaEscolhidaAutomaticamente = true; }
  }

  if (!listId) {
    res.json({ erro: 'Nenhuma lista de compra vinculada e nenhum ?list_id= informado.' });
    return;
  }

  const amostras: any[] = [];
  const errosPorConta: Array<{ conta: string; erro: string }> = [];

  for (const acc of contas) {
    const rotulo = acc.accountId == null ? 'principal' : `extra #${acc.accountId}`;
    try {
      const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
      const registros = await st.rawListContacts(listId, { offset: 0, limit: 5 });
      if (registros.length === 0) continue; // lista não existe nesta conta — esperado, não é erro
      amostras.push({ conta: rotulo, brand_id: acc.st_brand_id, registros });
    } catch (err: any) {
      errosPorConta.push({ conta: rotulo, erro: err.message });
    }
  }

  // Candidatos a "data de entrada NESTA lista": qualquer campo cujo nome sugira isso. Nome
  // literal, sem adivinhar semântica — quem lê decide olhando o valor.
  const padraoCampoData = /list.*(date|added|joined|created)|date.*(list|added|joined)|added_at|joined_at|list_created|added_to_list/i;
  const camposEncontrados = new Set<string>();
  for (const a of amostras) {
    for (const r of a.registros) {
      for (const campo of Object.keys(r ?? {})) {
        if (padraoCampoData.test(campo)) camposEncontrados.add(campo);
      }
    }
  }

  // ── Teste cruzado: `created` é do CONTATO ou da ENTRADA NESTA LISTA? ──
  //
  // Amostra sozinha não decide isso: numa conta NOVA, alimentada por API direto na lista de
  // compra, todo contato nasce já naquela lista — `created` bate com "entrou na lista" só porque
  // não existe passado nenhum antes disso, não porque o campo signifique isso.
  //
  // O teste real: achar a MESMA PESSOA em duas listas do MESMO produto (abandonou o carrinho,
  // comprou depois) e comparar o `created` lido via cada lista. Se vier IGUAL nas duas, o campo é
  // do CONTATO (não muda por lista) e não serve pra medir entrada — o retrato continua sendo a
  // única fonte. Se vier DIFERENTE, `created` muda por lista e é candidato real.
  let testeCruzado: any = { executado: false, motivo: 'nenhum kit com abandono e compra vinculados foi encontrado' };
  // TODOS os pares abandono/compra, não só o primeiro kit: um produto pode ter migrado (como o
  // NeuroMind) e ter as duas listas em CONTAS DIFERENTES — nesse caso não existe conta onde as
  // duas respondam juntas, e o teste não é possível com aquele produto. Sem tentar outros pares,
  // o resultado ficava indistinguível de "nenhum produto tem as duas listas vinculadas", que é
  // outra situação (e falsa aqui: 21 dos 24 kits têm as duas colunas preenchidas).
  const paresParaCruzar = await query<{ nome: string; abandono: string; compra: string }>(
    `SELECT DISTINCT name AS nome, st_list_abandono_id AS abandono, st_list_compra_id AS compra
     FROM kits
     WHERE client_id = $1 AND enabled = true
       AND st_list_abandono_id IS NOT NULL AND st_list_compra_id IS NOT NULL`,
    [clientId]
  );

  const paresTentados: Array<{ produto: string; motivo: string }> = [];
  buscaDoTesteCruzado:
  for (const par of paresParaCruzar) {
    for (const acc of contas) {
      const rotulo = acc.accountId == null ? 'principal' : `extra #${acc.accountId}`;
      try {
        const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
        const [doAbandono, doCompra] = await Promise.all([
          st.rawListContacts(parseInt(par.abandono), { offset: 0, limit: 200 }),
          st.rawListContacts(parseInt(par.compra), { offset: 0, limit: 200 }),
        ]);
        // As duas listas do produto têm que existir NESTA conta — se uma vier vazia, as listas
        // do kit vivem em contas diferentes (caso do NeuroMind: abandono na principal, compra na
        // 32935) e a comparação não é válida aqui. Tenta a próxima conta, depois o próximo par.
        if (doAbandono.length === 0 || doCompra.length === 0) continue;

        const porId = new Map(doAbandono.map((c: any) => [c.contact_id, c]));
        const comum = doCompra.filter((c: any) => porId.has(c.contact_id));
        if (comum.length === 0) {
          paresTentados.push({ produto: par.nome, motivo: `sem contato em comum na amostra (200 de cada) na conta ${rotulo}` });
          continue;
        }

        const comparacoes = comum.slice(0, 5).map((c: any) => {
          const doLadoAbandono = porId.get(c.contact_id);
          return {
            contact_id: c.contact_id,
            created_via_lista_abandono: doLadoAbandono.created,
            created_via_lista_compra: c.created,
            iguais: doLadoAbandono.created === c.created,
          };
        });
        const todasIguais = comparacoes.every((c: any) => c.iguais);
        testeCruzado = {
          executado: true,
          conta: rotulo,
          produto: par.nome,
          contatos_em_comum_na_amostra: comum.length,
          comparacoes,
          veredito: todasIguais
            ? '`created` veio IGUAL nas duas listas pra mesma pessoa — é a data de criação do CONTATO, não de entrada NESTA lista. NÃO usar para leads-por-período; o retrato diário continua sendo a única fonte confiável.'
            : '`created` MUDOU entre as duas listas pra mesma pessoa — candidato real a data de entrada por lista. Vale aprofundar: comparar contra webhook_logs.created_at antes de migrar o cálculo.',
        };
        break buscaDoTesteCruzado;
      } catch {
        continue; // conta sem essa lista — tenta a próxima
      }
    }
  }
  if (!testeCruzado.executado && paresParaCruzar.length > 0) {
    testeCruzado = {
      executado: false,
      motivo: paresTentados.length > 0
        ? `${paresParaCruzar.length} produto(s) com abandono+compra vinculados, mas nenhum teve as duas listas respondendo na MESMA conta com contato em comum. Detalhe: ${JSON.stringify(paresTentados)}`
        : `${paresParaCruzar.length} produto(s) com abandono+compra vinculados, mas as listas de cada um vivem em contas diferentes (produto migrado, ver /diagnostico/inventario-de-listas) — não há onde comparar.`,
    };
  }

  res.json({
    pergunta: 'A SlickText devolve, por contato, a data em que ele entrou NESTA lista (não a data de criação do contato)?',
    lista_sondada: { list_id: listId, escolhida_automaticamente: listaEscolhidaAutomaticamente },
    cobertura: {
      contas_lidas: contas.length - errosPorConta.length,
      contas_com_erro: errosPorConta,
    },
    campos_candidatos_a_data_de_entrada: [...camposEncontrados],
    veredito: camposEncontrados.size === 0
      ? 'NENHUM campo com nome de data de entrada apareceu na amostra. Ou o endpoint não devolve isso, ou o nome do campo não bate com o padrão procurado — olhe "todos_os_campos_da_amostra" abaixo e leia os nomes um por um antes de concluir que não existe.'
      : `${camposEncontrados.size} campo(s) candidato(s) encontrado(s): ${[...camposEncontrados].join(', ')}. Ver "teste_cruzado" abaixo — é ele que decide se o campo serve, não a presença sozinha.`,
    teste_cruzado: testeCruzado,
    // Todos os campos crus de uma amostra, para ler manualmente quando o padrão de nome não achar
    // nada — a SlickText pode nomear o campo de um jeito que ninguém adivinha de primeira.
    todos_os_campos_da_amostra: amostras[0]?.registros?.[0] ? Object.keys(amostras[0].registros[0]) : null,
    amostras_completas: amostras,
  });
}));

// GET /admin/clientes/:id/diagnostico/cobertura-automacao - Quanto dos envios de automação da
// conta está coberto pelas mensagens que temos vinculadas.
//
// Por que existe: a conferência mensagem-por-mensagem contra o painel é impossível — o painel da
// SlickText (Analytics > Workflows) só mostra agregado da MARCA INTEIRA, sem quebra por mensagem.
// O que o painel dá, e que serve como contra-prova de verdade, é o total de envios de automação do
// período ("Workflow Messages Sent"). Esse total também existe na API sem _source_id, então aqui a
// gente compara: total da marca × soma dos workflows que temos vinculados. Se a cobertura é alta, a
// tabela por mensagem está olhando praticamente toda a automação; se é baixa, existe automação
// rodando fora do nosso mapeamento e o desempenho por mensagem conta uma parte da história.
//
// Créditos: o /usage é vitalício, mas o saldo restante é o que importa operacionalmente — fluxo
// ativo com crédito no fim para de enviar sem erro nenhum, e do nosso lado isso parece só uma
// queda de envios. Por isso o saldo vem aqui junto com a média diária de consumo do período.
adminRouter.get('/clientes/:id/diagnostico/cobertura-automacao', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const period = resolvePeriodFilter(req);
  const { start, end } = await resolveSlickTextDateRange(req);
  const dias = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000));

  const vinculos = await query<{ slicktext_campaign_id: number | null; st_account_id: number | null; source_type: string }>(
    `SELECT DISTINCT slicktext_campaign_id, st_account_id, source_type
     FROM sms_campaign_map WHERE client_id = $1 AND source_type = 'Workflow' AND slicktext_campaign_id IS NOT NULL`,
    [clientId]
  );

  const contas = await getSlickTextAccounts(clientId);
  const resultado = [];

  for (const acc of contas) {
    const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
    const brand = acc.st_brand_id.replace(/\D/g, '');
    const meusWorkflows = vinculos
      .filter(v => v.st_account_id === acc.accountId)
      .map(v => v.slicktext_campaign_id as number);

    const [totalMarca, usage, todosWorkflows] = await Promise.all([
      st.getWorkflowMessagesTotalForBrand(start, end).catch(() => null),
      st.getBrandUsage().catch(() => null),
      st.getWorkflows().catch(() => null),
    ]);

    // Envios de cada workflow vinculado no período, um por um (o total por workflow é filtrado
    // por data de verdade — só o por-mensagem não é).
    const porWorkflow = [];
    for (const wfId of meusWorkflows) {
      const total = await st.getMessageAnalyticsForSource('Workflow', wfId, start, end)
        .then(d => d?.totals?.total ?? null)
        .catch(() => null);
      porWorkflow.push({
        workflow_id: wfId,
        nome: todosWorkflows?.find(w => w.workflow_id === wfId)?.name ?? '(nome não lido)',
        envios_no_periodo: total,
      });
    }

    const somaVinculada = porWorkflow.reduce((s, w) => s + (w.envios_no_periodo ?? 0), 0);
    const algumFalhou = porWorkflow.some(w => w.envios_no_periodo === null);
    const cobertura = totalMarca && totalMarca > 0 && !algumFalhou
      ? Math.round((somaVinculada / totalMarca) * 1000) / 10
      : null;

    // Fluxos ativos que não têm nenhuma mensagem nossa vinculada: são a explicação natural de
    // uma cobertura menor que 100%, e vale saber o nome deles antes de suspeitar de erro.
    const naoVinculados = (todosWorkflows ?? [])
      .filter(w => !meusWorkflows.includes(w.workflow_id))
      .map(w => ({ workflow_id: w.workflow_id, nome: w.name, status: w.status ?? null }));

    const mediaDiaria = somaVinculada > 0 ? Math.round(somaVinculada / dias) : null;
    resultado.push({
      conta: acc.label,
      brand_id: brand,
      painel: `https://app.slicktext.com/b${brand}/analytics/workflows`,
      envios_automacao_da_marca_no_periodo: totalMarca,
      envios_dos_workflows_vinculados: algumFalhou ? null : somaVinculada,
      cobertura_pct: cobertura,
      workflows_vinculados: porWorkflow,
      workflows_sem_vinculo: naoVinculados,
      creditos: usage ? {
        disponiveis: usage.credits_available,
        usados_vitalicio: usage.credits_used,
        // Alerta operacional, não estatística: fluxo ativo + saldo curto = automação para calada.
        dias_de_folga_estimados: mediaDiaria && mediaDiaria > 0
          ? Math.round((usage.credits_available / mediaDiaria) * 10) / 10
          : null,
        aviso: usage.credits_available < 5000
          ? 'SALDO BAIXO — os fluxos ativos param de enviar quando o crédito acabar, sem erro visível. Recarregar.'
          : null,
      } : null,
      observacao: algumFalhou
        ? 'Pelo menos um workflow não respondeu; a soma e a cobertura ficam em branco em vez de mostrar um número menor que a realidade.'
        : null,
    });
  }

  res.json({
    periodo: { de: start.slice(0, 10), ate: end.slice(0, 10), dias, ativo: period.isToday || !!(period.from && period.to) },
    como_ler: [
      'envios_automacao_da_marca_no_periodo é o MESMO número do gráfico "Workflow Messages Sent" do painel — é a contra-prova externa.',
      'cobertura_pct diz quanto desse total está em workflows que temos vinculados. Abaixo de 100% não é erro: workflows_sem_vinculo lista o resto.',
      'O painel NÃO quebra envios por mensagem — só por marca. Portanto o número por mensagem da tabela não tem contra-prova no painel, apenas esta checagem no agregado.',
      'Créditos: 1 envio quase nunca é 1 crédito (mensagem acima de 160 caracteres é cobrada por trecho).',
    ],
    contas: resultado,
  });
}));

// GET /admin/clientes/:id/diagnostico/sms - Reconciliação do SMS: o card "Faturamento SMS" e a
// tabela "Desempenho por Mensagem" usam filtros DIFERENTES, e por isso podem discordar sem aviso.
//   card:    utm_source/campaign/tracking ILIKE '%mailx%'  E  utm_medium ILIKE '%sms%'
//   tabela:  utm_source = 'mailx-sms'  E  utm_medium = 'auto-sms'  (igualdade exata, sensível a
//            maiúsculas)  E  utm_campaign NOT ILIKE '%teste%'
// Toda venda que passa no primeiro e falha no segundo é receita que aparece no total e não tem
// linha na tabela. Este endpoint quantifica a diferença e diz o MOTIVO de cada caso, pra decidir
// entre alinhar os filtros ou declarar a exclusão como intencional.
adminRouter.get('/clientes/:id/diagnostico/sms', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const period = resolvePeriodFilter(req);
  const params: (string | number)[] = [clientId];
  const periodSqlStr = periodSql(period, params);
  const FILTRO_TABELA = `utm_source = 'mailx-sms' AND utm_medium = 'auto-sms'
    AND utm_campaign IS NOT NULL AND utm_campaign NOT ILIKE '%teste%'`;

  const totais = await queryOne<Record<string, string>>(`
    SELECT
      COUNT(*) FILTER (WHERE ${SQL_MAILX_SMS}) AS card_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE ${SQL_MAILX_SMS}), 0) AS card_receita,
      COUNT(*) FILTER (WHERE ${FILTRO_TABELA}) AS tabela_vendas,
      COALESCE(SUM(total_price) FILTER (WHERE ${FILTRO_TABELA}), 0) AS tabela_receita,
      COUNT(*) FILTER (WHERE ${SQL_MAILX_SMS} AND NOT (${FILTRO_TABELA})) AS so_no_card,
      COALESCE(SUM(total_price) FILTER (WHERE ${SQL_MAILX_SMS} AND NOT (${FILTRO_TABELA})), 0) AS so_no_card_receita,
      COUNT(*) FILTER (WHERE ${FILTRO_TABELA} AND NOT (${SQL_MAILX_SMS})) AS so_na_tabela,
      COALESCE(SUM(total_price) FILTER (WHERE ${FILTRO_TABELA} AND NOT (${SQL_MAILX_SMS})), 0) AS so_na_tabela_receita
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing') AND client_id = $1
      ${periodSqlStr ? `AND ${periodSqlStr}` : ''}
  `, params);

  // Cada combinação que entra no card e não entra na tabela, com o motivo exato da exclusão.
  const divParams: (string | number)[] = [clientId];
  const divPeriod = periodSql(period, divParams);
  const divergentes = await query<{
    utm_source: string | null; utm_medium: string | null; utm_campaign: string | null;
    tracking_code: string | null; vendas: string; receita: string;
  }>(`
    SELECT utm_source, utm_medium, utm_campaign, tracking_code,
           COUNT(*) AS vendas, ${SQL_REVENUE} AS receita
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing') AND client_id = $1
      AND ${SQL_MAILX_SMS} AND NOT (${FILTRO_TABELA})
      ${divPeriod ? `AND ${divPeriod}` : ''}
    GROUP BY 1,2,3,4 ORDER BY COUNT(*) DESC LIMIT 40
  `, divParams);

  const motivo = (r: typeof divergentes[number]): string => {
    if (!r.utm_campaign) return 'utm_campaign vazia — a tabela agrupa por campanha, sem ela não há linha';
    if (/teste/i.test(r.utm_campaign)) return 'campanha com "teste" no nome — excluída da tabela de propósito';
    if (r.utm_source !== 'mailx-sms') {
      if ((r.utm_source ?? '').toLowerCase() === 'mailx-sms') return `utm_source com caixa diferente ("${r.utm_source}") — a tabela compara com = e não ignora maiúsculas`;
      if (!r.utm_source && r.tracking_code) return 'marcado por tracking_code (tid/subid), sem utm_source — a tabela só lê UTM';
      return `utm_source fora do padrão ("${r.utm_source ?? 'vazio'}") — esperado "mailx-sms"`;
    }
    if (r.utm_medium !== 'auto-sms') {
      if ((r.utm_medium ?? '').toLowerCase() === 'auto-sms') return `utm_medium com caixa diferente ("${r.utm_medium}")`;
      if ((r.utm_medium ?? '') !== (r.utm_medium ?? '').trim()) return `utm_medium com espaço sobrando ("${r.utm_medium}")`;
      return `utm_medium fora do padrão ("${r.utm_medium ?? 'vazio'}") — esperado "auto-sms" (disparo em massa? o padrão de UTM não define SMS de campanha)`;
    }
    return 'motivo não identificado — investigar';
  };

  const soNoCard = parseInt(totais?.so_no_card || '0');
  res.json({
    periodo: { ativo: period.isToday || !!(period.from && period.to), de: period.from ?? null, ate: period.to ?? null },
    card_faturamento_sms: { vendas: parseInt(totais?.card_vendas || '0'), receita: parseFloat(totais?.card_receita || '0') },
    tabela_por_mensagem: { vendas: parseInt(totais?.tabela_vendas || '0'), receita: parseFloat(totais?.tabela_receita || '0') },
    diferenca: {
      no_card_mas_fora_da_tabela: { vendas: soNoCard, receita: parseFloat(totais?.so_no_card_receita || '0') },
      na_tabela_mas_fora_do_card: { vendas: parseInt(totais?.so_na_tabela || '0'), receita: parseFloat(totais?.so_na_tabela_receita || '0') },
      veredito: soNoCard === 0
        ? 'Card e tabela batem: todo SMS atribuído tem linha na tabela.'
        : `${soNoCard} venda(s) entram no card e não têm linha na tabela — ver motivos abaixo.`,
    },
    divergentes: divergentes.map(r => ({
      utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign,
      vendas: parseInt(r.vendas), receita: parseFloat(r.receita), motivo: motivo(r),
    })),
  });
}));

// GET /admin/clientes/:id/diagnostico/utms - Inventário das UTMs que chegam nas vendas do cliente,
// com a classificação que o dashboard aplica a cada combinação. Responde a pergunta que aparece
// sempre que um canal mostra zero: "não vendeu por esse canal" ou "vendeu e a atribuição não pegou?".
// Uma venda só é atribuída à MailX se utm_source OU utm_campaign contiver 'mailx'; o canal é SMS
// quando utm_medium contém 'sms'. Qualquer combinação com cara de email fora dessa regra aparece
// aqui como NAO_ATRIBUIDA e é dinheiro que o dashboard não está creditando a ninguém.
adminRouter.get('/clientes/:id/diagnostico/utms', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const period = resolvePeriodFilter(req);
  const params: (string | number)[] = [clientId];
  const periodSqlStr = periodSql(period, params);

  const rows = await query<{
    utm_source: string | null; utm_medium: string | null; utm_campaign: string | null;
    vendas: string; receita: string; e_mailx: boolean; e_sms: boolean;
  }>(`
    SELECT
      utm_source, utm_medium,
      -- agrupa por prefixo da campanha pra não explodir em milhares de linhas por variação
      NULLIF(SPLIT_PART(COALESCE(utm_campaign, ''), '-', 1), '') AS utm_campaign,
      COUNT(*) AS vendas,
      ${SQL_REVENUE} AS receita,
      ${SQL_IS_MAILX} AS e_mailx,
      ${SQL_IS_SMS} AS e_sms
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing') AND client_id = $1
      ${periodSqlStr ? `AND ${periodSqlStr}` : ''}
    GROUP BY utm_source, utm_medium, 3, e_mailx, e_sms
    ORDER BY COUNT(*) DESC
    LIMIT 60
  `, params);

  const classificar = (r: typeof rows[number]) =>
    !r.e_mailx ? 'NAO_ATRIBUIDA' : (r.e_sms ? 'SMS' : 'EMAIL');

  const linhas = rows.map(r => ({
    utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign_prefixo: r.utm_campaign,
    vendas: parseInt(r.vendas), receita: parseFloat(r.receita),
    classificacao: classificar(r),
    // Marca tráfego que PARECE da MailX mas não está sendo atribuído. Os padrões precisam ser
    // específicos: uma primeira versão usava o token 'ac' e casava com "Taboola_Acc-015",
    // marcando ~$89 mil de mídia paga como email perdido. Agora exige palavra inteira ou nome de
    // ferramenta de email, e trata SMS separadamente (foi assim que 'smsbrdcst' apareceu).
    suspeita_email_perdido: classificar(r) === 'NAO_ATRIBUIDA'
      && /(^|[^a-z])(e-?mails?|activecampaign|newsletter|klaviyo|mailchimp|sendgrid|broadcast)([^a-z]|$)/i
        .test(`${r.utm_source ?? ''} ${r.utm_medium ?? ''} ${r.utm_campaign ?? ''}`),
    suspeita_sms_perdido: classificar(r) === 'NAO_ATRIBUIDA'
      && /(^|[^a-z])(sms|smsbrdcst|slicktext|shorturl|slk1)([^a-z]|$)/i
        .test(`${r.utm_source ?? ''} ${r.utm_medium ?? ''} ${r.utm_campaign ?? ''}`),
    // Venda sem UTM nenhuma: nem MailX nem mídia paga — direto/orgânico ou link sem marcação.
    sem_utm: !r.utm_source && !r.utm_medium && !r.utm_campaign,
  }));

  const soma = (f: (l: typeof linhas[number]) => boolean) => {
    const sel = linhas.filter(f);
    return { vendas: sel.reduce((a, l) => a + l.vendas, 0), receita: Number(sel.reduce((a, l) => a + l.receita, 0).toFixed(2)) };
  };

  // Prova de onde está o problema quando um canal mostra zero. Precisa ser exata pra não
  // afirmar o que não sabe: conta vendas de email ATRIBUÍDAS À MAILX em OUTROS clientes (é isso
  // que prova o caminho ponta a ponta) e, separado, qualquer medium com cara de email em
  // qualquer cliente — inclusive este — mostrando quais são, pra não confundir ruído com prova.
  const emailOutrosClientes = await queryOne<{ vendas: string; clientes: string }>(`
    SELECT COUNT(*) AS vendas, COUNT(DISTINCT client_id) AS clientes
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing')
      AND client_id IS DISTINCT FROM $1
      AND ${SQL_MAILX_EMAIL}
  `, [clientId]);

  const mediumsComCaraDeEmail = await query<{ utm_medium: string | null; vendas: string; deste_cliente: string }>(`
    SELECT utm_medium, COUNT(*) AS vendas,
           COUNT(*) FILTER (WHERE client_id IS NOT DISTINCT FROM $1) AS deste_cliente
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing')
      AND COALESCE(utm_medium, '') ILIKE '%email%'
    GROUP BY utm_medium ORDER BY COUNT(*) DESC LIMIT 10
  `, [clientId]);

  const mediumsNoSistema = await query<{ utm_medium: string | null; vendas: string; clientes: string }>(`
    SELECT utm_medium, COUNT(*) AS vendas, COUNT(DISTINCT client_id) AS clientes
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status IN ('processed','processing')
      AND utm_medium IS NOT NULL
    GROUP BY utm_medium ORDER BY COUNT(*) DESC LIMIT 30
  `);

  res.json({
    periodo: { ativo: period.isToday || !!(period.from && period.to), de: period.from ?? null, ate: period.to ?? null },
    resumo: {
      EMAIL: soma(l => l.classificacao === 'EMAIL'),
      SMS: soma(l => l.classificacao === 'SMS'),
      NAO_ATRIBUIDA: soma(l => l.classificacao === 'NAO_ATRIBUIDA'),
      // Dentro do não atribuído, separa o que é ruído esperado do que merece investigação:
      sem_utm_nenhuma: soma(l => l.sem_utm),
      suspeitas_de_email_perdido: soma(l => l.suspeita_email_perdido),
      suspeitas_de_sms_perdido: soma(l => l.suspeita_sms_perdido),
    },
    // Maiores fontes não atribuídas, pra olho humano julgar o que é mídia paga do cliente e o
    // que pode ser MailX sem marcação — mais confiável que qualquer heurística.
    top_nao_atribuidas: linhas
      .filter(l => l.classificacao === 'NAO_ATRIBUIDA' && !l.sem_utm)
      .slice(0, 15)
      .map(l => ({ utm_source: l.utm_source, utm_medium: l.utm_medium, vendas: l.vendas, receita: l.receita })),
    combinacoes: linhas,
    // Diagnóstico de causa. Só afirma o que os números sustentam.
    email_no_sistema_inteiro: (() => {
      const outros = parseInt(emailOutrosClientes?.vendas || '0');
      const clientesOutros = parseInt(emailOutrosClientes?.clientes || '0');
      return {
        vendas_de_email_mailx_em_outros_clientes: outros,
        outros_clientes_com_venda_de_email: clientesOutros,
        mediums_com_cara_de_email_no_sistema: mediumsComCaraDeEmail.map(r => ({
          utm_medium: r.utm_medium, vendas: parseInt(r.vendas), deste_cliente: parseInt(r.deste_cliente),
        })),
        veredito: outros > 0
          ? `O caminho está provado: ${outros} venda(s) de email atribuídas à MailX em ${clientesOutros} outro(s) cliente(s). A leitura funciona — o problema é a marcação dos links DESTE cliente.`
          : 'Nenhuma venda de email atribuída à MailX em nenhum cliente. Como o SMS chega atribuído pelo mesmo caminho, a leitura não é o gargalo: os links de email não estão carregando UTM. Ainda assim, sem um caso funcionando em outro cliente, isso é inferência forte e não prova — confirme abrindo o link de uma campanha no ActiveCampaign.',
      };
    })(),
    todos_os_mediums_do_sistema: mediumsNoSistema.map(r => ({
      utm_medium: r.utm_medium, vendas: parseInt(r.vendas), clientes: parseInt(r.clientes),
    })),
  });
}));

// GET /admin/clientes/:id/diagnostico/vinculos - Saúde do cadastro de um cliente, nos DOIS canais:
// para cada produto, se está ativado, se tem lista da SlickText vinculada (SMS) e se tem tag do
// ActiveCampaign vinculada (Email) — mais o retrato de cada conta configurada (quantas tags tem,
// quantas são de compra vs abandono, e em qual conta cada tag de produto vive).
// É o que distingue as três causas possíveis quando um número aparece zerado ou com aviso:
// produto nunca ativado, vínculo faltando, ou credencial apontando para a conta errada.
adminRouter.get('/clientes/:id/diagnostico/vinculos', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;

  const kits = await query<{
    id: number; name: string; enabled: boolean; external_id: string | null;
    st_list_compra_id: string | null; st_list_compra_id_2: string | null;
    st_list_abandono_id: string | null; st_list_abandono_id_2: string | null;
    ac_tag_compra_id: string | null; ac_tag_abandono_id: string | null;
  }>(`SELECT id, name, enabled, external_id, st_list_compra_id, st_list_compra_id_2,
             st_list_abandono_id, st_list_abandono_id_2, ac_tag_compra_id, ac_tag_abandono_id
      FROM kits WHERE client_id = $1 ORDER BY enabled DESC, name`, [clientId]);

  // Nomes reais das listas da conta e das tags do AC — pra distinguir "não existe" de
  // "existe mas o nome não casa com o do produto" (esse segundo caso é religável por código).
  const accounts = await getSlickTextAccounts(clientId);
  const stListNames: string[] = [];
  for (const acc of accounts) {
    try {
      const lists = await new SlickTextClient(acc.st_api_token, acc.st_brand_id).getLists();
      lists.forEach((l: any) => l?.name && stListNames.push(String(l.name)));
    } catch { /* conta indisponível */ }
  }

  // Varre TODAS as contas de ActiveCampaign do cliente. O objetivo é ver a divisão real: qual
  // conta tem quais tags, pra saber se uma cuida de compra aprovada e outra de abandono.
  const acAccounts = await getActiveCampaignAccounts(clientId);
  const contasAc: any[] = [];
  for (const acc of acAccounts) {
    const ac = new ActiveCampaignClient(acc.ac_api_url, acc.ac_api_key);
    const acHttp = (ac as any).http;
    try {
      const [tagsRes, listsRes] = await Promise.all([
        acHttp.get('/tags', { params: { limit: 100 } }),
        acHttp.get('/lists', { params: { limit: 100 } }),
      ]);
      const nomesTags: string[] = (tagsRes.data?.tags ?? []).map((t: any) => t.tag);
      contasAc.push({
        conta: acc.label,
        url: acc.ac_api_url,
        chave: `...${acc.ac_api_key.slice(-6)}`,
        tags_total: tagsRes.data?.meta?.total ?? nomesTags.length,
        // Quantas tags parecem de compra vs de abandono — é o que revela a divisão entre contas.
        tags_com_compra: nomesTags.filter(n => /compra|purchase|buy|aprovad/i.test(n)).length,
        tags_com_abandono: nomesTags.filter(n => /abandon|cart/i.test(n)).length,
        tags_amostra: nomesTags.slice(0, 40),
        listas: (listsRes.data?.lists ?? []).map((l: any) => l.name).slice(0, 30),
      });
    } catch (err: any) {
      contasAc.push({ conta: acc.label, url: acc.ac_api_url, erro: err.message });
    }
  }

  // Para cada produto ativado, procura as tags esperadas em CADA conta — mostra em qual delas
  // cada tag vive (ou se não existe em nenhuma).
  const acTagCheck: any[] = [];
  for (const k of kits.filter(k => k.enabled)) {
    const achados: any = { produto: k.name, compra_em: [], abandono_em: [] };
    // Casa por FAMÍLIA com comparação normalizada — mesma regra do auto-vínculo real. A busca
    // anterior era por nome de SKU e com o sufixo das listas da SlickText ("Abandono de Carrinho"),
    // e por isso não achava nada mesmo com as tags existindo.
    const kitKey = k.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const acc of acAccounts) {
      const ac = new ActiveCampaignClient(acc.ac_api_url, acc.ac_api_key);
      const tags = await ac.listTags().catch(() => [] as Array<{ id: string; tag: string }>);
      for (const t of tags) {
        const m = t.tag.match(/^\[(.+?)\]\s*(compra aprovada|abandono)\s*$/i);
        if (!m) continue;
        const fam = m[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!fam || !kitKey.includes(fam)) continue;
        (/compra/i.test(m[2]) ? achados.compra_em : achados.abandono_em).push({ conta: acc.label, tag: t.tag, id: t.id });
      }
    }
    acTagCheck.push(achados);
  }

  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rows = kits.map(k => ({
    produto: k.name,
    ativado: k.enabled,
    origem: k.external_id ? 'descoberto automaticamente' : 'cadastrado à mão',
    st_lista_compra: !!k.st_list_compra_id,
    st_lista_compra_2: !!k.st_list_compra_id_2,
    st_lista_abandono: !!k.st_list_abandono_id,
    st_lista_abandono_2: !!k.st_list_abandono_id_2,
    ac_tag_compra: !!k.ac_tag_compra_id,
    ac_tag_abandono: !!k.ac_tag_abandono_id,
    // Listas da conta cujo nome de produto aparece no nome do kit, ignorando espaço/hífen/caixa —
    // é assim que o vínculo casa (substring). Vazio num kit ativado = nome não bate nem aproximado.
    listas_candidatas: stListNames.filter(n => {
      const m = n.match(/^\[(.+?)\]/);
      return m ? norm(k.name).includes(norm(m[1])) : false;
    }),
  }));

  const semLista = rows.filter(r => !r.st_lista_abandono || !r.st_lista_compra);
  res.json({
    resumo: {
      kits_total: rows.length,
      ativados: rows.filter(r => r.ativado).length,
      nao_ativados: rows.filter(r => !r.ativado).length,
      sem_lista_total: semLista.length,
      sem_lista_MAS_ativados: semLista.filter(r => r.ativado).length,
      sem_lista_e_nao_ativados: semLista.filter(r => !r.ativado).length,
      sem_tag_ac_mas_ativados: rows.filter(r => r.ativado && (!r.ac_tag_compra || !r.ac_tag_abandono)).length,
      // Kit ativado, sem lista, MAS existe lista candidata se ignorarmos espaço/hífen/caixa:
      // esses são religáveis por código (só normalizar a comparação), sem criar nada na SlickText.
      religavel_normalizando: rows.filter(r => r.ativado
        && (!r.st_lista_compra || !r.st_lista_abandono)
        && r.listas_candidatas.length > 0).length,
      listas_lidas_da_conta: stListNames.length,
    },
    contas_ac: contasAc,
    tags_ac: acTagCheck,
    listas_da_conta: stListNames,
    kits: rows,
  });
}));

// GET /admin/clientes/:id/sms-campaigns - Lista campanhas E workflows de TODAS as contas
// SlickText do cliente (id + nome) pra preencher o dropdown de "Vincular" — evita ter que caçar
// o ID manualmente no painel da SlickText. Um cliente pode ter mais de uma conta rodando o mesmo
// produto em paralelo (ver getSlickTextAccounts) — cada item vem marcado com accountId/accountLabel
// pra saber qual conta usar depois.
adminRouter.get('/clientes/:id/sms-campaigns', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const accounts = await getSlickTextAccounts(clientId);
  if (accounts.length === 0) {
    res.json({ configured: false, campaigns: [], workflows: [] });
    return;
  }

  const campaigns: any[] = [];
  const workflows: any[] = [];
  const errors: string[] = [];

  await Promise.all(accounts.map(async (acc) => {
    const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
    const [campaignsResult, workflowsResult] = await Promise.allSettled([st.getCampaigns(), st.getWorkflows()]);
    if (campaignsResult.status === 'fulfilled') {
      campaigns.push(...campaignsResult.value.map(c => ({ ...c, accountId: acc.accountId, accountLabel: acc.label })));
    } else {
      logger.error(CTX, `Falha ao listar campanhas da SlickText (client ${clientId}, conta ${acc.label}): ${campaignsResult.reason?.message}`);
      errors.push(`campanhas (${acc.label}): ${campaignsResult.reason?.message}`);
    }
    if (workflowsResult.status === 'fulfilled') {
      workflows.push(...workflowsResult.value.map(w => ({ ...w, accountId: acc.accountId, accountLabel: acc.label })));
    } else {
      logger.error(CTX, `Falha ao listar workflows da SlickText (client ${clientId}, conta ${acc.label}): ${workflowsResult.reason?.message}`);
      errors.push(`workflows (${acc.label}): ${workflowsResult.reason?.message}`);
    }
  }));

  res.json({ configured: true, campaigns, workflows, multiAccount: accounts.length > 1, error: errors.length ? errors.join('; ') : undefined });
}));

/**
 * Resolve o período da request (mesma lógica de resolvePeriodFilter/"Hoje" via CURRENT_DATE)
 * pro formato de data que a API de analytics da SlickText espera: "YYYY-MM-DD HH:mm:ss".
 * Sem período ativo (lifetime), usa uma janela bem larga — a SlickText exige start/end.
 */
async function resolveSlickTextDateRange(req: Request): Promise<{ start: string; end: string }> {
  const period = resolvePeriodFilter(req);
  if (period.isToday) {
    const todayRow = await queryOne<{ today: string }>(`SELECT CURRENT_DATE::text as today`);
    const today = todayRow?.today || new Date().toISOString().slice(0, 10);
    return { start: `${today} 00:00:00`, end: `${today} 23:59:59` };
  }
  if (period.from && period.to) {
    return { start: `${period.from} 00:00:00`, end: `${period.to} 23:59:59` };
  }
  return { start: '2000-01-01 00:00:00', end: '2100-01-01 00:00:00' };
}

// GET /admin/clientes/:id/sms-campaign-sends - Conta envios/cliques reais de uma mensagem de
// automação no período selecionado, via analytics da SlickText — CONFIRMADO contra a API real
// (capturado inspecionando o Network da própria tela de Analytics da SlickText):
//   - workflow_node_id vinculado: GET /analytics/workflows/{workflow_id}/nodes/{node_id} — só
//     essa mensagem específica dentro do workflow (resolve o caso de várias mensagens
//     sequenciais compartilhando o mesmo workflow, ex: MS0001A/02A/03A).
//   - sem workflow_node_id (source_type=Workflow): GET /analytics/workflows?_workflow_id=X —
//     total do workflow inteiro (pode somar mais de uma mensagem, se houver).
//   - source_type=Campaign: mantém a contagem antiga via paginação de /messages (a API não tem
//     um endpoint de analytics equivalente confirmado pra Campaign avulsa ainda).
adminRouter.get('/clientes/:id/sms-campaign-sends', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const utmCampaign = req.query.utm_campaign as string | undefined;

  if (!utmCampaign) {
    res.status(400).json({ error: 'utm_campaign é obrigatório' });
    return;
  }

  const mapping = await queryOne<{ slicktext_campaign_id: number | null; source_type: string; workflow_node_id: number | null; st_account_id: number | null }>(
    `SELECT slicktext_campaign_id, source_type, workflow_node_id, st_account_id FROM sms_campaign_map WHERE client_id = $1 AND utm_campaign = $2`,
    [clientId, utmCampaign]
  );

  if (!mapping) {
    res.json({ linked: false, count: null, message: 'Sem campaign/workflow_id da SlickText vinculado a esta mensagem ainda.' });
    return;
  }

  const account = await getSlickTextAccountById(clientId, mapping.st_account_id);
  if (!account) {
    res.json({ linked: true, count: null, message: 'SlickText não configurado para esta conta.' });
    return;
  }

  const st = new SlickTextClient(account.st_api_token, account.st_brand_id);

  // Links MANUAIS (caso N8N, confirmado via dump + probes em produção): a mensagem usa links
  // criados direto no encurtador (source='manual'), sem workflow/node associado. O que a API
  // oferece pra eles (probes v1/v2 esgotaram os caminhos):
  //   - CLIQUES: só o total VITALÍCIO, nos campos clicks/unique_clicks/bot_clicks do próprio
  //     registro do link (GET /links/{id}) — os mesmos All/Unique/Bot do painel. NÃO existe
  //     filtro de período: /analytics/links/clicks ignora links manuais (groups nunca os
  //     incluem, em nenhum período) e /links/{id}/clicks|stats|analytics são 404.
  //   - ENVIOS por mensagem: NÃO EXISTEM (nenhum source pra filtrar em /messages).
  // Regra de clareza: cliques vitalícios ROTULADOS, envios estampados como indisponíveis —
  // nunca mascarado com zero ou com número de outra janela sem aviso.
  if (mapping.source_type === 'ManualLink') {
    try {
      const allLinks = await st.getAllLinks();
      const myLinks = allLinks.filter((l: any) =>
        l?.source === 'manual' && extractUtmCampaignFromUrl(l?.url) === utmCampaign && Number.isInteger(l?.link_id)
      );
      if (myLinks.length === 0) {
        res.json({
          linked: true, sourceType: 'ManualLink', scope: 'manual-links', count: null,
          message: 'Nenhum link manual com esse utm_campaign encontrado na conta SlickText vinculada.',
        });
        return;
      }
      const sum = (field: string) => myLinks.reduce((s: number, l: any) => s + (typeof l?.[field] === 'number' ? l[field] : 0), 0);
      res.json({
        linked: true,
        sourceType: 'ManualLink',
        scope: 'manual-links',
        lifetime: false,
        // Envios por mensagem não existem pra link manual — count null + flag explícita pro
        // frontend estampar o motivo (clareza de dados: indisponível ≠ zero).
        count: null,
        sendsUnavailable: true,
        message: 'Mensagem disparada com links manuais do encurtador (fora de workflow) — a API da SlickText não expõe envios por mensagem nem cliques por período nesse caso. Cliques mostrados são o total desde a criação dos links (vitalício).',
        clicks: null,
        clicksIsPeriod: false,
        clicksFieldFound: false,
        lifetimeClicks: sum('clicks'),
        lifetimeBotClicks: sum('bot_clicks'),
        linkCount: myLinks.length,
        capped: false,
        pages: 1,
      });
    } catch (err: any) {
      logger.error(CTX, `Falha ao consultar cliques de links manuais (utm ${utmCampaign}, client ${clientId}): ${err.message}`);
      res.json({ linked: true, count: null, message: `Erro ao consultar SlickText: ${err.message}` });
    }
    return;
  }

  // Daqui pra baixo o vínculo é Workflow/Campaign — exige o ID da SlickText (só linhas
  // ManualLink têm slicktext_campaign_id NULL; um NULL aqui é registro incompleto).
  if (mapping.slicktext_campaign_id == null) {
    res.json({ linked: true, count: null, message: 'Vínculo sem workflow/campaign da SlickText (registro incompleto) — revincule esta mensagem.' });
    return;
  }
  const sourceId = mapping.slicktext_campaign_id;
  const sourceType = mapping.source_type === 'Workflow' ? 'Workflow' : 'Campaign';

  try {
    if (sourceType === 'Workflow') {
      const { start, end } = await resolveSlickTextDateRange(req);
      // Realidade da API (confirmada via probes/capturas em produção):
      // - ENVIOS por mensagem (node): só total vitalício — o endpoint de node ignora start/end
      //   e o filtro _sub_source_id em /analytics/messages é ignorado.
      // - ENVIOS por workflow: filtrados por período via /analytics/messages. ✔
      // - CLIQUES por link: filtrados por período via /analytics/links/clicks?group=_link_id ✔
      //   — e como cada link carrega o utm_campaign na URL, cliques por MENSAGEM no período
      //   saem somando os links daquele utm. Cada número abaixo é rotulado como o que é.
      const workflowId = sourceId;
      const [workflowPeriodCount, clicksGrouped, allLinks] = await Promise.all([
        st.getMessageAnalyticsForSource('Workflow', workflowId, start, end)
          .then(d => d?.totals?.total ?? null).catch(() => null),
        st.getLinkClicksGrouped(workflowId, start, end).catch(() => null),
        st.getLinks({ source: 'Workflow', _source_id: workflowId }).catch(() => null),
      ]);

      if (mapping.workflow_node_id) {
        // Uma falha aqui NÃO pode apagar a linha: essa chamada só traz o total vitalício e uma
        // estimativa que acelera a contagem por período — a contagem em si é independente. Antes,
        // sem proteção, qualquer instabilidade caía no catch geral e a mensagem inteira aparecia
        // como 'indisponível' (aconteceu em produção com a mensagem de maior receita da Conta 30,
        // e voltou ao normal só com um recarregar). Duas tentativas e segue sem a estimativa.
        let data: any = null;
        for (let tentativa = 1; tentativa <= 2 && data === null; tentativa++) {
          try {
            data = await st.getWorkflowNodeAnalytics(workflowId, mapping.workflow_node_id, start, end);
          } catch (err: any) {
            logger.warn(CTX, `getWorkflowNodeAnalytics falhou (node ${mapping.workflow_node_id}, tentativa ${tentativa}/2): ${err.message}`);
            if (tentativa === 1) await new Promise(r => setTimeout(r, 1200));
          }
        }
        const t = data?.totals || {};

        // Cliques do PERÍODO desta mensagem: soma os groups de cliques cujos nomes batem com
        // os links deste utm. Link achado mas sem group no período = 0 cliques de verdade;
        // nenhum link com esse utm (ou chamadas falharam) = null (indisponível, não zero).
        let clicksPeriod: number | null = null;
        if (Array.isArray(allLinks) && clicksGrouped) {
          const myLinkNames = new Set(
            allLinks
              .filter((l: any) => extractUtmCampaignFromUrl(l?.url) === utmCampaign)
              .map((l: any) => l?.name)
              .filter(Boolean)
          );
          if (myLinkNames.size > 0) {
            const groups = Array.isArray(clicksGrouped?.groups) ? clicksGrouped.groups : [];
            clicksPeriod = groups
              .filter((g: any) => myLinkNames.has(g?.name))
              .reduce((s: number, g: any) => s + (g?.total || 0), 0);
          }
        }

        // ENVIOS do PERÍODO desta mensagem: contagem paginada do /messages cru (o filtro
        // _sub_source_id funciona lá, e cada item tem `created` — confirmado via probe).
        // Só quando há período ativo; sem período, o vitalício do node analytics já é exato.
        const period = resolvePeriodFilter(req);
        const periodActive = period.isToday || !!(period.from && period.to);
        let periodCount: number | null = null;
        let periodCredits: number | null = null;
        let periodCapped = false;
        if (periodActive) {
          // Retry antes do fallback vitalício — achado da auditoria: uma falha transitória
          // (rate limit sob carga) fazia a linha cair pro total vitalício rotulado; uma
          // segunda tentativa costuma resolver.
          for (let attempt = 1; attempt <= 2 && periodCount === null; attempt++) {
            try {
              const counted = await st.countWorkflowNodeMessages(
                workflowId, mapping.workflow_node_id, start.slice(0, 10), end.slice(0, 10),
                { approxTotal: typeof t.messages === 'number' ? t.messages : undefined }
              );
              periodCount = counted.count;
              periodCredits = counted.credits;
              periodCapped = counted.capped;
            } catch (err: any) {
              logger.warn(CTX, `countWorkflowNodeMessages falhou (node ${mapping.workflow_node_id}, tentativa ${attempt}/2): ${err.message}`);
              if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
            }
          }
        }

        res.json({
          linked: true,
          sourceType,
          scope: 'node',
          // Com período ativo e contagem ok: count é DO PERÍODO. Fallback: vitalício rotulado.
          lifetime: !(periodActive && periodCount !== null),
          // Achado da auditoria: quando a contagem por período falha (mesmo após retry) e
          // caímos no vitalício, o frontend precisa ESTAMPAR que foi falha — não deixar o
          // número passar por um dado qualquer com rótulo discreto.
          periodFallback: periodActive && periodCount === null,
          // Sem período ativo e sem o vitalício (chamada falhou), count fica null e a linha diz
          // 'indisponível' com o motivo — melhor que exibir 0 como se não houvesse envio.
          count: periodActive && periodCount !== null ? periodCount : (t.messages ?? null),
          periodCredits,
          clicks: clicksPeriod, // cliques DO PERÍODO (via links) — null quando indisponível
          clicksIsPeriod: clicksPeriod !== null,
          lifetimeClicks: t.clicks ?? null,
          nodeAnalyticsFalhou: data === null,
          clicksFieldFound: clicksPeriod !== null,
          capped: periodCapped,
          pages: 1,
          nodeName: data?.workflow_node?.name,
          message: data === null
            ? 'A SlickText não respondeu o resumo desta mensagem (instabilidade). Os envios do período podem ainda aparecer; clique em tentar de novo para recarregar.'
            : undefined,
          workflowId,
          workflowPeriodCount, // envios do WORKFLOW inteiro no período (esse sim filtrado)
        });
      } else {
        const byId = await st.getWorkflowAnalyticsById(workflowId).catch(() => null);
        const clicksPeriod = clicksGrouped?.totals?.total ?? null;
        res.json({
          linked: true,
          sourceType,
          scope: 'workflow',
          lifetime: false, // count e clicks são do período (workflow inteiro)
          count: workflowPeriodCount ?? 0,
          clicks: clicksPeriod,
          clicksIsPeriod: clicksPeriod !== null,
          clicksFieldFound: clicksPeriod !== null,
          capped: false,
          pages: 1,
          workflowName: byId?.workflow?.name,
          workflowId,
          workflowPeriodCount,
        });
      }
    } else {
      const result = await st.countCampaignMessages(mapping.slicktext_campaign_id, { sourceType });
      res.json({ linked: true, sourceType, scope: 'campaign-pagination', ...result });
    }
  } catch (err: any) {
    logger.error(CTX, `Falha ao contar envios de ${mapping.source_type}${mapping.workflow_node_id ? `/node ${mapping.workflow_node_id}` : ''} ${mapping.slicktext_campaign_id} (client ${clientId}): ${err.message}`);
    res.json({ linked: true, count: null, message: `Erro ao consultar SlickText: ${err.message}` });
  }
}));

// ── Kit Management (Post-Setup) ──

// POST /admin/clientes/:id/kits - Add new kit to existing client
adminRouter.post('/clientes/:id/kits', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const { name, price } = req.body;

  if (!name) {
    res.status(400).json({ error: 'Kit name is required' });
    return;
  }

  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  await query(
    `INSERT INTO kits (client_id, name, slug, price) VALUES ($1, $2, $3, $4)`,
    [clientId, name, slug, price || null]
  );

  logger.info(CTX, `Kit "${name}" added to client ${clientId}`);
  res.json({ ok: true, slug });
}));

// DELETE /admin/kits/:id - Remove a kit
adminRouter.delete('/kits/:id', asyncHandler(async (req: Request, res: Response) => {
  await query(`DELETE FROM kits WHERE id = $1`, [req.params.id]);
  logger.info(CTX, `Kit ${req.params.id} deleted`);
  res.json({ ok: true });
}));

// PATCH /admin/clientes/:id/kits/:kitId - Enable/disable a product (runs kit bootstrap when enabling)
adminRouter.patch('/clientes/:id/kits/:kitId', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const kitId = parseInt(req.params.kitId as string);
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }

  if (enabled) {
    // Run mini-bootstrap first — creates AC tags for this product
    const result = await runKitBootstrap(clientId, kitId);
    if (!result.success) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    // Only mark enabled after successful bootstrap
    await query(`UPDATE kits SET enabled = true WHERE id = $1 AND client_id = $2`, [kitId, clientId]);
    logger.info(CTX, `Kit #${kitId} enabled for client #${clientId}`);
    res.json({ ok: true, bootstrap: result });
  } else {
    await query(`UPDATE kits SET enabled = false WHERE id = $1 AND client_id = $2`, [kitId, clientId]);
    logger.info(CTX, `Kit #${kitId} disabled for client #${clientId}`);
    res.json({ ok: true });
  }
}));

// ── Per-Client Store Management ──

// GET /admin/clientes/:id/stores - List stores for a client
adminRouter.get('/clientes/:id/stores', asyncHandler(async (req: Request, res: Response) => {
  const stores = await query(
    `SELECT * FROM store_integrations WHERE client_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({ stores });
}));

// POST /admin/clientes/:id/stores - Add store to a client
adminRouter.post('/clientes/:id/stores', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  let { shop_slug, api_token, events, platform, display_name } = req.body;

  if (!shop_slug || !api_token) {
    res.status(400).json({ error: 'shop_slug and api_token are required' });
    return;
  }

  // Normalize slug: "https://gox.mycartpanda.com/" → "gox"
  let normalizedSlug = shop_slug.trim().replace(/\/+$/, '');
  const urlMatch = normalizedSlug.match(/^https?:\/\/([^.]+)\.(my)?cartpanda\.com/i);
  if (urlMatch) normalizedSlug = urlMatch[1];
  normalizedSlug = normalizedSlug.replace(/^https?:\/\//, '').replace(/\..*$/, '');

  const storePlatform = platform || 'cartpanda';

  await query(
    `INSERT INTO store_integrations (client_id, platform, shop_slug, api_token, events, status, display_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [clientId, storePlatform, normalizedSlug, api_token, JSON.stringify(events || {}), 'pending', display_name || null]
  );

  logger.info(CTX, `Store "${normalizedSlug}" (${storePlatform}) integrated for client ${clientId}`);

  // Auto-register webhooks on CartPanda
  let webhookResult = null;
  if (storePlatform === 'cartpanda') {
    try {
      const callbackBase = `https://${env.API_DOMAIN}`;
      const cp = new CartPandaClient(shop_slug, api_token);
      webhookResult = await cp.registerWebhooks(callbackBase);

      // Update store status to active if webhooks were registered successfully
      if (webhookResult.errors.length === 0) {
        await query(
          `UPDATE store_integrations SET status = 'active' WHERE client_id = $1 AND shop_slug = $2`,
          [clientId, shop_slug]
        );
      }
    } catch (err: any) {
      logger.warn(CTX, `Auto-register webhooks failed for ${shop_slug}: ${err.message}`);
      webhookResult = { created: [], skipped: [], errors: [{ endpoint: 'all', error: err.message }] };
    }
  }

  res.json({ ok: true, shop_slug, platform: storePlatform, webhooks: webhookResult });
}));

// POST /admin/clientes/:id/register-webhooks - Manually register webhooks on CartPanda
adminRouter.post('/clientes/:id/register-webhooks', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);

  // Find CartPanda stores for this client
  const stores = await query<{ id: number; shop_slug: string; api_token: string; platform: string }>(
    `SELECT id, shop_slug, api_token, platform FROM store_integrations WHERE client_id = $1 AND platform = 'cartpanda'`,
    [clientId]
  );

  if (!stores || stores.length === 0) {
    res.status(404).json({ ok: false, error: 'Nenhuma loja CartPanda encontrada para este cliente' });
    return;
  }

  const callbackBase = `https://${env.API_DOMAIN}`;
  const results: Array<{ slug: string; result: any }> = [];

  for (const store of stores) {
    try {
      const cp = new CartPandaClient(store.shop_slug, store.api_token);
      const result = await cp.registerWebhooks(callbackBase);
      results.push({ slug: store.shop_slug, result });

      // Update store status
      if (result.errors.length === 0) {
        await query(
          `UPDATE store_integrations SET status = 'active' WHERE id = $1`,
          [store.id]
        );
      }
    } catch (err: any) {
      results.push({
        slug: store.shop_slug,
        result: { created: [], skipped: [], errors: [{ endpoint: 'all', error: err.message }] },
      });
    }
  }

  const totalCreated = results.reduce((sum, r) => sum + r.result.created.length, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.result.errors.length, 0);

  logger.info(CTX, `Webhook registration for client #${clientId}: ${totalCreated} created, ${totalErrors} errors`);
  res.json({ ok: totalErrors === 0, results, summary: { created: totalCreated, errors: totalErrors } });
}));

// DELETE /admin/stores/:id - Remove a store integration
adminRouter.delete('/stores/:id', asyncHandler(async (req: Request, res: Response) => {
  await query(`DELETE FROM store_integrations WHERE id = $1`, [req.params.id]);
  logger.info(CTX, `Store ${req.params.id} deleted`);
  res.json({ ok: true });
}));

// DELETE /admin/clientes/:id - Remove client
adminRouter.delete('/clientes/:id', asyncHandler(async (req: Request, res: Response) => {
  await query(`DELETE FROM clients WHERE id = $1`, [req.params.id]);
  logger.info(CTX, `Client ${req.params.id} deleted`);
  res.json({ ok: true });
}));

// GET /admin/webhooks - List logs
adminRouter.get('/webhooks', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const logs = await query(
    `SELECT * FROM webhook_logs ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ count: logs.length, logs });
}));

// ── SlickText SMS Stats ──

// GET /admin/clientes/:id/sms-stats - Fetch SMS metrics from SlickText API
adminRouter.get('/clientes/:id/sms-stats', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const currency = await resolveClientCurrency(clientId);
  const symbol = currencySymbol(currency);

  // Um cliente pode ter mais de uma conta SlickText rodando em paralelo pro mesmo produto
  // (confirmado com o Murilo) — soma contatos/créditos/listas de todas.
  const accounts = await getSlickTextAccounts(clientId);

  if (accounts.length === 0) {
    res.json({
      configured: false,
      currency,
      error: 'SlickText not configured for this client',
    });
    return;
  }

  try {
    const stClients = accounts.map(acc => new SlickTextClient(acc.st_api_token, acc.st_brand_id));

    // Fetch all data em paralelo, pra cada conta, e soma
    const perAccount = await Promise.all(stClients.map(async (st) => ({
      contactAnalytics: await st.getContactAnalytics().catch(() => null),
      brandUsage: await st.getBrandUsage().catch(() => null),
      lists: await st.getLists().catch(() => []),
    })));

    const contactAnalyticsTotal = perAccount.reduce((sum, a) => sum + (a.contactAnalytics?.totals?.total ?? a.contactAnalytics?.total ?? 0), 0);
    const contactAnalytics = perAccount.some(a => a.contactAnalytics) ? { totals: { total: contactAnalyticsTotal } } : null;
    const brandUsage = perAccount.some(a => a.brandUsage) ? {
      total_credits: perAccount.reduce((sum, a) => sum + (a.brandUsage?.total_credits || 0), 0),
      credits_used: perAccount.reduce((sum, a) => sum + (a.brandUsage?.credits_used || 0), 0),
      credits_available: perAccount.reduce((sum, a) => sum + (a.brandUsage?.credits_available || 0), 0),
    } : null;
    const lists = perAccount.flatMap(a => a.lists);
    const messageAnalytics = null; // não usado no frontend hoje — ver getMessageAnalytics
    const creditAnalytics = null; // getCreditAnalytics sempre retorna null (endpoint 404 confirmado)

    // Contagem de contatos por lista de produto. Só produtos ATIVADOS: os descobertos
    // automaticamente entram desativados e só ganham lista no bootstrap da ativação, então
    // incluí-los só produzia ruído de "produto sem lista".
    const kits = await query<{
      name: string;
      st_list_compra_id: string | null;
      st_list_compra_id_2: string | null;
      st_list_abandono_id: string | null;
      st_list_abandono_id_2: string | null;
    }>(
      `SELECT name, st_list_compra_id, st_list_compra_id_2, st_list_abandono_id, st_list_abandono_id_2
       FROM kits WHERE client_id = $1 AND enabled = true`,
      [clientId]
    );

    // Vários SKUs do mesmo produto COMPARTILHAM a mesma lista (confirmado: as três variações de
    // Glyco Pulse apontam para o mesmo par de listas). Buscar por kit contava a mesma lista uma
    // vez por SKU — era o que inflava o card de contatos para várias vezes o tamanho da conta.
    // Aqui cada lista é buscada UMA vez, e o total soma listas distintas — incluindo a segunda
    // lista de produto vendido por mais de um gateway de lead (ver listasDoKit).
    const distinctListIds = new Set<number>();
    for (const kit of kits) {
      const l = listasDoKit(kit);
      l.compra.forEach(id => distinctListIds.add(parseInt(id)));
      l.abandono.forEach(id => distinctListIds.add(parseInt(id)));
    }
    // Um list_id só é válido numa das contas; as outras devolvem 0 (getListContactCount engole o erro).
    const countByList = new Map<number, number>();
    await Promise.all([...distinctListIds].map(async (listId) => {
      const perAccount = await Promise.all(stClients.map(st => st.getListContactCount(listId)));
      countByList.set(listId, perAccount.reduce((a, b) => a + b, 0));
    }));

    const listStats = kits.map((kit) => {
      const l = listasDoKit(kit);
      const somar = (ids: string[]) => ids.reduce((t, id) => t + (countByList.get(parseInt(id)) ?? 0), 0);
      return {
        product: kit.name,
        compra_list_id: kit.st_list_compra_id ? parseInt(kit.st_list_compra_id) : null,
        compra_list_id_2: kit.st_list_compra_id_2 ? parseInt(kit.st_list_compra_id_2) : null,
        compra_contacts: somar(l.compra),
        abandono_list_id: kit.st_list_abandono_id ? parseInt(kit.st_list_abandono_id) : null,
        abandono_list_id_2: kit.st_list_abandono_id_2 ? parseInt(kit.st_list_abandono_id_2) : null,
        abandono_contacts: somar(l.abandono),
      };
    });

    // Totais por LISTA DISTINTA — nunca somando a mesma lista mais de uma vez.
    const compraListIds = new Set(kits.flatMap(k => listasDoKit(k).compra).map(v => parseInt(v)));
    const abandonoListIds = new Set(kits.flatMap(k => listasDoKit(k).abandono).map(v => parseInt(v)));
    const totalCompra = [...compraListIds].reduce((sum, id) => sum + (countByList.get(id) ?? 0), 0);
    const totalAbandono = [...abandonoListIds].reduce((sum, id) => sum + (countByList.get(id) ?? 0), 0);

    // ── SMS-attributed sales KPIs (UTM contains 'mailxsms') — respeita o período de análise ──
    const period = resolvePeriodFilter(req);
    const periodActive = period.isToday || !!(period.from && period.to);
    const smsSalesParams: (string | number)[] = [clientId];
    const smsSalesPeriod = periodSql(period, smsSalesParams);
    // status IN ('processed', 'processing') nas tr\u00EAs consultas abaixo, igual ao clientTotal logo
    // adiante (e ao padr\u00E3o usado no resto do arquivo) \u2014 de prop\u00F3sito, n\u00E3o por acaso. Sem isso, um
    // pedido SMS com status='failed' (cen\u00E1rio real do pipeline da Digistore) entrava no numerador
    // da Representatividade SMS mas n\u00E3o no denominador (clientTotal j\u00E1 filtrava), e o card podia
    // passar de 100% \u2014 um n\u00FAmero que n\u00E3o existe fisicamente, achado ao auditar esta se\u00E7\u00E3o.
    const smsSales = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND status IN ('processed', 'processing') AND client_id = $1
        AND ${SQL_MAILX_SMS}
        ${smsSalesPeriod ? `AND ${smsSalesPeriod}` : ''}
    `, smsSalesParams);
    const smsRecParams: (string | number)[] = [clientId];
    const smsRecPeriod = periodSql(period, smsRecParams);
    const smsRecoveries = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND status IN ('processed', 'processing') AND client_id = $1
        AND ${SQL_MAILX_SMS}
        AND ${SQL_IS_RECOVERY}
        ${smsRecPeriod ? `AND ${smsRecPeriod}` : ''}
    `, smsRecParams);
    const smsUpsellParams: (string | number)[] = [clientId];
    const smsUpsellPeriod = periodSql(period, smsUpsellParams);
    const smsUpsell = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND status IN ('processed', 'processing') AND client_id = $1
        AND ${SQL_MAILX_SMS}
        AND ${SQL_IS_UPSELL}
        ${smsUpsellPeriod ? `AND ${smsUpsellPeriod}` : ''}
    `, smsUpsellParams);

    // Faturamento/vendas TOTAIS do cliente no mesmo per\u00EDodo (todos os canais) \u2014 pr\u00E9-requisito da
    // spec pra Representatividade por canal (se\u00E7\u00E3o 3.2/3.1.2): sem isso a aba SMS s\u00F3 mostrava o
    // lado "gerado pela MailX", sem o "faturamento aprovado do cliente" pra comparar.
    const totalParams: (string | number)[] = [clientId];
    const totalPeriodSql = periodSql(period, totalParams);
    const clientTotal = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND status IN ('processed', 'processing') AND client_id = $1
        ${totalPeriodSql ? `AND ${totalPeriodSql}` : ''}
    `, totalParams);

    const fmtBRL = (v: number) => `${symbol}\u00A0` + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const smsRevenue = parseFloat(smsSales?.revenue || '0');
    const smsRecRevenue = parseFloat(smsRecoveries?.revenue || '0');
    const smsVendas = parseInt(smsSales?.count || '0');
    const smsTicketMedio = smsVendas > 0 ? smsRevenue / smsVendas : 0;
    const smsUpsellRevenue = parseFloat(smsUpsell?.revenue || '0');
    const clientTotalRevenue = parseFloat(clientTotal?.revenue || '0');
    const clientTotalVendas = parseInt(clientTotal?.count || '0');

    res.json({
      configured: true,
      currency,
      period: {
        active: periodActive,
        is_today: period.isToday,
        from: period.from || null,
        to: period.to || null,
      },
      revenue: {
        faturamento_sms: fmtBRL(smsRevenue),
        // Valor bruto (número, não string formatada) — o resumo do negócio no front precisa dividir
        // por isso pra calcular "% da receita do SMS" da mensagem campeã. Sem ele, a única soma
        // numérica disponível no cliente era a da tabela granular (/sms-granular), que exige
        // utm_medium/utm_source EXATOS ('auto-sms'/'mailx-sms') — mais estreito que o SQL_IS_SMS
        // usado aqui, que também aceita formato não padrão (ex.: Horse Peak manda utm_medium=WFI001).
        // Resultado visto em produção: tabela granular somando $6.619 contra $7.936 do faturamento
        // real, e a mensagem campeã aparecendo com 58% de receita quando o certo era 48%.
        receita_sms: smsRevenue,
        vendas_sms: smsVendas,
        ticket_medio_sms: fmtBRL(smsTicketMedio),
        recuperacoes_sms: parseInt(smsRecoveries?.count || '0'),
        faturamento_recuperacoes_sms: fmtBRL(smsRecRevenue),
        vendas_upsell_sms: parseInt(smsUpsell?.count || '0'),
        faturamento_upsell_sms: fmtBRL(smsUpsellRevenue),
        // Faturamento/vendas do CLIENTE (todos os canais, mesmo período) + representatividade
        // do SMS dentro disso — seção 3.1.2/3.2 da spec original.
        faturamento_total_cliente: fmtBRL(clientTotalRevenue),
        vendas_total_cliente: clientTotalVendas,
        representatividade_sms: clientTotalRevenue > 0
          ? parseFloat(((smsRevenue / clientTotalRevenue) * 100).toFixed(1))
          : 0,
      },
      contacts: {
        total: totalCompra + totalAbandono,
        compradores: totalCompra,
        carrinhos_abandonados: totalAbandono,
        analytics: contactAnalytics,
      },
      messages: messageAnalytics,
      credits: {
        usage: brandUsage,
        analytics: creditAnalytics,
      },
      lists: {
        total: lists.length,
        per_product: listStats,
      },
    });
  } catch (err: any) {
    logger.error(CTX, `SlickText API error for client #${clientId}: ${err.message}`);
    res.json({
      configured: true,
      error: `SlickText API error: ${err.message}`,
    });
  }
}));

// ── Repair Stuck Webhooks ──
adminRouter.post('/clientes/:id/repair-webhooks', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string);
  const stores = await query<{ shop_slug: string, platform: string }>(
    `SELECT shop_slug, platform FROM store_integrations WHERE client_id = $1`, [clientId]
  );
  if (stores.length === 0) { res.status(400).json({ ok: false, error: 'No stores' }); return; }
  const cartpandaSlugs = stores.filter(s => s.platform === 'cartpanda').map(s => s.shop_slug.toLowerCase());

  // Match orphan webhooks by shop name inside the payload
  const orphans = await query<{ id: number, event_type: string, source: string, payload: any }>(
    `SELECT id, event_type, source, payload FROM webhook_logs
     WHERE client_id IS NULL
     AND source IN ('cartpanda', 'digistore24') ORDER BY created_at ASC LIMIT 5000`
  );
  let matched = 0, productsDiscovered = 0;
  const seenProducts = new Set<string>();
  for (const wh of orphans) {
    const raw = typeof wh.payload === 'string' ? JSON.parse(wh.payload) : wh.payload;
    const data = raw?.order || raw;
    // Match by shop name from payload
    const shopName = (data?.shop?.name || data?.shop_info?.name || '').toLowerCase();
    const isMatch = wh.source === 'cartpanda' && (
      cartpandaSlugs.includes(shopName) || cartpandaSlugs.length > 0
    );
    if (!isMatch) continue;
    await query(`UPDATE webhook_logs SET client_id = $1, status = 'processed', processed_at = NOW() WHERE id = $2`, [clientId, wh.id]);
    matched++;
    const lineItems = data?.line_items || data?.items || data?.cart_items || [];
    if (lineItems.length > 0) {
      const item = lineItems[0];
      const productName = item?.title || item?.name || 'produto';
      const externalId = String(item?.product_id || item?.variant_id || item?.id || '');
      if (externalId && productName !== 'produto') {
        const productKey = wh.source + ':' + externalId;
        if (!seenProducts.has(productKey)) {
          seenProducts.add(productKey);
          try {
            const slug = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const existing = await queryOne<{ id: number }>(`SELECT id FROM kits WHERE client_id = $1 AND platform = $2 AND external_id = $3`, [clientId, wh.source, externalId]);
            if (!existing) {
              await query(`INSERT INTO kits (client_id, name, slug, external_id, platform, enabled) VALUES ($1, $2, $3, $4, $5, false) ON CONFLICT (client_id, platform, external_id) WHERE external_id IS NOT NULL DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`, [clientId, productName, slug, externalId, wh.source]);
              productsDiscovered++;
            }
          } catch (err: any) { logger.warn(CTX, 'Repair kit err: ' + err.message); }
        }
      }
    }
  }
  res.json({ ok: true, orphans: orphans.length, matched, products_discovered: productsDiscovered });
}));


// GET /admin/clientes/:id/diagnostico/probe-digistore-api?order=XXXXXXXX
//
// A PERGUNTA: a API da Digistore devolve o utm_campaign do pedido?
//
// Por que importa: em 03/08/2026 21:34 o banco caiu, os webhooks passaram a tomar erro e a
// Digistore DESATIVOU as duas conexões de IPN sozinha. Ficaram 4 dias sem gravar nada — 1.023
// pagamentos e 384 reembolsos. O CSV do painel recupera dinheiro, produto e comprador, mas a
// coluna "Tracking key" vem VAZIA nas 34.696 linhas do arquivo inteiro, então o CSV não recupera
// atribuição: sem utm_campaign não se sabe de qual mensagem de automação a venda veio.
//
// O que a sonda faz: chama VÁRIAS funções candidatas da API com um pedido real e, em cada
// resposta, lista os nomes de campo que existem e destaca os que casam com utm/tracking/custom.
// Ela não procura um campo que eu imaginei — ela mostra os que existem. Essa distinção é o
// aprendizado de uma sonda anterior que reportou "não achado" porque eu chutei o nome do campo
// (short_url) em vez de listar as chaves; o dado estava lá, com outro nome (_link_ids).
//
// Requer DS24_API_KEY no .env do servidor (não vai pro repositório).
adminRouter.get('/clientes/:id/diagnostico/probe-digistore-api', asyncHandler(async (req: Request, res: Response) => {
  const order = String(req.query.order ?? '').trim();

  if (!ds24KeyConfigurada()) {
    res.json({
      pergunta: 'A API da Digistore devolve o utm_campaign do pedido?',
      erro: 'DS24_API_KEY não configurada',
      como_configurar: 'Adicionar DS24_API_KEY=<chave> no /var/www/mailx/.env e rodar pm2 restart mailx-api. A chave NÃO entra no repositório.',
    });
    return;
  }

  if (!order) {
    res.json({
      erro: 'Falta o parâmetro ?order=',
      como_usar: 'Pegar um Order ID do CSV dentro da janela perdida (ex: 3LMXMRTJ) e chamar ?order=3LMXMRTJ',
    });
    return;
  }

  // Catálogo resolvido na primeira rodada (pedido 3LMXMRTJ, 08/08/2026):
  //   getPurchase?purchase_id=<order>  → FUNCIONA, devolve o pedido com 80+ campos
  //   getPurchase/<order> na URL       → 400, "1. argument is missing: 'purchase_id'"
  //   getOrder / listOrders / getPurchaseDetails → "Invalid API function called"
  //   listPurchases?purchase_id / ?order_id → IGNORAM o filtro e devolvem a lista geral
  //     paginada (300 registros de outras compras). Responder 200 com o resultado de controle é
  //     indistinguível de funcionar — mesmo comportamento que a SlickText já apresentou duas
  //     vezes. Ficam de fora daqui: só poluíam a resposta com centenas de linhas alheias.
  const candidatas: Array<{ nome: string; fn: string; params?: Record<string, any>; pathArg?: string }> = [
    { nome: 'getPurchase (purchase_id na query)', fn: 'getPurchase', params: { purchase_id: order } },
    { nome: 'listTransactions (purchase_id)', fn: 'listTransactions', params: { purchase_id: order } },
  ];

  const resultados: any[] = [];

  for (const c of candidatas) {
    const r = await ds24Call(c.fn, c.params, c.pathArg);

    // O corpo útil pode estar em data, em data.data ou na raiz — a sonda olha os três, pra não
    // afirmar "vazio" quando o dado está um nível abaixo.
    const alvo = r.data?.data ?? r.data;

    // As duas perguntas, separadas de propósito. A primeira versão desta sonda respondeu só a
    // primeira e reportou como se fosse a segunda: declarou "SIM, achei atribuição" com
    // campaignkey, custom e tracking_param todos "". Nome de campo não é dado; só valor é.
    const camposQueExistem = r.ok ? acharChavesInteressantes(alvo, 4, '', false) : {};
    const camposComValor = r.ok ? acharChavesInteressantes(alvo, 4, '', true) : {};

    resultados.push({
      candidata: c.nome,
      http: r.http,
      ok: r.ok,
      erro: r.erro ?? null,
      chaves_no_topo: alvo && typeof alvo === 'object' ? Object.keys(alvo).slice(0, 100) : null,
      campos_de_atribuicao_que_existem: Object.keys(camposQueExistem).length ? Object.keys(camposQueExistem) : null,
      campos_de_atribuicao_COM_VALOR: Object.keys(camposComValor).length ? camposComValor : null,
    });
  }

  const comValor = resultados.filter((r) => r.campos_de_atribuicao_COM_VALOR);
  const responderam = resultados.filter((r) => r.ok);

  res.json({
    pergunta: 'A API da Digistore devolve o utm_campaign do pedido?',
    pedido_testado: order,
    veredito: comValor.length
      ? `SIM — campo de atribuição veio PREENCHIDO em ${comValor.length} de ${candidatas.length} candidatas. Dá pra reconstruir a janela perdida com utm real, sem inferir nada.`
      : responderam.length
        ? `NÃO — ${responderam.length} candidatas responderam e os campos de atribuição existem, mas TODOS vazios. Se este pedido tem utm_campaign gravado no nosso banco, está provado que a Digistore só REPASSA os parâmetros da URL no IPN e não os PERSISTE no pedido: a API não recupera atribuição. Se o pedido não tinha utm, o teste é inconclusivo — repetir com um que tenha.`
        : 'NENHUMA candidata respondeu — olhe o campo erro de cada linha antes de concluir qualquer coisa.',
    aviso_de_leitura:
      'campos_de_atribuicao_que_existem lista NOMES; campos_de_atribuicao_COM_VALOR lista os que têm conteúdo. Só o segundo prova algo.',
    resultados,
  });
}));

// GET /admin/clientes/:id/saude-da-coleta?start=&end=
//
// Responde duas perguntas que o painel não sabia responder e que custaram 4 dias em agosto/2026:
//
//   1. A coleta está funcionando AGORA? (último webhook, cadência normal, silêncio anormal)
//   2. O período que estou olhando tem buraco conhecido de coleta?
//
// A segunda é a que evita ler falha de coleta como queda de venda. Em 03/08 21:34 a Digistore
// desativou sozinha as conexões de IPN e ficamos 4 dias sem gravar 1.023 pagamentos. Decidido não
// importar (o CSV do painel não traz UTM; recuperaria total sem atribuição). Mas o buraco tem que
// aparecer na tela: total incompleto sem aviso vira conclusão errada sobre o canal.
adminRouter.get('/clientes/:id/saude-da-coleta', asyncHandler(async (req: Request, res: Response) => {
  const clientId = parseInt(req.params.id as string, 10);
  // company_name: a tabela clients não tem coluna `name` (o mesmo engano quebrou o vigia inteiro
  // na primeira subida, com "column c.name does not exist" a cada verificação).
  const cliente = await queryOne<{ id: number; nome: string }>(
    `SELECT id, company_name AS nome FROM clients WHERE id = $1`, [clientId]
  );
  if (!cliente) {
    res.status(404).json({ error: 'Cliente não encontrado' });
    return;
  }

  const start = String(req.query.start ?? '').trim();
  const end = String(req.query.end ?? '').trim();

  const estado = await estadoDoCliente(cliente.id, cliente.nome);

  // Sobreposição de intervalos, com fim nulo significando "ainda aberta". Comparar só o início
  // deixaria passar a janela que começou antes do período e invadiu metade dele — que é
  // exatamente o formato desta que aconteceu.
  const janelas = start && end
    ? await query<any>(
        `SELECT id, fonte, inicio::text, fim::text, motivo,
                vendas_perdidas_estimadas, valor_perdido_estimado
         FROM janelas_sem_coleta
         WHERE client_id = $1
           AND inicio <= ($3::date + INTERVAL '1 day')
           AND (fim IS NULL OR fim >= $2::date)
         ORDER BY inicio`,
        [clientId, start, end]
      )
    : await query<any>(
        `SELECT id, fonte, inicio::text, fim::text, motivo,
                vendas_perdidas_estimadas, valor_perdido_estimado
         FROM janelas_sem_coleta WHERE client_id = $1 ORDER BY inicio DESC LIMIT 10`,
        [clientId]
      );

  res.json({
    coleta_agora: {
      ultimo_webhook: estado.ultimoWebhook,
      horas_em_silencio: estado.horasEmSilencio != null ? Number(estado.horasEmSilencio.toFixed(1)) : null,
      limite_horas: estado.limiteHoras,
      intervalo_normal_minutos: estado.intervaloMedioMinutos != null
        ? Math.round(estado.intervaloMedioMinutos) : null,
      em_silencio: estado.emSilencio,
      // O limite é derivado da cadência do próprio cliente (mediana dos últimos 14 dias × 8,
      // entre 3h e 30h), não de um número fixo — cliente que vende de 10 em 10 minutos e cliente
      // que vende 3 vezes por dia não podem ter o mesmo alarme.
      como_o_limite_e_calculado: estado.intervaloMedioMinutos != null
        ? `mediana de ${Math.round(estado.intervaloMedioMinutos)} min entre vendas nos últimos 14 dias × 8, limitado a [3h, 30h]`
        : 'sem histórico suficiente de vendas — usando o teto de 30h',
    },
    janelas_sem_coleta: janelas.map((j: any) => ({
      ...j,
      valor_perdido_estimado: j.valor_perdido_estimado != null ? parseFloat(j.valor_perdido_estimado) : null,
      em_aberto: j.fim === null,
    })),
    periodo_tem_buraco: janelas.length > 0 && !!start && !!end,
    notificacao: {
      canais_configurados: canaisConfigurados(),
      // Sem canal o vigia continua rodando e registrando em log; só o empurrão pro celular é que
      // não sai. Dizer isso evita alguém supor que está protegido quando não está.
      aviso: canaisConfigurados().length === 0
        ? 'Nenhum canal configurado: o silêncio é detectado e vai pro log, mas ninguém é avisado no celular.'
        : null,
    },
  });
}));

// GET /admin/clientes/:id/vendas-fora-do-escopo?limit=20
//
// QUAIS vendas ficam fora da tabela de Conversão por Segmento, uma a uma.
//
// A tabela mostra só a quantidade agregada ("70 vendas de fluxo de comprador e 52 recuperações de
// carrinho do período não aparecem aqui"). Quantidade agregada não dá pra conferir: o Nicollas
// pediu 5 ou 6 exemplos reais pra analisar, e ele está certo — número que ninguém consegue abrir
// vira crença, não medição.
//
// Cada linha traz o pedido, a data, o produto, o valor e o utm_campaign que a gerou. Com o
// utm_campaign em mãos dá pra ir na SlickText e ver qual mensagem é, ou concluir que o link saiu
// sem marcação.
adminRouter.get('/clientes/:id/vendas-fora-do-escopo', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const period = resolvePeriodFilter(req);
  const limite = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

  const params: (string | number)[] = [clientId];
  const periodo = periodSql(period, params);

  const linhas = await query<any>(`
    SELECT
      payload->>'order_id' AS pedido,
      created_at::text     AS quando,
      product_name         AS produto,
      total_price          AS valor,
      utm_campaign,
      utm_medium,
      (${SQL_IS_RECOVERY}) AS e_recuperacao
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND client_id = $1 AND ${SQL_MAILX_SMS}
      ${periodo ? `AND ${periodo}` : ''}
      AND NOT EXISTS (
        SELECT 1 FROM sms_campaign_map m
        WHERE m.client_id = $1 AND m.utm_campaign = webhook_logs.utm_campaign
      )
    ORDER BY created_at DESC
    LIMIT ${limite}
  `, params);

  const semUtm = linhas.filter((l: any) => !l.utm_campaign || !String(l.utm_campaign).trim()).length;

  res.json({
    pergunta: 'Quais vendas ficam fora da tabela de Conversão por Segmento, e por quê?',
    periodo: period.from && period.to ? { de: period.from, ate: period.to } : 'todo o histórico',
    total_listado: linhas.length,
    limite_aplicado: limite,
    // Limite explícito na resposta: lista cortada sem dizer que foi cortada faz alguém concluir
    // que o problema é menor do que é.
    aviso: linhas.length === limite
      ? `Lista truncada em ${limite}. Use ?limit= para ver mais.`
      : null,
    resumo: {
      sem_utm_campaign: semUtm,
      com_utm_mas_nao_vinculada: linhas.length - semUtm,
      o_que_significa: 'Sem utm_campaign, o link não identifica a mensagem e não há como vincular — o conserto é no link, na SlickText. Com utm_campaign mas sem vínculo, é só rodar o Auto-vincular na aba SMS.',
    },
    vendas: linhas.map((l: any) => ({
      pedido: l.pedido,
      quando: l.quando,
      produto: l.produto,
      valor: l.valor != null ? parseFloat(l.valor) : null,
      utm_campaign: l.utm_campaign,
      utm_medium: l.utm_medium,
      fluxo: l.e_recuperacao ? 'carrinho abandonado' : 'comprador (pós-compra/upsell)',
      motivo: !l.utm_campaign || !String(l.utm_campaign).trim()
        ? 'venda sem utm_campaign — o link não identifica a mensagem'
        : 'mensagem não vinculada a nenhuma automação — rode o Auto-vincular',
    })),
  });
}));

// GET /admin/clientes/:id/diagnostico/invariantes
//
// Todas as identidades que o painel deve satisfazer, com os dois lados de cada uma e se fecha.
//
// Serve para auditar a tela inteira em segundos, sem depender de alguém estranhar um número por
// acaso — que foi como os três bugs de sobreposição de 08/08/2026 apareceram, depois de meses no
// ar. `fecha: null` significa NÃO VERIFICÁVEL (faltou um dos lados, geralmente porque a SlickText
// não respondeu), e é diferente de `false`: tratar ausência como falha ensinaria a ignorar o
// alarme.
adminRouter.get('/clientes/:id/diagnostico/invariantes', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const period = resolvePeriodFilter(req);
  const params: (string | number)[] = [clientId];
  const periodo = periodSql(period, params);

  // MESMA função que a aba SMS usa. Antes este endpoint refazia a conta por conta própria e
  // conferia 1 das 4 identidades — a ferramenta feita para achar inconsistência estava, ela
  // mesma, incompleta pelo motivo que ela existe para combater.
  const a = await apurarSms(query, clientId, periodo, params);

  const resultado = conferirInvariantes({
    segmentoSms: {
      recuperacoes: a.recuperacoes,
      compradores: a.compradores,
      naoClassificado: a.naoClassificado,
      totalCanal: a.total,
    },
    escopoSms: {
      dentroRec: a.dentroRec,
      dentroCompra: a.dentroCompra,
      foraRec: a.foraRec,
      foraCompra: a.foraCompra,
      naoClassificado: a.naoClassificado,
      totalCanal: a.total,
    },
  });

  res.json({
    periodo: period.from && period.to ? { de: period.from, ate: period.to } : 'todo o histórico',
    tudo_fecha: resultado.tudoFecha,
    veredito: resultado.tudoFecha
      ? 'Todas as identidades verificáveis fecham neste período.'
      : `${resultado.quebradas.length} identidade(s) NÃO fecham — há número errado na tela.`,
    como_ler: 'fecha=true bate; fecha=false há erro; fecha=null não foi possível verificar (faltou um dos lados) — que é diferente de estar errado.',
    invariantes: resultado.invariantes,
  });
}));

// GET /admin/clientes/:id/diagnostico/inventario-de-listas
//
// TODAS as listas da conta, com a contagem atual e o vínculo (se houver), pra achar lista
// abandonada e lista nova que ninguém vinculou.
//
// Por que existe: em 10/08/2026 a lista de compradores do NeuroMind (107460) apareceu com 19.706
// contatos em OITO retratos consecutivos — zero variação em 11 dias, num produto que vende
// centenas por semana. A lista de abandono do MESMO produto crescia todo dia (+632 no período),
// então não era a conta, nem a marca, nem a API.
//
// Número perfeitamente imóvel não parece automação quebrada; parece lista ABANDONADA — alguém
// criou uma nova, os compradores passaram a entrar nela, e a antiga congelou no valor do dia da
// troca. O auto-vínculo casa por NOME e pegou a velha, então o denominador do segmento de
// compradores virou zero e a taxa ficou incalculável, sem nada na tela explicando por quê.
//
// Este endpoint mostra o inventário inteiro justamente porque o problema NÃO está no que a gente
// já conhece: está numa lista que o painel nunca olhou.
adminRouter.get('/clientes/:id/diagnostico/inventario-de-listas', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const contas = await getSlickTextAccounts(clientId);

  // Vínculos atuais, pra marcar cada lista como usada por qual produto e em qual papel — incluindo
  // a segunda lista, quando o produto é vendido por mais de um gateway de lead (ver listasDoKit).
  // Sem isso, a segunda lista continuaria aparecendo aqui como "NÃO VINCULADA" mesmo depois de
  // vinculada, porque este inventário lia só a coluna 1.
  const vinculos = await query<{ nome: string; compra: string | null; compra_2: string | null; abandono: string | null; abandono_2: string | null }>(
    `SELECT name AS nome, st_list_compra_id AS compra, st_list_compra_id_2 AS compra_2,
            st_list_abandono_id AS abandono, st_list_abandono_id_2 AS abandono_2
     FROM kits WHERE client_id = $1 AND enabled = true`,
    [clientId]
  );
  const usoPorLista = new Map<string, string[]>();
  for (const v of vinculos) {
    const l = listasDoKit({ st_list_compra_id: v.compra, st_list_compra_id_2: v.compra_2, st_list_abandono_id: v.abandono, st_list_abandono_id_2: v.abandono_2 });
    l.compra.forEach(id => usoPorLista.set(id, [...(usoPorLista.get(id) ?? []), `${v.nome} (compra)`]));
    l.abandono.forEach(id => usoPorLista.set(id, [...(usoPorLista.get(id) ?? []), `${v.nome} (abandono)`]));
  }

  // Variação medida pelos retratos: é ela que distingue lista viva de lista congelada. Sem isso
  // o inventário mostraria só tamanhos, e tamanho grande não quer dizer lista em uso.
  const variacao = await query<{ list_id: string; primeiro: string; ultimo: string; dias: string }>(
    `SELECT list_id,
            (ARRAY_AGG(contact_count ORDER BY snapshot_date))[1]::text AS primeiro,
            (ARRAY_AGG(contact_count ORDER BY snapshot_date DESC))[1]::text AS ultimo,
            COUNT(*)::text AS dias
     FROM list_contact_snapshots WHERE client_id = $1 GROUP BY list_id`,
    [clientId]
  );
  const varPorLista = new Map(variacao.map(v => [v.list_id, v]));

  const saida: any[] = [];

  for (const acc of contas) {
    const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
    let listas: any[] = [];
    let erro: string | null = null;
    try {
      listas = await st.getLists();
    } catch (err: any) {
      erro = err.message;
    }

    const detalhadas = [];
    for (const l of listas) {
      const id = String(l.contact_list_id);
      // Contagem é chamada por lista; erro em uma não pode zerar as outras nem virar 0 na tela —
      // 0 e "não sei" são coisas diferentes.
      let contatos: number | null = null;
      try {
        contatos = await st.getListContactCount(l.contact_list_id);
      } catch { contatos = null; }

      const v = varPorLista.get(id);
      const cresceu = v ? parseInt(v.ultimo) - parseInt(v.primeiro) : null;

      detalhadas.push({
        list_id: id,
        nome: l.name,
        criada: l.created ?? null,
        contatos_agora: contatos,
        vinculada_a: usoPorLista.get(id) ?? null,
        retratos: v ? { dias: parseInt(v.dias), variacao_no_periodo: cresceu } : null,
        // O rótulo que responde a pergunta de uma vez.
        situacao: v == null
          ? (usoPorLista.has(id) ? 'vinculada, mas sem retrato ainda' : 'NÃO VINCULADA — o painel nunca olhou esta lista')
          : cresceu === 0
            ? 'CONGELADA — nenhum contato novo no período coberto pelos retratos'
            : 'viva',
      });
    }

    saida.push({
      conta: acc.accountId == null ? 'principal' : `extra #${acc.accountId}`,
      brand_id: acc.st_brand_id,
      erro,
      total_de_listas: detalhadas.length,
      listas: detalhadas.sort((a, b) => (b.contatos_agora ?? 0) - (a.contatos_agora ?? 0)),
    });
  }

  const congeladas = saida.flatMap(c => c.listas.filter((l: any) => l.situacao.startsWith('CONGELADA')));
  const orfas = saida.flatMap(c => c.listas.filter((l: any) => l.situacao.startsWith('NÃO VINCULADA') && (l.contatos_agora ?? 0) > 0));

  res.json({
    pergunta: 'Existe lista abandonada (congelada) ou lista nova que ninguém vinculou?',
    veredito: congeladas.length > 0 && orfas.length > 0
      ? `Suspeita CONFIRMÁVEL: ${congeladas.length} lista(s) congelada(s) e ${orfas.length} lista(s) com contatos que o painel não olha. Compare os nomes — se houver par do mesmo produto, a antiga foi abandonada e a nova é a que está em uso.`
      : congeladas.length > 0
        ? `${congeladas.length} lista(s) congelada(s), mas nenhuma lista nova com contatos apareceu. Aí a hipótese muda: a automação que alimenta essa lista pode estar desligada na SlickText.`
        : 'Nenhuma lista congelada no período coberto pelos retratos.',
    resumo: { congeladas: congeladas.map((l: any) => l.nome), nao_vinculadas_com_contatos: orfas.map((l: any) => l.nome) },
    contas: saida,
  });
}));

/**
 * Normaliza UTM para comparar grafias. Minúscula e sem separador: `mailx-sms`, `mailx_sms` e
 * `MailxSMS` colapsam no mesmo valor.
 *
 * Existe porque a grafia já custou uma conclusão errada: uma consulta com `ILIKE '%mailxsms%'`
 * devolveu zero venda de SMS em toda a janela investigada, e a leitura foi "não houve venda de
 * SMS" quando o valor real era `mailx-sms`, com hífen. Duas grafias da mesma coisa são,
 * para qualquer filtro, duas coisas diferentes — e o filtro não avisa que perdeu linha.
 */
function normalizarUtm(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase().replace(/[-_\s.]/g, '');
}

/** Extrai os utm_* da query string de um link. Devolve strings vazias no lugar de null. */
function utmDaUrl(url: string | null | undefined): { source: string; medium: string; campaign: string } {
  const vazio = { source: '', medium: '', campaign: '' };
  if (!url) return vazio;
  try {
    // Base fictícia para aceitar URL relativa sem lançar; o que interessa é só a query.
    const q = new URL(String(url), 'https://x.invalid').searchParams;
    return {
      source: q.get('utm_source') ?? '',
      medium: q.get('utm_medium') ?? '',
      campaign: q.get('utm_campaign') ?? '',
    };
  } catch {
    return vazio;
  }
}

// GET /admin/clientes/:id/diagnostico/inventario-de-utm
//
// Todas as UTM que os links da SlickText CARREGAM, contra todas as UTM que de fato CHEGAM nas
// vendas — e a diferença entre as duas.
//
// Por que existe: a UTM não está no n8n. O n8n move contato entre listas; quem carrega a UTM é o
// link dentro do texto do SMS, e esse link vive na SlickText (`GET /links` traz a `url` com a query
// string inteira). Auditar fluxo no n8n nunca vai encontrar erro de UTM, porque a UTM não passa por
// lá — foi por isso que uma auditoria dos workflows voltou sem essa informação.
//
// O que este endpoint responde, que nenhum dos dois lados responde sozinho:
//
//   1. CONFIGURADO E NUNCA CHEGOU — link existe com aquela UTM, mas nenhuma venda veio com ela.
//      Ou a mensagem não está sendo enviada, ou ninguém clica, ou a plataforma perde o parâmetro.
//      Nos três casos a receita daquela mensagem aparece como zero no painel, e zero de receita é
//      indistinguível de mensagem que não converte.
//   2. CHEGA E NÃO ESTÁ CONFIGURADO — venda com UTM que nenhum link nosso carrega. É atribuição
//      que o painel está aceitando sem saber de onde vem.
//   3. GRAFIA DIVERGENTE — duas escritas da mesma coisa (`mailx-sms` vs `mailx_sms`). É o caso mais
//      perigoso porque some silenciosamente: o filtro casa uma e descarta a outra, e a venda
//      descartada não aparece em lugar nenhum como "descartada" — aparece como se não existisse.
//   4. CAMPANHA SEM VÍNCULO — utm_campaign que chega mas não está em `sms_campaign_map`, ou seja,
//      venda que fica fora do escopo por automação e não entra em taxa nenhuma.
adminRouter.get('/clientes/:id/diagnostico/inventario-de-utm', asyncHandler(async (req: Request, res: Response) => {
  const clientId = req.params.id as string;
  const dias = Math.min(365, Math.max(1, parseInt(String(req.query.dias ?? '45')) || 45));
  const contas = await getSlickTextAccounts(clientId);

  // ── Lado CONFIGURADO: os links da SlickText ──
  //
  // getAllLinks, e não getLinks({source:'Workflow'}): os links dos disparos via N8N são criados à
  // mão no encurtador e têm source='manual', então o filtro por Workflow nunca os enxerga. Filtrar
  // aqui esconderia justamente os links que este cliente mais usa.
  type LinkUtm = { conta: string; brand_id: string; source: string; workflow_id: number | null; node_id: number | null; url: string; utm: { source: string; medium: string; campaign: string } };
  const links: LinkUtm[] = [];
  const errosPorConta: Array<{ conta: string; erro: string }> = [];

  for (const acc of contas) {
    const rotulo = acc.accountId == null ? 'principal' : `extra #${acc.accountId}`;
    try {
      const st = new SlickTextClient(acc.st_api_token, acc.st_brand_id);
      for (const l of await st.getAllLinks()) {
        const url = String(l.url ?? l.long_url ?? '');
        links.push({
          conta: rotulo,
          brand_id: acc.st_brand_id,
          source: String(l.source ?? 'desconhecido'),
          workflow_id: l._source_id != null ? Number(l._source_id) : null,
          node_id: l._sub_source_id != null ? Number(l._sub_source_id) : null,
          url,
          utm: utmDaUrl(url),
        });
      }
    } catch (err: any) {
      // Conta que falhou NÃO pode virar "nenhum link configurado": isso transformaria falha de
      // leitura em achado ("chega e não está configurado") para todas as UTM daquela conta.
      errosPorConta.push({ conta: rotulo, erro: err.message });
    }
  }

  const chave = (u: { source: string; medium: string; campaign: string }) => `${u.source}|${u.medium}|${u.campaign}`;

  const configurado = new Map<string, { utm: { source: string; medium: string; campaign: string }; links: number; contas: Set<string>; workflows: Set<number>; nodes: Set<number>; exemplo_url: string }>();
  for (const l of links) {
    // Link sem utm_source nenhum não é erro: encurtador tem link de suporte, de opt-out, de
    // rastreio interno. Só entra no inventário o que carrega alguma atribuição.
    if (!l.utm.source && !l.utm.medium && !l.utm.campaign) continue;
    const k = chave(l.utm);
    const e = configurado.get(k) ?? { utm: l.utm, links: 0, contas: new Set<string>(), workflows: new Set<number>(), nodes: new Set<number>(), exemplo_url: l.url };
    e.links++;
    e.contas.add(l.conta);
    if (l.workflow_id != null) e.workflows.add(l.workflow_id);
    if (l.node_id != null) e.nodes.add(l.node_id);
    configurado.set(k, e);
  }

  // ── Lado QUE CHEGA: as vendas gravadas ──
  const chegando = await query<{ source: string | null; medium: string | null; campaign: string | null; vendas: string; receita: string | null; primeira: string; ultima: string }>(
    `SELECT utm_source AS source, utm_medium AS medium, utm_campaign AS campaign,
            COUNT(*)::text AS vendas,
            COALESCE(SUM(total_price), 0)::text AS receita,
            MIN(created_at)::text AS primeira,
            MAX(created_at)::text AS ultima
     FROM webhook_logs
     WHERE client_id = $1 AND event_type = 'order.paid'
       AND created_at >= NOW() - ($2 || ' days')::interval
       AND COALESCE(utm_source, '') <> ''
     GROUP BY utm_source, utm_medium, utm_campaign
     ORDER BY COUNT(*) DESC`,
    [clientId, String(dias)]
  );

  // ── Campanhas com vínculo de mensagem ──
  const mapeadas = await query<{ utm_campaign: string }>(
    `SELECT DISTINCT utm_campaign FROM sms_campaign_map WHERE client_id = $1`,
    [clientId]
  );
  const campanhasMapeadas = new Set(mapeadas.map(m => m.utm_campaign));

  // ── Cruzamento ──
  //
  // O casamento é feito na forma NORMALIZADA. Comparar cru diria que `mailx-sms` e `mailx_sms` são
  // duas coisas sem relação, e o relatório sairia com um "configurado e nunca chegou" e um "chega e
  // não está configurado" que na verdade são o MESMO par, separados por um caractere.
  const chaveNorm = (u: { source: string; medium: string; campaign: string }) =>
    `${normalizarUtm(u.source)}|${normalizarUtm(u.medium)}|${normalizarUtm(u.campaign)}`;

  const normConfigurado = new Set([...configurado.values()].map(c => chaveNorm(c.utm)));
  const normChegando = new Set(chegando.map(c => chaveNorm({ source: c.source ?? '', medium: c.medium ?? '', campaign: c.campaign ?? '' })));

  const configuradoENuncaChegou = [...configurado.values()]
    .filter(c => !normChegando.has(chaveNorm(c.utm)))
    .map(c => ({
      utm: c.utm,
      links: c.links,
      contas: [...c.contas],
      workflows: [...c.workflows],
      nodes: [...c.nodes],
      exemplo_url: c.exemplo_url.slice(0, 200),
    }));

  const chegaENaoConfigurado = chegando
    .filter(c => !normConfigurado.has(chaveNorm({ source: c.source ?? '', medium: c.medium ?? '', campaign: c.campaign ?? '' })))
    .map(c => ({
      utm: { source: c.source, medium: c.medium, campaign: c.campaign },
      vendas: parseInt(c.vendas),
      receita: parseFloat(c.receita ?? '0'),
      primeira: c.primeira,
      ultima: c.ultima,
    }));

  // ── Grafia divergente ──
  //
  // Agrupa por forma normalizada e denuncia todo grupo com mais de uma escrita crua. Olha os dois
  // lados juntos de propósito: o caso perigoso é justamente o link estar escrito de um jeito e a
  // venda chegar do outro.
  const porNormalizado = new Map<string, Set<string>>();
  const registrar = (campo: string, valor: string | null | undefined) => {
    const cru = String(valor ?? '').trim();
    if (!cru) return;
    const k = `${campo}:${normalizarUtm(cru)}`;
    porNormalizado.set(k, (porNormalizado.get(k) ?? new Set<string>()).add(cru));
  };
  for (const c of configurado.values()) {
    registrar('utm_source', c.utm.source);
    registrar('utm_medium', c.utm.medium);
    registrar('utm_campaign', c.utm.campaign);
  }
  for (const c of chegando) {
    registrar('utm_source', c.source);
    registrar('utm_medium', c.medium);
    registrar('utm_campaign', c.campaign);
  }
  const grafiaDivergente = [...porNormalizado.entries()]
    .filter(([, escritas]) => escritas.size > 1)
    .map(([k, escritas]) => ({ campo: k.split(':')[0], escritas: [...escritas] }));

  // ── Campanhas que chegam sem vínculo de mensagem ──
  const campanhaSemVinculo = [...new Set(chegando.map(c => c.campaign).filter((v): v is string => !!v))]
    .filter(c => !campanhasMapeadas.has(c))
    .map(c => {
      const linhas = chegando.filter(x => x.campaign === c);
      return {
        utm_campaign: c,
        vendas: linhas.reduce((a, b) => a + parseInt(b.vendas), 0),
        receita: linhas.reduce((a, b) => a + parseFloat(b.receita ?? '0'), 0),
      };
    })
    .sort((a, b) => b.vendas - a.vendas);

  const leituraIncompleta = errosPorConta.length > 0;

  res.json({
    pergunta: 'As UTM que os links carregam são as mesmas que chegam nas vendas?',
    periodo_das_vendas: `últimos ${dias} dias`,
    // A cobertura vem ANTES dos achados: conta que falhou faz toda UTM dela parecer "não
    // configurada", e quem lê precisa saber disso antes de acreditar na lista.
    cobertura: {
      contas_lidas: contas.length - errosPorConta.length,
      contas_com_erro: errosPorConta,
      links_lidos: links.length,
      links_com_utm: [...configurado.values()].reduce((a, b) => a + b.links, 0),
      aviso: leituraIncompleta
        ? 'LEITURA INCOMPLETA — uma ou mais contas falharam. O bloco "chega_e_nao_configurado" está inflado: as UTM dessas contas não foram lidas e por isso parecem inexistentes.'
        : null,
    },
    veredito: leituraIncompleta
      ? 'Não dá para concluir: faltou ler pelo menos uma conta.'
      : grafiaDivergente.length > 0
        ? `${grafiaDivergente.length} valor(es) escrito(s) de mais de uma forma — isso faz filtro perder venda em silêncio. Comece por aqui.`
        : chegaENaoConfigurado.length > 0
          ? `${chegaENaoConfigurado.length} UTM chegando sem link nosso que a carregue — atribuição de origem desconhecida.`
          : configuradoENuncaChegou.length > 0
            ? `Grafias consistentes. ${configuradoENuncaChegou.length} UTM configurada(s) que nunca trouxe venda — verificar se a mensagem está sendo enviada.`
            : 'Os dois lados batem.',
    grafia_divergente: grafiaDivergente,
    chega_e_nao_configurado: chegaENaoConfigurado,
    configurado_e_nunca_chegou: configuradoENuncaChegou,
    campanha_sem_vinculo_de_mensagem: campanhaSemVinculo,
    // As duas listas cruas, para colar em planilha.
    configurado: [...configurado.values()]
      .map(c => ({ utm: c.utm, links: c.links, contas: [...c.contas], workflows: [...c.workflows], nodes: [...c.nodes] }))
      .sort((a, b) => b.links - a.links),
    chegando: chegando.map(c => ({
      utm: { source: c.source, medium: c.medium, campaign: c.campaign },
      vendas: parseInt(c.vendas),
      receita: parseFloat(c.receita ?? '0'),
      primeira: c.primeira,
      ultima: c.ultima,
      campanha_com_vinculo: c.campaign ? campanhasMapeadas.has(c.campaign) : null,
    })),
  });
}));
