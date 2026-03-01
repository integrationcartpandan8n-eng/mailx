import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { query, isDatabaseReady, queryOne } from '../db/database';
import { logger } from '../utils/logger';
import { runBootstrap, generateDnsRecords } from '../setup/bootstrap-service';

const CTX = 'Admin';

export const adminRouter = Router();

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
  // Get real counts if available
  const clientsCount = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM clients`);
  const webhooksToday = await queryOne<{ count: string }>(
    `SELECT COUNT(*) FROM webhook_logs WHERE created_at >= CURRENT_DATE`
  );

  const totalClients = parseInt(clientsCount?.count || '0');
  const totalWebhooks = parseInt(webhooksToday?.count || '0');

  // Demo data blended with real metrics
  const last30Days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (29 - i));
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  });

  res.json({
    kpis: {
      faturamento_aprovado: 'R$ 87.450',
      faturamento_change: '+12.5%',
      vendas_totais: '1.247',
      vendas_change: '+8.3%',
      ticket_medio: 'R$ 70,09',
      taxa_reembolso: '2.4%',
      faturamento_mailx: 'R$ 24.890',
      faturamento_mailx_change: '+18.7%',
      vendas_mailx: '356',
      vendas_mailx_change: '+15.2%',
      total_clients: totalClients,
      webhooks_today: totalWebhooks,
    },
    charts: {
      revenue: {
        labels: last30Days,
        automacoes: Array.from({ length: 30 }, () => Math.floor(Math.random() * 4000 + 1000)),
        campanhas: Array.from({ length: 30 }, () => Math.floor(Math.random() * 3000 + 500)),
      },
      hourly: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`),
        values: [2, 1, 0, 0, 1, 3, 8, 15, 22, 35, 42, 38, 45, 40, 32, 28, 25, 18, 12, 8, 5, 4, 3, 2],
      },
      top_products: {
        labels: ['Kit Emagrecedor Plus', 'Kit Detox Premium', 'Kit Beleza Total', 'Kit Imunidade', 'Kit Energia'],
        values: [342, 287, 215, 178, 134],
      },
      top_tags: {
        labels: ['comprou-kit-emagrecedor', 'lead-engajado', 'carrinho-abandonado', 'newsletter-ativo', 'comprou-kit-detox'],
        values: [892, 756, 534, 423, 389],
      },
    },
  });
}));

// GET /admin/dashboard/history - Historical KPIs
adminRouter.get('/dashboard/history', asyncHandler(async (_req: Request, res: Response) => {
  const months = ['Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez', 'Jan', 'Fev'];

  res.json({
    sales: {
      faturamento: 'R$ 342.800',
      faturamento_change: '+22.1%',
      comissoes_mailx: 'R$ 51.420',
      vendas: '4.891',
      ticket_medio: 'R$ 70,09',
    },
    email: {
      entrada_contatos: '12.847',
      contatos_change: '+31.4%',
      ctr: '4.2%',
      taxa_abertura: '28.7%',
      ctor: '14.6%',
      rpm: 'R$ 18,40',
      epc: 'R$ 2,35',
    },
    charts: {
      email_perf: {
        labels: months,
        open_rate: [24.1, 25.3, 26.8, 27.2, 28.1, 26.9, 27.5, 28.3, 29.1, 28.7, 29.4, 28.7],
        ctr: [3.1, 3.4, 3.6, 3.8, 4.0, 3.9, 4.1, 4.3, 4.5, 4.2, 4.4, 4.2],
      },
      contacts: {
        labels: months,
        values: [780, 920, 1050, 1180, 1320, 1100, 1250, 1380, 1420, 1290, 1350, 1307],
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
