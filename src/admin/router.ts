import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query, isDatabaseReady, queryOne } from '../db/database';
import { logger } from '../utils/logger';
import { runBootstrap, generateDnsRecords } from '../setup/bootstrap-service';
import { env } from '../config/env';

const CTX = 'Admin';

export const adminRouter = Router();

// ── Session Management (in-memory, httpOnly cookies) ──
const sessions = new Map<string, { createdAt: number }>();
const SESSION_COOKIE = 'mailx_session';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((c) => {
    const [key, ...val] = c.trim().split('=');
    cookies[key] = val.join('=');
  });
  return cookies;
}

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
  
  if (password === env.ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { createdAt: Date.now() });
    
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/admin; Max-Age=${SESSION_TTL / 1000}; SameSite=Strict`);
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
  if (token) sessions.delete(token);
  
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/admin; Max-Age=0`);
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

// GET /admin/dashboard/overview - Overview KPIs + chart data (REAL DATA)
adminRouter.get('/dashboard/overview', asyncHandler(async (_req: Request, res: Response) => {
  // ── Real counts ──
  const clientsCount = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM clients`);
  const clientsActive = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM clients WHERE status = 'active'`);
  const webhooksTotal = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM webhook_logs`);
  const webhooksToday = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE created_at >= CURRENT_DATE`
  );
  const webhooksProcessed = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE status = 'processed'`
  );
  const webhooksError = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE status = 'error'`
  );
  const kitsCount = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM kits`);
  const storesCount = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM store_integrations WHERE status = 'active'`);

  // ── Webhooks per day (last 30 days) ──
  const dailyWebhooks = await query<{ day: string, order_paid: string, abandoned: string }>(`
    SELECT 
      TO_CHAR(created_at, 'DD/MM') as day,
      COUNT(*) FILTER (WHERE event_type = 'order.paid') as order_paid,
      COUNT(*) FILTER (WHERE event_type = 'abandoned_cart') as abandoned
    FROM webhook_logs 
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY TO_CHAR(created_at, 'DD/MM'), DATE(created_at)
    ORDER BY DATE(created_at)
  `);

  // Fill 30 days with zeros where no data
  const last30Days: string[] = [];
  const orderPaidData: number[] = [];
  const abandonedData: number[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    last30Days.push(label);
    const match = dailyWebhooks.find(r => r.day === label);
    orderPaidData.push(match ? parseInt(match.order_paid) : 0);
    abandonedData.push(match ? parseInt(match.abandoned) : 0);
  }

  // ── Webhooks by hour (all time) ──
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

  // ── Top kits by webhook mentions ──
  const topKits = await query<{ name: string, count: string }>(`
    SELECT k.name, COUNT(w.id) as count
    FROM kits k
    LEFT JOIN webhook_logs w ON w.payload::text ILIKE '%' || k.slug || '%'
    GROUP BY k.name
    ORDER BY count DESC
    LIMIT 5
  `);

  // ── Webhook event distribution ──
  const eventDist = await query<{ event_type: string, count: string }>(`
    SELECT event_type, COUNT(*) as count
    FROM webhook_logs
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 5
  `);

  const totalWh = parseInt(webhooksTotal?.count || '0');
  const totalProc = parseInt(webhooksProcessed?.count || '0');
  const totalErr = parseInt(webhooksError?.count || '0');
  const successRate = totalWh > 0 ? ((totalProc / totalWh) * 100).toFixed(1) : '0';

  res.json({
    kpis: {
      total_clients: parseInt(clientsCount?.count || '0'),
      active_clients: parseInt(clientsActive?.count || '0'),
      webhooks_today: parseInt(webhooksToday?.count || '0'),
      webhooks_total: totalWh,
      webhooks_processed: totalProc,
      webhooks_error: totalErr,
      success_rate: `${successRate}%`,
      total_kits: parseInt(kitsCount?.count || '0'),
      active_stores: parseInt(storesCount?.count || '0'),
    },
    charts: {
      revenue: {
        labels: last30Days,
        automacoes: orderPaidData,
        campanhas: abandonedData,
      },
      hourly: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`),
        values: hourlyValues,
      },
      top_products: {
        labels: topKits.length > 0 ? topKits.map(k => k.name) : ['Nenhum kit'],
        values: topKits.length > 0 ? topKits.map(k => parseInt(k.count)) : [0],
      },
      top_tags: {
        labels: eventDist.length > 0 ? eventDist.map(e => e.event_type) : ['Nenhum evento'],
        values: eventDist.length > 0 ? eventDist.map(e => parseInt(e.count)) : [0],
      },
    },
  });
}));

// GET /admin/dashboard/history - Historical KPIs (REAL DATA)
adminRouter.get('/dashboard/history', asyncHandler(async (_req: Request, res: Response) => {
  // ── Monthly webhook activity (last 12 months) ──
  const monthlyActivity = await query<{ month: string, total: string, order_paid: string, abandoned: string }>(`
    SELECT 
      TO_CHAR(created_at, 'Mon') as month,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE event_type = 'order.paid') as order_paid,
      COUNT(*) FILTER (WHERE event_type = 'abandoned_cart') as abandoned
    FROM webhook_logs
    WHERE created_at >= NOW() - INTERVAL '12 months'
    GROUP BY TO_CHAR(created_at, 'Mon'), DATE_TRUNC('month', created_at)
    ORDER BY DATE_TRUNC('month', created_at)
  `);

  // ── Monthly new clients ──
  const monthlyClients = await query<{ month: string, count: string }>(`
    SELECT TO_CHAR(created_at, 'Mon') as month, COUNT(*) as count
    FROM clients
    WHERE created_at >= NOW() - INTERVAL '12 months'
    GROUP BY TO_CHAR(created_at, 'Mon'), DATE_TRUNC('month', created_at)
    ORDER BY DATE_TRUNC('month', created_at)
  `);

  // ── Totals ──
  const totalWebhooks = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM webhook_logs`);
  const totalOrderPaid = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM webhook_logs WHERE event_type = 'order.paid'`);
  const totalAbandoned = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM webhook_logs WHERE event_type = 'abandoned_cart'`);
  const totalClients = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM clients`);
  const totalKits = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM kits`);

  // ── Client status distribution ──
  const statusDist = await query<{ status: string, count: string }>(`
    SELECT status, COUNT(*) as count FROM clients GROUP BY status ORDER BY count DESC
  `);

  const months = monthlyActivity.map(m => m.month);
  const monthsClients = monthlyClients.map(m => m.month);

  res.json({
    sales: {
      webhooks_total: parseInt(totalWebhooks?.count || '0'),
      order_paid_total: parseInt(totalOrderPaid?.count || '0'),
      abandoned_total: parseInt(totalAbandoned?.count || '0'),
      total_clients: parseInt(totalClients?.count || '0'),
      total_kits: parseInt(totalKits?.count || '0'),
    },
    email: {
      status_distribution: statusDist.map(s => ({ status: s.status, count: parseInt(s.count) })),
    },
    charts: {
      email_perf: {
        labels: months.length > 0 ? months : ['Sem dados'],
        open_rate: monthlyActivity.map(m => parseInt(m.order_paid)),
        ctr: monthlyActivity.map(m => parseInt(m.abandoned)),
      },
      contacts: {
        labels: monthsClients.length > 0 ? monthsClients : ['Sem dados'],
        values: monthlyClients.length > 0 ? monthlyClients.map(m => parseInt(m.count)) : [0],
      },
    },
  });
}));

// ── Store Integration Endpoints ──

// POST /admin/integration/store - Save new store integration
adminRouter.post('/integration/store', asyncHandler(async (req: Request, res: Response) => {
  const { shop_slug, api_token, events } = req.body;

  if (!shop_slug || !api_token) {
    res.status(400).json({ error: 'shop_slug and api_token are required' });
    return;
  }

  logger.info(CTX, `New store integration: ${shop_slug}`, { events });

  // Store the integration in the database
  await query(
    `INSERT INTO store_integrations (shop_slug, api_token, events, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (shop_slug) DO UPDATE SET api_token = $2, events = $3, updated_at = NOW()`,
    [shop_slug, api_token, JSON.stringify(events || {}), 'active']
  );

  res.json({ ok: true, shop_slug });
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
  const { shop_slug, api_token, events } = req.body;

  if (!shop_slug || !api_token) {
    res.status(400).json({ error: 'shop_slug and api_token are required' });
    return;
  }

  await query(
    `INSERT INTO store_integrations (client_id, shop_slug, api_token, events, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (shop_slug) DO UPDATE SET api_token = $3, events = $4, client_id = $1, updated_at = NOW()`,
    [clientId, shop_slug, api_token, JSON.stringify(events || {}), 'active']
  );

  logger.info(CTX, `Store "${shop_slug}" integrated for client ${clientId}`);
  res.json({ ok: true, shop_slug });
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
