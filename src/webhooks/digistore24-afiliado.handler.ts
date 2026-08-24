/**
 * Digistore24 Affiliate S2S Postback Handler (conta skill99)
 * Endpoint: GET /webhook/digistore24-afiliado/:token
 *
 * Diferente do webhook do produtor (POST, form-encoded, assinado com sha_sign): o lado de afiliado
 * da Digistore24 não tem assinatura nenhuma (confirmado com o suporte deles) — só GET com os
 * parâmetros que A GENTE escolheu na hora de montar a URL de postback, substituídos por eles antes
 * de disparar. A única defesa possível é o token no caminho da própria URL ficar em segredo — por
 * isso a comparação abaixo é em tempo constante, e sem DIGISTORE24_AFILIADO_TOKEN configurado o
 * handler recusa TUDO (fail closed), nunca aceita "sem token = ok".
 *
 * Grava-primeiro-processa-depois, mesmo espírito do handler do produtor: aqui é ainda mais crítico,
 * porque a Digistore24 confirmou que NÃO existe backfill automático do lado de afiliado — se um
 * evento falhar, só o suporte deles reenvia manualmente, e só se pedirmos a tempo. Por isso este
 * handler não faz enriquecimento nenhum (sem ActiveCampaign, sem SlickText) — só grava o evento
 * cru, o mais rápido e com a menor chance de erro possível antes do INSERT.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { query } from '../db/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const CTX = 'Webhook:DS24:Afiliado';

/** Compara em tempo constante — timingSafeEqual exige os dois buffers do MESMO tamanho, então
 * compara o tamanho primeiro fora da função de tempo constante (vazar o TAMANHO do token não
 * ajuda um atacante a adivinhar o conteúdo, ao contrário de vazar quantos caracteres batem). */
function tokenValido(recebido: string): boolean {
  const esperado = env.DIGISTORE24_AFILIADO_TOKEN;
  if (!esperado) return false; // sem token configurado = recusa tudo, nunca aceita às cegas
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function paraNumero(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** transaction_id pode chegar vazio num ping de teste com placeholder não resolvido — nunca
 * descartamos o evento por isso (grava tudo), mas também não podemos deixar dois eventos sem id
 * colidirem no índice único de dedup. */
function paraIdDeTransacao(v: unknown): string {
  if (typeof v === 'string' && v.trim() !== '') return v.slice(0, 64);
  return `sem-id-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function handleDS24Afiliado(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const token = (req.params.token as string) || '';

  if (!tokenValido(token)) {
    logger.warn(CTX, 'Token inválido ou não configurado — recusando (fail closed)');
    res.status(403).json({ error: 'Invalid token' });
    return;
  }

  const q = req.query as Record<string, string | undefined>;

  try {
    await query(
      `INSERT INTO afiliado_eventos (
        transaction_id, order_id, transaction_type,
        amount_affiliate, amount_brutto, amount_netto, currency,
        product_id, product_name, merchant_id, merchant_name, affiliate_name,
        billing_status, order_type, is_test, evento_em
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamp)
      ON CONFLICT (transaction_id) DO NOTHING`,
      [
        paraIdDeTransacao(q.transaction_id),
        (q.order_id || '').slice(0, 64),
        (q.transaction_type || '').slice(0, 20).toLowerCase(),
        paraNumero(q.amount_affiliate),
        paraNumero(q.amount_brutto),
        paraNumero(q.amount_netto),
        (q.currency || '').slice(0, 10) || null,
        (q.product_id || '').slice(0, 50) || null,
        q.product_name || null,
        (q.merchant_id || '').slice(0, 50) || null,
        q.merchant_name || null,
        (q.affiliate_name || '').slice(0, 100) || null,
        (q.billing_status || '').slice(0, 30) || null,
        (q.order_type || '').slice(0, 30) || null,
        q.is_test === '1',
        q.datetime_utc || null,
      ]
    );
    res.status(200).send('OK');
  } catch (err: any) {
    // Erro AQUI é "não conseguimos gravar" — 5xx de propósito, pra Digistore reenviar. Diferente
    // do handler do produtor (que já respondeu 200 antes de qualquer enriquecimento), este handler
    // não faz mais nada depois do INSERT, então não existe "já está seguro, o resto é bônus" — se
    // o INSERT falhou, o evento realmente ainda não está seguro.
    logger.error(CTX, `Falha gravando evento de afiliado: ${err.message}`);
    res.status(500).json({ error: 'Internal processing error' });
  }
}
