/**
 * Status pós-gravação de um webhook_logs — usado por TODOS os handlers que gravam primeiro e
 * processam depois (ver o comentário grande em digistore24-payment.handler.ts).
 *
 * Existe pra centralizar uma regra: marcar o RESULTADO DO ENRIQUECIMENTO sempre pela linha exata
 * (logId), nunca por "a mais recente do source" — foi um re-SELECT desses que carimbava status
 * errado numa linha de OUTRO pedido sempre que duas vendas chegavam em paralelo.
 */

import { query, isDatabaseReady } from '../db/database';

export async function marcarEnriquecimento(
  logId: number | null,
  status: 'processed' | 'skipped' | 'failed',
  motivo: string | null
): Promise<void> {
  if (!isDatabaseReady() || !logId) return;
  try {
    await query(
      `UPDATE webhook_logs SET status = $2, error = $3, processed_at = NOW() WHERE id = $1`,
      [logId, status, motivo]
    );
  } catch (_) {}
}
