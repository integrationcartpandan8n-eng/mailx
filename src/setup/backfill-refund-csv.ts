/**
 * Backfill DS24 Transaction CSV — importa histórico de payment/refund/chargeback
 * da Digistore24 (export "Reports → Transactions") pra dentro do webhook_logs,
 * com a data real da transação (não a de hoje).
 *
 * Tipos suportados: payment → order.paid, refund → order.refunded,
 * chargeback alert → order.chargeback (refund request é ignorado como duplicata).
 *
 * Uso:
 *   npm run backfill-refund -- --client-id=5 --file=/caminho/export.csv
 *   npm run backfill-refund -- --client-id=5 --file=/caminho/export.csv --dry-run
 */

import { config } from 'dotenv';
config();

import { initDatabase, query, queryOne, closeDatabase } from '../db/database';
import { logger } from '../utils/logger';
import * as fs from 'fs';

const CTX = 'BackfillRefundCSV';

function getArg(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return undefined;
  return arg.slice(prefix.length);
}

function parseArgs() {
  const clientIdRaw = getArg('--client-id=');
  const file = getArg('--file=');
  const dryRun = process.argv.includes('--dry-run');
  if (!clientIdRaw || !file) {
    throw new Error('Uso: --client-id=N --file=/caminho.csv [--dry-run]');
  }
  const clientId = parseInt(clientIdRaw, 10);
  if (isNaN(clientId)) throw new Error('client-id deve ser numérico');
  if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`);
  return { clientId, file, dryRun };
}

function parseMoneyField(raw: string): number {
  const cleaned = (raw || '').replace(/^="?/, '').replace(/"$/, '');
  return parseFloat(cleaned) || 0;
}

function normalizeCsvLine(line: string): string {
  // Export DS24/Excel: valores monetários vêm como ;="=-47.00"; em vez de ;"-47.00";
  return line.replace(/;="([^"]*?)"/g, ';"$1"');
}

function parseCsvLine(line: string): string[] {
  return normalizeCsvLine(line).split('";"').map((f) => f.replace(/^"|"$/g, ''));
}

function parseDateTime(dateStr: string, timeStr: string): Date {
  const [month, day, year] = dateStr.split('/').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

async function main() {
  const { clientId, file, dryRun } = parseArgs();
  await initDatabase();

  logger.info(CTX, `client_id=${clientId} file=${file} dryRun=${dryRun}`);

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.findIndex((h) => h.trim() === name);

  const iDate = idx('Date');
  const iTime = idx('Time');
  const iOrderId = idx('Order ID');
  const iTxId = idx('Transaction ID');
  const iType = idx('Transaction type');
  const iGross = idx('Gross amount');
  const iEarnings = idx('Your earnings');
  const iPrdId = idx('Prd ID');
  const iProductName = idx('Product name');
  const iEmail = idx('Email');

  let imported = 0;
  let importedRefunds = 0;
  let importedChargebacks = 0;
  let importedPayments = 0;
  let skippedDuplicateRequest = 0;
  let skippedAlreadyExists = 0;
  let skippedUnknown = 0;

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const type = cols[iType]?.trim();
    const transactionId = cols[iTxId]?.trim();
    if (!transactionId) continue;

    if (type === 'refund request') {
      skippedDuplicateRequest++;
      logger.info(CTX, `[skip] refund request duplicada — tx ${transactionId}`);
      continue;
    }

    let eventType: string;
    let amount: number;
    if (type === 'refund') {
      eventType = 'order.refunded';
      amount = Math.abs(parseMoneyField(cols[iGross]));
    } else if (type === 'chargeback alert' || type === 'chargeback') {
      eventType = 'order.chargeback';
      amount = Math.abs(parseMoneyField(cols[iEarnings]));
    } else if (type === 'payment') {
      eventType = 'order.paid';
      amount = parseMoneyField(cols[iGross]);
    } else {
      skippedUnknown++;
      logger.warn(CTX, `[skip] tipo desconhecido "${type}" — tx ${transactionId}`);
      continue;
    }

    const existing = await queryOne<{ id: number }>(
      `SELECT id FROM webhook_logs
       WHERE client_id = $1 AND source = 'digistore24' AND payload->>'transaction_id' = $2`,
      [clientId, transactionId]
    );
    if (existing) {
      skippedAlreadyExists++;
      logger.info(CTX, `[skip] já existe — ${eventType} tx ${transactionId}`);
      continue;
    }

    const createdAt = parseDateTime(cols[iDate], cols[iTime]);
    const payload = {
      transaction_id: transactionId,
      order_id: cols[iOrderId],
      backfill_source: 'csv_export',
      email: cols[iEmail],
    };

    if (dryRun) {
      logger.info(
        CTX,
        `[dry-run] importaria ${eventType} tx ${transactionId} — USD ${amount} em ${createdAt.toISOString()}`
      );
    } else {
      await query(
        `INSERT INTO webhook_logs (
          client_id, event_type, source, payload, status,
          total_price, currency, product_name, product_external_id,
          created_at, processed_at
        ) VALUES ($1, $2, 'digistore24', $3, 'processed', $4, 'USD', $5, $6, $7, $7)`,
        [clientId, eventType, JSON.stringify(payload), amount, cols[iProductName], cols[iPrdId], createdAt]
      );
    }

    imported++;
    if (eventType === 'order.refunded') importedRefunds++;
    else if (eventType === 'order.chargeback') importedChargebacks++;
    else if (eventType === 'order.paid') importedPayments++;
  }

  const dataRows = lines.length - 1;
  logger.info(CTX, '─────────── RESUMO ───────────');
  logger.info(CTX, `Linhas de dados no CSV:     ${dataRows}`);
  logger.info(CTX, `Importados (total):         ${imported}${dryRun ? ' (dry-run, nada gravado)' : ''}`);
  logger.info(CTX, `  └ order.refunded:         ${importedRefunds}`);
  logger.info(CTX, `  └ order.chargeback:       ${importedChargebacks}`);
  logger.info(CTX, `  └ order.paid:             ${importedPayments}`);
  logger.info(CTX, `Ignorados (refund request): ${skippedDuplicateRequest}`);
  logger.info(CTX, `Já existiam (idempotente):  ${skippedAlreadyExists}`);
  if (skippedUnknown > 0) {
    logger.info(CTX, `Ignorados (tipo desconhecido): ${skippedUnknown}`);
  }

  await closeDatabase();
}

main().catch((err) => {
  logger.error(CTX, 'Fatal', err);
  process.exit(1);
});
