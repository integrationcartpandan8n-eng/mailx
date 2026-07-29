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

// ─────────────────────────────────────────────────────────────
// Fase B — Atribuição MailX via colunas normalizadas
// Canal decidido por utm_medium (padrão UTMS_DASH), com fallback
// legado (source/campaign sem hífen) para registros antigos sem medium.
// ─────────────────────────────────────────────────────────────

/** Venda atribuída à MailX (qualquer canal). */
const SQL_IS_MAILX = `(
  COALESCE(utm_source, '')   ILIKE '%mailx%'
  OR COALESCE(utm_campaign, '') ILIKE '%mailx%'
)`;

/** Canal SMS: medium contém 'sms'; fallback legado se medium nulo. */
const SQL_IS_SMS = `(
  COALESCE(utm_medium, '') ILIKE '%sms%'
  OR (
    utm_medium IS NULL
    AND (
      REPLACE(COALESCE(utm_source, ''),   '-', '') ILIKE '%mailxsms%'
      OR REPLACE(COALESCE(utm_campaign, ''), '-', '') ILIKE '%mailxsms%'
    )
  )
)`;

/** MailX via SMS. */
const SQL_MAILX_SMS = `(${SQL_IS_MAILX} AND ${SQL_IS_SMS})`;

/** MailX via Email = MailX e NÃO SMS. */
const SQL_MAILX_EMAIL = `(${SQL_IS_MAILX} AND NOT ${SQL_IS_SMS})`;

/** Recuperação de carrinho abandonado (qualquer canal). */
const SQL_IS_RECOVERY = `(
  COALESCE(utm_campaign, '') ILIKE '%carrinhoabandonado%'
  OR COALESCE(utm_source, '') ILIKE '%carrinhoabandonado%'
)`;

/** Medium de automação (auto-email / auto-sms). */
const SQL_MEDIUM_AUTO = `COALESCE(utm_medium, '') ILIKE '%auto%'`;

/** Medium de campanha (campaign-editorial / campaing-promo e variações). */
const SQL_MEDIUM_CAMPAIGN = `(
  COALESCE(utm_medium, '') ILIKE '%campai%'
  OR COALESCE(utm_medium, '') ILIKE '%editorial%'
  OR COALESCE(utm_medium, '') ILIKE '%promo%'
)`;

/** Campanha de upsell. */
const SQL_IS_UPSELL = `COALESCE(utm_campaign, '') ILIKE '%upsell%'`;

/** Receita normalizada (Fase A garante NUMERIC ou NULL). */
const SQL_REVENUE = `COALESCE(SUM(total_price), 0)`;

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

  const channelExtra = channel === 'email' ? `AND NOT ${SQL_IS_SMS}` : '';
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

  const row = await queryOne<{ aprovado: string; reembolso: string; chargeback_custo: string }>(`
    SELECT
      COALESCE(SUM(total_price) FILTER (WHERE event_type = 'order.paid' AND status = 'processed'), 0) AS aprovado,
      COALESCE(SUM(ABS(total_price)) FILTER (WHERE event_type = 'order.refunded'), 0) AS reembolso,
      COALESCE(SUM(ABS(total_price)) FILTER (WHERE event_type = 'order.chargeback'), 0) AS chargeback_custo
    FROM webhook_logs
    WHERE ${dateFilterSql}
      ${clientFilter}
  `, params);

  const currency = cid ? await resolveClientCurrency(cid) : 'USD';

  res.json({
    aprovado: parseFloat(row?.aprovado || '0'),
    reembolso: parseFloat(row?.reembolso || '0'),
    chargeback_custo: parseFloat(row?.chargeback_custo || '0'),
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

  // ── Conversão por Segmento: leads via SlickText (lista Compra/Abandono). ──
  // Vitalício — CONFIRMADO via probe em produção que /analytics/contacts NÃO aceita filtro
  // por lista (list_id e _list_id devolvem o mesmo total do brand inteiro, igual sem filtro
  // nenhum: 66.774 nos três casos). Trocado pra GET /lists/{id}/contacts/count, o mesmo
  // endpoint já usado (e confirmado certo) no card "Listas por Produto" — não filtra por
  // período, mas ao menos devolve o número CORRETO de cada lista.
  // Vendas continuam vindo do nosso banco (já são exatas, é conversão real registrada).
  let abandonoLeads = 0;
  let compradorLeads = 0;
  let leadsSource: 'slicktext_list' | 'unavailable' = 'unavailable';
  let leadsWarning: string | null = null;

  {
    const client = await queryOne<{ st_api_token: string; st_brand_id: string }>(
      `SELECT st_api_token, st_brand_id FROM clients WHERE id = $1`, [clientId]
    );
    if (client?.st_api_token && client?.st_brand_id) {
      try {
        const st = new SlickTextClient(client.st_api_token, client.st_brand_id);
        const { unmatched } = await autoLinkSlickTextLists(st, parseInt(clientId as string));
        const kits = await query<{ st_list_abandono_id: string | null; st_list_compra_id: string | null }>(
          `SELECT DISTINCT st_list_abandono_id, st_list_compra_id FROM kits WHERE client_id = $1 AND enabled = true`,
          [clientId]
        );

        const abandonoIds = [...new Set(kits.map(k => k.st_list_abandono_id).filter((v): v is string => !!v))];
        const compraIds = [...new Set(kits.map(k => k.st_list_compra_id).filter((v): v is string => !!v))];

        const abandonoCounts = await Promise.all(
          abandonoIds.map(id => st.getListContactCount(parseInt(id)))
        );
        const compraCounts = await Promise.all(
          compraIds.map(id => st.getListContactCount(parseInt(id)))
        );

        abandonoLeads = abandonoCounts.reduce((a, b) => a + b, 0);
        compradorLeads = compraCounts.reduce((a, b) => a + b, 0);
        leadsSource = 'slicktext_list';
        if (unmatched.length > 0) {
          leadsWarning = `${unmatched.length} produto(s) sem lista SlickText vinculada: ${unmatched.map(u => u.kitName).join(', ')}`;
        }
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
  const smsSeg = await queryOne<{
    rec_escopo: string; rec_total: string; compra_escopo: string; compra_total: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY}
        AND product_name IN (SELECT name FROM kits WHERE client_id = $1 AND enabled = true AND st_list_abandono_id IS NOT NULL)) AS rec_escopo,
      COUNT(*) FILTER (WHERE ${SQL_IS_RECOVERY}) AS rec_total,
      COUNT(*) FILTER (WHERE product_name IN (SELECT name FROM kits WHERE client_id = $1 AND enabled = true AND st_list_compra_id IS NOT NULL)) AS compra_escopo,
      COUNT(*) AS compra_total
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND client_id = $1 AND ${SQL_MAILX_SMS}
      ${smsSegPeriod ? `AND ${smsSegPeriod}` : ''}
  `, smsSegParams);
  const smsSegRecoveryCount = parseInt(smsSeg?.rec_escopo || '0');
  const smsSegSalesCount = parseInt(smsSeg?.compra_escopo || '0');
  const smsSegRecoveryFora = parseInt(smsSeg?.rec_total || '0') - smsSegRecoveryCount;
  const smsSegSalesFora = parseInt(smsSeg?.compra_total || '0') - smsSegSalesCount;

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
      COUNT(*) FILTER (WHERE product_name IN (SELECT name FROM kits WHERE client_id = $1 AND enabled = true AND ac_tag_compra_id IS NOT NULL)) AS compra_escopo,
      COUNT(*) AS compra_total
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
    conversao_por_segmento: {
      carrinho_abandonado: {
        leads: abandonoLeads + emailAbandonoLeads,
        vendas: smsSegRecoveryCount + emailSegRecoveryCount,
        vendas_fora_escopo: smsSegRecoveryFora + emailSegRecoveryFora,
        taxa: (abandonoLeads + emailAbandonoLeads) > 0
          ? parseFloat((((smsSegRecoveryCount + emailSegRecoveryCount) / (abandonoLeads + emailAbandonoLeads)) * 100).toFixed(2))
          : 0,
        leads_source: leadsSource,
        leads_warning: leadsWarning,
      },
      compradores: {
        leads: compradorLeads + emailCompradorLeads,
        vendas: smsSegSalesCount + emailSegSalesCount,
        vendas_fora_escopo: smsSegSalesFora + emailSegSalesFora,
        taxa: (compradorLeads + emailCompradorLeads) > 0
          ? parseFloat((((smsSegSalesCount + emailSegSalesCount) / (compradorLeads + emailCompradorLeads)) * 100).toFixed(2))
          : 0,
        leads_source: leadsSource,
        leads_warning: leadsWarning,
      },
    },
    // Isolado por canal — mesmo cálculo, escopado a cada aba (Email/SMS), pedido do Murilo
    // pra bater com a spec ("toda a separação feita isolada para cada aba").
    conversao_por_segmento_sms: {
      carrinho_abandonado: {
        leads: abandonoLeads,
        vendas: smsSegRecoveryCount,
        vendas_fora_escopo: smsSegRecoveryFora,
        taxa: abandonoLeads > 0 ? parseFloat(((smsSegRecoveryCount / abandonoLeads) * 100).toFixed(2)) : 0,
        leads_source: leadsSource,
        leads_warning: leadsWarning,
      },
      compradores: {
        leads: compradorLeads,
        vendas: smsSegSalesCount,
        vendas_fora_escopo: smsSegSalesFora,
        taxa: compradorLeads > 0 ? parseFloat(((smsSegSalesCount / compradorLeads) * 100).toFixed(2)) : 0,
        leads_source: leadsSource,
        leads_warning: leadsWarning,
      },
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

function parseUtmCampaign(campaign: string): { mensagem: string; tipo_automacao: string; produto: string } {
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
  const produto = afterParts[1]?.split('-')[0] ?? '';

  return { mensagem, tipo_automacao, produto };
}

// GET /admin/clientes/:id/sms-granular - SMS performance per automation message
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
      AND utm_medium = 'auto-sms'
      AND utm_source = 'mailx-sms'
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
    // Tem cara de email mas não está sendo atribuída? É o caso que explica "faturamento email = 0".
    suspeita_email_perdido: classificar(r) === 'NAO_ATRIBUIDA' && /mail|email|ac|activecampaign|newsletter|broadcast/i
      .test(`${r.utm_source ?? ''} ${r.utm_medium ?? ''} ${r.utm_campaign ?? ''}`),
  }));

  const soma = (f: (l: typeof linhas[number]) => boolean) => {
    const sel = linhas.filter(f);
    return { vendas: sel.reduce((a, l) => a + l.vendas, 0), receita: Number(sel.reduce((a, l) => a + l.receita, 0).toFixed(2)) };
  };

  res.json({
    periodo: { ativo: period.isToday || !!(period.from && period.to), de: period.from ?? null, ate: period.to ?? null },
    resumo: {
      EMAIL: soma(l => l.classificacao === 'EMAIL'),
      SMS: soma(l => l.classificacao === 'SMS'),
      NAO_ATRIBUIDA: soma(l => l.classificacao === 'NAO_ATRIBUIDA'),
      suspeitas_de_email_perdido: soma(l => l.suspeita_email_perdido),
    },
    combinacoes: linhas,
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
    st_list_compra_id: string | null; st_list_abandono_id: string | null;
    ac_tag_compra_id: string | null; ac_tag_abandono_id: string | null;
  }>(`SELECT id, name, enabled, external_id, st_list_compra_id, st_list_abandono_id,
             ac_tag_compra_id, ac_tag_abandono_id
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
    st_lista_abandono: !!k.st_list_abandono_id,
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
        const data = await st.getWorkflowNodeAnalytics(workflowId, mapping.workflow_node_id, start, end);
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
          count: periodActive && periodCount !== null ? periodCount : (t.messages ?? 0),
          periodCredits,
          clicks: clicksPeriod, // cliques DO PERÍODO (via links) — null quando indisponível
          clicksIsPeriod: clicksPeriod !== null,
          lifetimeClicks: t.clicks ?? 0,
          clicksFieldFound: clicksPeriod !== null,
          capped: periodCapped,
          pages: 1,
          nodeName: data?.workflow_node?.name,
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
      st_list_abandono_id: string | null;
    }>(
      `SELECT name, st_list_compra_id, st_list_abandono_id
       FROM kits WHERE client_id = $1 AND enabled = true`,
      [clientId]
    );

    // Vários SKUs do mesmo produto COMPARTILHAM a mesma lista (confirmado: as três variações de
    // Glyco Pulse apontam para o mesmo par de listas). Buscar por kit contava a mesma lista uma
    // vez por SKU — era o que inflava o card de contatos para várias vezes o tamanho da conta.
    // Aqui cada lista é buscada UMA vez, e o total soma listas distintas.
    const distinctListIds = new Set<number>();
    for (const kit of kits) {
      if (kit.st_list_compra_id) distinctListIds.add(parseInt(kit.st_list_compra_id));
      if (kit.st_list_abandono_id) distinctListIds.add(parseInt(kit.st_list_abandono_id));
    }
    // Um list_id só é válido numa das contas; as outras devolvem 0 (getListContactCount engole o erro).
    const countByList = new Map<number, number>();
    await Promise.all([...distinctListIds].map(async (listId) => {
      const perAccount = await Promise.all(stClients.map(st => st.getListContactCount(listId)));
      countByList.set(listId, perAccount.reduce((a, b) => a + b, 0));
    }));

    const listStats = kits.map((kit) => {
      const compraId = kit.st_list_compra_id ? parseInt(kit.st_list_compra_id) : null;
      const abandonoId = kit.st_list_abandono_id ? parseInt(kit.st_list_abandono_id) : null;
      return {
        product: kit.name,
        compra_list_id: compraId,
        compra_contacts: compraId != null ? (countByList.get(compraId) ?? 0) : 0,
        abandono_list_id: abandonoId,
        abandono_contacts: abandonoId != null ? (countByList.get(abandonoId) ?? 0) : 0,
      };
    });

    // Totais por LISTA DISTINTA — nunca somando a mesma lista mais de uma vez.
    const compraListIds = new Set(kits.map(k => k.st_list_compra_id).filter(Boolean).map(v => parseInt(v as string)));
    const abandonoListIds = new Set(kits.map(k => k.st_list_abandono_id).filter(Boolean).map(v => parseInt(v as string)));
    const totalCompra = [...compraListIds].reduce((sum, id) => sum + (countByList.get(id) ?? 0), 0);
    const totalAbandono = [...abandonoListIds].reduce((sum, id) => sum + (countByList.get(id) ?? 0), 0);

    // ── SMS-attributed sales KPIs (UTM contains 'mailxsms') — respeita o período de análise ──
    const period = resolvePeriodFilter(req);
    const periodActive = period.isToday || !!(period.from && period.to);
    const smsSalesParams: (string | number)[] = [clientId];
    const smsSalesPeriod = periodSql(period, smsSalesParams);
    const smsSales = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND client_id = $1
        AND ${SQL_MAILX_SMS}
        ${smsSalesPeriod ? `AND ${smsSalesPeriod}` : ''}
    `, smsSalesParams);
    const smsRecParams: (string | number)[] = [clientId];
    const smsRecPeriod = periodSql(period, smsRecParams);
    const smsRecoveries = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND client_id = $1
        AND ${SQL_MAILX_SMS}
        AND ${SQL_IS_RECOVERY}
        ${smsRecPeriod ? `AND ${smsRecPeriod}` : ''}
    `, smsRecParams);
    const smsUpsellParams: (string | number)[] = [clientId];
    const smsUpsellPeriod = periodSql(period, smsUpsellParams);
    const smsUpsell = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND client_id = $1
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

