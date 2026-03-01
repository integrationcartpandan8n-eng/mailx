import express from 'express';
import path from 'path';
import fs from 'fs';
import { env } from './config/env';
import { initDatabase, isDatabaseReady } from './db/database';
import { webhookRouter } from './webhooks/router';
import { onboardingRouter } from './onboarding/router';
import { adminRouter } from './admin/router';
import { logger } from './utils/logger';

const CTX = 'Server';

async function main() {
  // Try to initialize database (non-blocking — server starts even if DB is down)
  await initDatabase();

  const app = express();

  // ── Middleware ──
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // Static files
  const publicDir = fs.existsSync(path.join(process.cwd(), 'src', 'public'))
    ? path.join(process.cwd(), 'src', 'public')
    : path.join(__dirname, 'public');
  app.use('/public', express.static(publicDir));

  // Request logging
  app.use((req, _res, next) => {
    if (!req.path.startsWith('/health')) {
      logger.debug(CTX, `${req.method} ${req.path}`);
    }
    next();
  });

  // ── Routes ──

  // Webhook endpoints (api.mailxgroup.com)
  app.use('/webhook', webhookRouter);

  // Onboarding form (app.mailxgroup.com)
  app.use('/onboarding', onboardingRouter);

  // Admin API (app.mailxgroup.com)
  app.use('/admin', adminRouter);

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      env: env.NODE_ENV,
      database: isDatabaseReady() ? 'connected' : 'disconnected',
    });
  });

  // Root
  app.get('/', (_req, res) => {
    res.json({
      name: 'MailX Server',
      version: '1.0.0',
      database: isDatabaseReady() ? 'connected' : 'disconnected',
      endpoints: {
        health: '/health',
        webhooks: '/webhook/health',
        onboarding: '/onboarding',
        admin: '/admin/clientes',
      },
    });
  });

  // ── Global error handler ──
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(CTX, 'Unhandled error', { message: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  // ── Start ──
  app.listen(env.PORT, () => {
    logger.info(CTX, `🚀 MailX server running on port ${env.PORT}`);
    logger.info(CTX, `   Environment: ${env.NODE_ENV}`);
    logger.info(CTX, `   Database:    ${isDatabaseReady() ? '✅ connected' : '⚠️ not connected'}`);
    logger.info(CTX, `   Webhooks:    http://localhost:${env.PORT}/webhook/health`);
    logger.info(CTX, `   Onboarding:  http://localhost:${env.PORT}/onboarding`);
    logger.info(CTX, `   Admin:       http://localhost:${env.PORT}/admin/clientes`);
  });
}

main().catch((err) => {
  logger.error(CTX, 'Failed to start server', err);
  process.exit(1);
});
