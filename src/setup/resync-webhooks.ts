/**
 * Resync Webhooks — Re-sincronização de contatos para AC per-client.
 *
 * Contexto: webhooks que chegaram antes do fix em extractCartPandaSlug()
 * foram salvos com client_id=NULL e processados contra a conta AC GLOBAL
 * (fallback do lookupStore). Depois o repair SQL preencheu client_id
 * corretamente, mas os contatos estão na AC errada.
 *
 * Este script lê webhook_logs e re-executa syncContact/tag/list na conta
 * AC do cliente correto. Operações são idempotentes (AC usa email como
 * chave natural).
 *
 * AUTOMATIONS SÃO IGNORADAS — evita disparar emails duplicados.
 *
 * Uso:
 *   npm run resync                        # todos os clients
 *   npm run resync -- --client-id=3       # apenas client 3
 *   npm run resync -- --dry-run           # preview (sem chamadas AC)
 *   npm run resync -- --since=500         # retoma a partir do webhook id > 500
 *   npm run resync -- --client-id=3 --dry-run
 */

import { initDatabase, query, queryOne } from '../db/database';
import { ActiveCampaignClient } from '../services/activecampaign';
import { upsertProduct, extractCartPandaProductId } from '../webhooks/product-upsert';
import { logger } from '../utils/logger';

const CTX = 'Resync';

interface Args {
  clientId?: number;
  dryRun: boolean;
  since: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const hit = argv.find((x) => x.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : undefined;
  };
  return {
    clientId: get('client-id') ? parseInt(get('client-id')!, 10) : undefined,
    dryRun: argv.includes('--dry-run'),
    since: parseInt(get('since') || '0', 10),
  };
}

interface WebhookRow {
  id: number;
  client_id: number;
  event_type: string;
  payload: any;
  created_at: string;
}

interface ClientRow {
  company_name: string;
  ac_api_url: string | null;
  ac_api_key: string | null;
}

interface AcEntry {
  ac: ActiveCampaignClient | null;
  name: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  await initDatabase();

  const where: string[] = [`source = 'cartpanda'`, `client_id IS NOT NULL`];
  const params: any[] = [];
  if (args.clientId !== undefined) {
    params.push(args.clientId);
    where.push(`client_id = $${params.length}`);
  }
  if (args.since > 0) {
    params.push(args.since);
    where.push(`id > $${params.length}`);
  }

  const rows = await query<WebhookRow>(
    `SELECT id, client_id, event_type, payload, created_at
     FROM webhook_logs
     WHERE ${where.join(' AND ')}
     ORDER BY id ASC`,
    params
  );

  logger.info(CTX, `Encontrados ${rows.length} webhooks para resync`);
  if (args.dryRun) logger.info(CTX, '🔎 DRY RUN — nenhuma chamada ao ActiveCampaign');

  // Cache de credenciais AC por client (evita N lookups)
  const acCache = new Map<number, AcEntry>();
  const getAc = async (clientId: number): Promise<AcEntry> => {
    const cached = acCache.get(clientId);
    if (cached) return cached;
    const c = await queryOne<ClientRow>(
      `SELECT company_name, ac_api_url, ac_api_key FROM clients WHERE id = $1`,
      [clientId]
    );
    if (!c || !c.ac_api_url || !c.ac_api_key) {
      logger.warn(CTX, `Client #${clientId} sem credenciais AC — pulando`);
      const entry: AcEntry = { ac: null, name: c?.company_name || `#${clientId}` };
      acCache.set(clientId, entry);
      return entry;
    }
    const entry: AcEntry = {
      ac: new ActiveCampaignClient(c.ac_api_url, c.ac_api_key),
      name: c.company_name,
    };
    acCache.set(clientId, entry);
    return entry;
  };

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  // Dedupe: mesmo email+event+produto+client processado uma vez só
  const seen = new Set<string>();

  for (const wh of rows) {
    try {
      const raw = typeof wh.payload === 'string' ? JSON.parse(wh.payload) : wh.payload;
      const data = raw?.order || raw;

      const email: string | undefined = data?.email || data?.customer?.email;
      if (!email) {
        skipped++;
        continue;
      }

      const { ac, name: clientName } = await getAc(wh.client_id);
      if (!ac) {
        skipped++;
        continue;
      }

      const firstName: string = data?.first_name || data?.customer?.first_name || '';
      const lastName: string = data?.last_name || data?.customer?.last_name || '';
      const phone: string = data?.phone || data?.customer?.phone || '';
      const lineItems: any[] = data?.line_items || data?.cart_items || data?.items || [];
      const item = lineItems[0] || {};
      const productName: string = item.title || item.name || 'produto';
      const externalId: string = extractCartPandaProductId(item);

      const dedupeKey = `${wh.client_id}:${email.toLowerCase()}:${wh.event_type}:${externalId}`;
      if (seen.has(dedupeKey)) {
        skipped++;
        continue;
      }
      seen.add(dedupeKey);

      if (args.dryRun) {
        logger.info(
          CTX,
          `[DRY] wh#${wh.id} → client "${clientName}" | ${wh.event_type} | ${email} | produto="${productName}"`
        );
        synced++;
        continue;
      }

      // Upsert do produto (idempotente — fica enabled=false se novo)
      const kit = await upsertProduct(wh.client_id, 'cartpanda', externalId, productName);

      // syncContact é idempotente: upsert pelo email na conta AC do cliente
      const contact = await ac.syncContact({ email, firstName, lastName, phone });

      // Aplica tag/list apenas se o produto foi explicitamente habilitado pelo admin
      // (mesma lógica dos handlers originais). Sem isso os tags nem existem ainda na AC.
      if (kit?.enabled) {
        const tagField =
          wh.event_type === 'order.paid' ? 'ac_tag_compra_id' :
          wh.event_type === 'abandoned_cart' ? 'ac_tag_abandono_id' :
          wh.event_type === 'card.declined' ? 'ac_tag_cartao_recusado_id' :
          null;
        const tagId = tagField ? (kit as any)[tagField] : null;
        if (tagId) {
          try { await ac.addTagToContact(contact.id, tagId); } catch (_) { /* idempotente */ }
        }
        if (kit.ac_list_id) {
          try { await ac.addContactToList(contact.id, kit.ac_list_id); } catch (_) { /* idempotente */ }
        }
      }

      // AUTOMATIONS IGNORADAS — não queremos re-disparar envios de email

      synced++;
      if (synced % 25 === 0) {
        logger.info(CTX, `Progresso: ${synced}/${rows.length} sincronizados`);
      }
    } catch (err: any) {
      errors++;
      logger.error(CTX, `wh#${wh.id} falhou: ${err.message}`);
    }
  }

  logger.info(CTX, '─────────── RESUMO ───────────');
  logger.info(CTX, `Sincronizados: ${synced}`);
  logger.info(CTX, `Ignorados:     ${skipped}`);
  logger.info(CTX, `Erros:         ${errors}`);
  logger.info(CTX, `Clients AC:    ${acCache.size}`);

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error(CTX, 'Fatal', err);
  process.exit(1);
});
