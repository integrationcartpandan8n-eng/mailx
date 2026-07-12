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

const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  `);
  // MailX attribution: sales where utm contains 'mailx' (case-insensitive)
  const salesDataMailx = await queryOne<{ count: string, total_revenue: string }>(`
    SELECT 
      COUNT(*) as count,
      ${SQL_REVENUE} as total_revenue
    FROM webhook_logs 
    WHERE event_type = 'order.paid' AND status = 'processed'
      AND ${SQL_IS_MAILX}
  `);
  // MailX abandoned cart recoveries: MailX attribution + recovery UTM
  const mailxRecoveries = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count,
      ${SQL_REVENUE} as revenue
    FROM webhook_logs
    WHERE event_type = 'order.paid' AND status = 'processed'
      AND ${SQL_IS_MAILX}
      AND ${SQL_IS_RECOVERY}
  `);
  const refundCount = await queryOne<{ count: string }>(`
    SELECT COUNT(*) FROM webhook_logs WHERE event_type = 'order.refunded'
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
    GROUP BY product_name ORDER BY count DESC LIMIT 5
  `);

  // ── Top 5 Tags ──
  const eventDist = await query<{ event_type: string, count: string }>(`
    SELECT event_type, COUNT(*) as count
    FROM webhook_logs
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 5
  `);

  // ── Conversion Funnel (envios/cliques por venda) ──
  const totalWebhooks = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM webhook_logs`);
  const totalWh = parseInt(totalWebhooks?.count || '0');
  const enviosPorVenda = totalSales > 0 ? Math.round(totalWh / totalSales) : 0;

  // Format currency
  const fmtBRL = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  const fromDate = parseYmd(from);
  const toDate = parseYmd(to);
  if (fromDate > toDate) {
    res.status(400).json({ error: 'from must be <= to' });
    return;
  }

  const dayCount = Math.round((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  if (dayCount > 366) {
    res.status(400).json({ error: 'Date range cannot exceed 366 days' });
    return;
  }

  const channelExtra = channel === 'email' ? `AND NOT ${SQL_IS_SMS}` : '';
  const params: (string | number)[] = [from, to];
  let clientFilter = '';
  if (clientId) {
    const cid = parseInt(clientId, 10);
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
      AND created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
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

  res.json({ labels, total, automacao, campanha, recuperacao, upsell });
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

  const params: (string | number)[] = [from, to];
  let clientFilter = '';
  if (clientId) {
    const cid = parseInt(clientId, 10);
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
    WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
      ${clientFilter}
  `, params);

  res.json({
    aprovado: parseFloat(row?.aprovado || '0'),
    reembolso: parseFloat(row?.reembolso || '0'),
    chargeback_custo: parseFloat(row?.chargeback_custo || '0'),
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

  const fmtBRL = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  const fmtBRL = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  // SlickText aggregated across all clients with credentials
  const clientsWithSt = await query<{ id: number; st_api_token: string; st_brand_id: string }>(
    `SELECT id, st_api_token, st_brand_id FROM clients WHERE st_api_token IS NOT NULL AND st_brand_id IS NOT NULL`
  );

  const stTotals = { contacts: 0, total_credits: 0, credits_used: 0, credits_available: 0, lists: 0 };
  for (const c of clientsWithSt) {
    try {
      const st = new SlickTextClient(c.st_api_token, c.st_brand_id);
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
      logger.warn(CTX, `Dashboard sms: SlickText fetch failed for client ${c.id}: ${err.message}`);
    }
  }

  const fmtBRL = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    clients_with_st: clientsWithSt.length,
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

  const fmtBRL = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    SELECT c.*,
      (SELECT json_agg(k.*) FROM kits k WHERE k.client_id = c.id) as kits
    FROM clients c
    ORDER BY c.created_at DESC
  `);
  res.json({ count: clients.length, clients });
}));

// GET /admin/clientes/:id - Single client
adminRouter.get('/clientes/:id', asyncHandler(async (req: Request, res: Response) => {
  const clients = await query(`
    SELECT c.*,
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
  const clientId = req.params.id;

  // Get all store slugs for this client to filter webhook_logs
  const stores = await query<{ shop_slug: string, platform: string }>(
    `SELECT shop_slug, COALESCE(platform, 'cartpanda') as platform FROM store_integrations WHERE client_id = $1`,
    [clientId]
  );

  // Sales KPIs — filtered by client_id
  const salesData = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND status IN ('processed', 'processing') AND client_id = $1
  `, [clientId]);

  const totalWebhooks = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE client_id = $1`, [clientId]
  );
  const webhooksToday = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE created_at >= CURRENT_DATE AND client_id = $1`, [clientId]
  );
  const webhooksProcessed = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE status = 'processed' AND client_id = $1`, [clientId]
  );
  const webhooksFailed = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE status = 'failed' AND client_id = $1`, [clientId]
  );
  const refundCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE event_type IN ('order.refunded', 'order.chargeback') AND client_id = $1`, [clientId]
  );

  const totalSales = parseInt(salesData?.count || '0');
  const totalRevenue = parseFloat(salesData?.revenue || '0');
  const ticketMedio = totalSales > 0 ? totalRevenue / totalSales : 0;
  const totalWh = parseInt(totalWebhooks?.count || '0');
  const abandonedCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE event_type = 'abandoned_cart' AND client_id = $1`, [clientId]
  );
  const declinedCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE event_type = 'card.declined' AND client_id = $1`, [clientId]
  );
  const abandoned = parseInt(abandonedCount?.count || '0');
  const declined = parseInt(declinedCount?.count || '0');
  const totalOpps = totalSales + abandoned + declined;
  const successRate = totalOpps > 0 ? ((totalSales / totalOpps) * 100).toFixed(1) : '0';

  // MailX UTM metrics — filtered by client_id
  const mailxData = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_IS_MAILX}
  `, [clientId]);
  const mailxRecoveries = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_IS_MAILX}
      AND ${SQL_IS_RECOVERY}
  `, [clientId]);

  const emailMailxData = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_MAILX_EMAIL}
  `, [clientId]);
  const emailMailxRecoveries = await queryOne<{ count: string, revenue: string }>(`
    SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
    FROM webhook_logs WHERE event_type = 'order.paid' AND client_id = $1
      AND ${SQL_MAILX_EMAIL}
      AND ${SQL_IS_RECOVERY}
  `, [clientId]);

  // Top 5 products — filtered by client_id
  const topProducts = await query<{ name: string, count: string, revenue: string }>(`
    SELECT 
      product_name as name,
      COUNT(*) as count,
      ${SQL_REVENUE} as revenue
    FROM webhook_logs 
    WHERE event_type = 'order.paid' AND client_id = $1
      AND product_name IS NOT NULL
    GROUP BY product_name ORDER BY count DESC LIMIT 5
  `, [clientId]);

  // Recent webhooks — filtered by client_id
  const recentWebhooks = await query(`
    SELECT id, event_type, source, status, error, created_at, processed_at
    FROM webhook_logs
    WHERE client_id = $1
    ORDER BY created_at DESC
    LIMIT 10
  `, [clientId]);

  // Daily activity last 7 days — filtered by client_id
  const dailyActivity = await query<{ day: string, count: string }>(`
    SELECT TO_CHAR(created_at, 'DD/MM') as day, COUNT(*) as count
    FROM webhook_logs
    WHERE created_at >= NOW() - INTERVAL '7 days' AND client_id = $1
    GROUP BY TO_CHAR(created_at, 'DD/MM'), DATE(created_at)
    ORDER BY DATE(created_at)
  `, [clientId]);

  // ── Webhooks by hour ──
  const hourlyWebhooks = await query<{ hour: string, count: string }>(`
    SELECT EXTRACT(HOUR FROM created_at)::text as hour, COUNT(*) as count
    FROM webhook_logs
    WHERE client_id = $1
    GROUP BY EXTRACT(HOUR FROM created_at)
    ORDER BY EXTRACT(HOUR FROM created_at)
  `, [clientId]);
  const hourlyValues = Array.from({ length: 24 }, (_, i) => {
    const match = hourlyWebhooks.find(r => parseInt(r.hour) === i);
    return match ? parseInt(match.count) : 0;
  });

  // ── Top 5 Tags (event type distribution) ──
  const eventDist = await query<{ event_type: string, count: string }>(`
    SELECT event_type, COUNT(*) as count
    FROM webhook_logs
    WHERE client_id = $1
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 5
  `, [clientId]);

  // ── Conversion Funnel (envios por venda) ──
  const enviosPorVenda = totalSales > 0 ? Math.round(totalWh / totalSales) : 0;

  const fmtBRL = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Conversão por Segmento: leads de abandono (CartPanda evento vs SlickText lista) ──
  const hasCartPanda = stores.some(s => (s.platform || 'cartpanda') === 'cartpanda');

  let abandonoLeads = abandoned;
  let leadsSource: 'cartpanda_event' | 'slicktext_list' | 'unavailable' = hasCartPanda ? 'cartpanda_event' : 'unavailable';
  let leadsWarning: string | null = null;

  if (!hasCartPanda) {
    try {
      const client = await queryOne<{ st_api_token: string; st_brand_id: string }>(
        `SELECT st_api_token, st_brand_id FROM clients WHERE id = $1`, [clientId]
      );
      if (client?.st_api_token && client?.st_brand_id) {
        const st = new SlickTextClient(client.st_api_token, client.st_brand_id);
        const { unmatched } = await autoLinkSlickTextLists(st, parseInt(clientId as string));
        const kits = await query<{ st_list_abandono_id: string | null }>(
          `SELECT DISTINCT st_list_abandono_id FROM kits WHERE client_id = $1 AND st_list_abandono_id IS NOT NULL`,
          [clientId]
        );
        const counts = await Promise.all(
          kits.map(k => st.getListContactCount(parseInt(k.st_list_abandono_id!)).catch(() => 0))
        );
        abandonoLeads = counts.reduce((a, b) => a + b, 0);
        leadsSource = 'slicktext_list';
        if (unmatched.length > 0) {
          leadsWarning = `${unmatched.length} produto(s) sem lista SlickText vinculada: ${unmatched.map(u => u.kitName).join(', ')}`;
        }
      } else {
        leadsWarning = 'SlickText não configurado — Leads de Carrinho Abandonado indisponível para este gateway';
      }
    } catch (err: any) {
      logger.error('Admin', `Falha ao buscar leads via SlickText (client ${clientId}): ${err.message}`);
      leadsSource = 'unavailable';
      leadsWarning = 'Falha ao consultar SlickText — Leads de Carrinho Abandonado temporariamente indisponível';
    }
  }

  const mailxRecoveryCount = parseInt(mailxRecoveries?.count || '0');

  // ── Email Marketing KPIs (ActiveCampaign reporting, last 30 days) ──
  const emailMetrics = {
    entrada_contatos: '--' as string,
    ctr: '--' as string,
    taxa_abertura: '--' as string,
    ctor: '--' as string,
    rpm: '--' as string,
    epc: '--' as string,
  };
  const acCreds = await queryOne<{ ac_api_url: string | null; ac_api_key: string | null }>(
    `SELECT ac_api_url, ac_api_key FROM clients WHERE id = $1`, [clientId]
  );
  if (acCreds?.ac_api_url && acCreds?.ac_api_key) {
    try {
      const ac = new ActiveCampaignClient(acCreds.ac_api_url, acCreds.ac_api_key);
      const [agg, newContacts] = await Promise.all([
        ac.getCampaignsAggregate(30),
        ac.getNewContactsCount(30),
      ]);
      const mailxRev = parseFloat(mailxData?.revenue || '0');
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
    } catch (err: any) {
      logger.warn(CTX, `Failed to fetch AC stats for client ${clientId}: ${err.message}`);
    }
  }

  res.json({
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
      recuperacoes_email: parseInt(emailMailxRecoveries?.count || '0'),
      faturamento_recuperacoes_email: fmtBRL(parseFloat(emailMailxRecoveries?.revenue || '0')),
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
    conversao_por_segmento: {
      carrinho_abandonado: {
        leads: abandonoLeads,
        vendas: mailxRecoveryCount,
        taxa: leadsSource === 'slicktext_list'
          ? null
          : abandonoLeads > 0
            ? parseFloat(((mailxRecoveryCount / abandonoLeads) * 100).toFixed(2))
            : 0,
        leads_source: leadsSource,
        leads_warning: leadsWarning,
      },
      compradores: {
        leads: totalSales,
        vendas: parseInt(mailxData?.count || '0'),
        taxa: totalSales > 0
          ? parseFloat(((parseInt(mailxData?.count || '0') / totalSales) * 100).toFixed(2))
          : 0,
      },
    },
    metrics_only: METRICS_ONLY,
  });
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
  const clientId = req.params.id;

  // Get client's SlickText credentials
  const client = await queryOne<{ st_api_token: string; st_brand_id: string }>(
    `SELECT st_api_token, st_brand_id FROM clients WHERE id = $1`,
    [clientId]
  );

  if (!client?.st_api_token || !client?.st_brand_id) {
    res.json({
      configured: false,
      error: 'SlickText not configured for this client',
    });
    return;
  }

  try {
    const st = new SlickTextClient(client.st_api_token, client.st_brand_id);

    // Fetch all data in parallel
    const [
      contactAnalytics,
      messageAnalytics,
      creditAnalytics,
      brandUsage,
      lists,
    ] = await Promise.all([
      st.getContactAnalytics().catch(() => null),
      st.getMessageAnalytics().catch(() => null),
      st.getCreditAnalytics().catch(() => null),
      st.getBrandUsage().catch(() => null),
      st.getLists().catch(() => []),
    ]);

    // Get contact count for each list (product lists)
    const kits = await query<{
      name: string;
      st_list_compra_id: string | null;
      st_list_abandono_id: string | null;
    }>(
      `SELECT name, st_list_compra_id, st_list_abandono_id FROM kits WHERE client_id = $1`,
      [clientId]
    );

    const listStats: Array<{
      product: string;
      compra_list_id: number | null;
      compra_contacts: number;
      abandono_list_id: number | null;
      abandono_contacts: number;
    }> = [];

    for (const kit of kits) {
      const compraId = kit.st_list_compra_id ? parseInt(kit.st_list_compra_id) : null;
      const abandonoId = kit.st_list_abandono_id ? parseInt(kit.st_list_abandono_id) : null;

      const [compraCount, abandonoCount] = await Promise.all([
        compraId ? st.getListContactCount(compraId) : Promise.resolve(0),
        abandonoId ? st.getListContactCount(abandonoId) : Promise.resolve(0),
      ]);

      listStats.push({
        product: kit.name,
        compra_list_id: compraId,
        compra_contacts: compraCount,
        abandono_list_id: abandonoId,
        abandono_contacts: abandonoCount,
      });
    }

    const totalCompra = listStats.reduce((sum, l) => sum + l.compra_contacts, 0);
    const totalAbandono = listStats.reduce((sum, l) => sum + l.abandono_contacts, 0);

    // ── SMS-attributed sales KPIs (UTM contains 'mailxsms') ──
    const smsSales = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND client_id = $1
        AND ${SQL_MAILX_SMS}
    `, [clientId]);
    const smsRecoveries = await queryOne<{ count: string; revenue: string }>(`
      SELECT COUNT(*) as count, ${SQL_REVENUE} as revenue
      FROM webhook_logs
      WHERE event_type = 'order.paid' AND client_id = $1
        AND ${SQL_MAILX_SMS}
        AND ${SQL_IS_RECOVERY}
    `, [clientId]);

    const fmtBRL = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const smsRevenue = parseFloat(smsSales?.revenue || '0');
    const smsRecRevenue = parseFloat(smsRecoveries?.revenue || '0');

    res.json({
      configured: true,
      revenue: {
        faturamento_sms: fmtBRL(smsRevenue),
        vendas_sms: parseInt(smsSales?.count || '0'),
        recuperacoes_sms: parseInt(smsRecoveries?.count || '0'),
        faturamento_recuperacoes_sms: fmtBRL(smsRecRevenue),
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

