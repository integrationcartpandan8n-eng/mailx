import { Router } from 'express';
import { handleOrderPaid } from './order-paid.handler';
import { handleAbandonedCart } from './abandoned-cart.handler';
import { handleDS24Payment } from './digistore24-payment.handler';
import { handleDS24Refund } from './digistore24-refund.handler';
import { logger } from '../utils/logger';

const CTX = 'Webhooks';

export const webhookRouter = Router();

// Middleware: log all incoming webhooks
webhookRouter.use((req, _res, next) => {
  logger.info(CTX, `Incoming ${req.method} ${req.path}`, {
    ip: req.ip,
    contentType: req.headers['content-type'],
  });
  next();
});

// ── CartPanda webhook routes ──
webhookRouter.post('/cartpanda/order-paid', handleOrderPaid);
webhookRouter.post('/cartpanda/abandoned-cart', handleAbandonedCart);

// ── Digistore24 IPN webhook routes ──
webhookRouter.post('/digistore24/payment', handleDS24Payment);
webhookRouter.post('/digistore24/refund', handleDS24Refund);

// Health check for webhook endpoint
webhookRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
