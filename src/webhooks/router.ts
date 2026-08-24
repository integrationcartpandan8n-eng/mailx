import { Router } from 'express';
import { handleOrderPaid } from './order-paid.handler';
import { handleAbandonedCart } from './abandoned-cart.handler';
import { handleCardDeclined } from './card-declined.handler';
import { handleDS24Payment } from './digistore24-payment.handler';
import { handleDS24Refund } from './digistore24-refund.handler';
import { handleDS24Afiliado } from './digistore24-afiliado.handler';
import { handleClickBankPayment } from './clickbank-payment.handler';
import { handleClickBankRefund } from './clickbank-refund.handler';
import { logger } from '../utils/logger';
import { query } from '../db/database';

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

// Sem banco, RECUSA com 503 em vez de aceitar e perder.
//
// O que acontecia: cada handler grava dentro de `if (isDatabaseReady())` e SEGUE quando o banco
// está fora — respondendo 200 para o gateway. Ou seja, a venda era aceita, não gravada, e a
// Digistore ouvia "ok" e nunca reenviava. Nas 46 horas em que a aplicação ficou sem reconectar
// (03 a 05/08), cada venda foi confirmada e jogada fora, sem linha no banco e sem erro em lugar
// nenhum — não havia como nem saber quantas.
//
// 503 muda a natureza da falha: gateway de pagamento reenvia em erro 5xx. Perda de dado vira
// entrega adiada, e o que chega depois entra completo.
//
// Usa uma consulta trivial em vez de ler isDatabaseReady() direto: a reconexão automática mora
// dentro de query(), então checar a flag sem consultar devolveria 503 para sempre, sem nunca
// tentar reconectar. Uma linha de custo desprezível que também destrava o banco.
webhookRouter.use(async (req, res, next) => {
  if (req.path === '/health') return next();
  try {
    await query('SELECT 1');
    next();
  } catch (err: any) {
    logger.error(CTX, `Banco indisponível — recusando ${req.method} ${req.path} com 503 para o gateway reenviar: ${err.message}`);
    res.status(503).json({
      error: 'Database unavailable',
      detalhe: 'Recusado de propósito para o gateway reenviar depois. Nenhuma venda é perdida.',
    });
  }
});

// ── CartPanda webhook routes ──
webhookRouter.post('/cartpanda/order-paid', handleOrderPaid);
webhookRouter.post('/cartpanda/abandoned-cart', handleAbandonedCart);
webhookRouter.post('/cartpanda/card-declined', handleCardDeclined);

// ── Digistore24 IPN webhook routes ──
webhookRouter.post('/digistore24/payment', handleDS24Payment);
webhookRouter.post('/digistore24/refund', handleDS24Refund);

// ── Digistore24 Affiliate S2S Postback (conta skill99) ──
// GET, não POST: é a Digistore substituindo placeholders na URL de postback que a gente definiu,
// não um payload form-encoded como o IPN do produtor acima.
webhookRouter.get('/digistore24-afiliado/:token', handleDS24Afiliado);

// ── ClickBank INS webhook routes ──
webhookRouter.post('/clickbank/payment', handleClickBankPayment);
webhookRouter.post('/clickbank/refund', handleClickBankRefund);

// Health check for webhook endpoint
webhookRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
