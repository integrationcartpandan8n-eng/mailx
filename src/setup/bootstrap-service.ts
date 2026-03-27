/**
 * Bootstrap Service
 * Extracted logic from the CLI bootstrap script into a callable function.
 * Can be invoked from the admin dashboard API or from the CLI script.
 */

import { ActiveCampaignClient } from '../services/activecampaign';
import { query, queryOne } from '../db/database';
import { logger } from '../utils/logger';

const CTX = 'Bootstrap';

export interface BootstrapResult {
  success: boolean;
  clientId: number;
  listsCreated: Array<{ name: string; id: string; existed: boolean }>;
  tagsCreated: Array<{ name: string; id: string; existed: boolean }>;
  errors: string[];
}

export interface KitBootstrapResult {
  success: boolean;
  tagsCreated: Array<{ name: string; id: string; existed: boolean }>;
  listId: string | null;
  error?: string;
}

interface Kit {
  id: number;
  name: string;
  slug: string;
  enabled: boolean;
}

/**
 * Run the bootstrap process for a client:
 * 1. Read client's AC credentials + kits from DB
 * 2. Create lists in ActiveCampaign
 * 3. Create tags in ActiveCampaign
 * 4. Save AC IDs back to DB
 */
export async function runBootstrap(clientId: number): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    success: false,
    clientId,
    listsCreated: [],
    tagsCreated: [],
    errors: [],
  };

  // 1. Fetch client credentials
  const clients = await query<any>(
    `SELECT ac_api_url, ac_api_key, company_name FROM clients WHERE id = $1`,
    [clientId]
  );
  if (clients.length === 0) {
    result.errors.push(`Cliente ${clientId} não encontrado`);
    return result;
  }

  const { ac_api_url, ac_api_key, company_name } = clients[0];
  if (!ac_api_url || !ac_api_key) {
    result.errors.push('Credenciais do ActiveCampaign não configuradas para este cliente');
    return result;
  }

  // 2. Fetch only enabled kits
  const kits = await query<Kit>(
    `SELECT id, name, slug, enabled FROM kits WHERE client_id = $1 AND enabled = true`,
    [clientId]
  );

  if (kits.length === 0) {
    result.errors.push('Nenhum produto habilitado para este cliente. Habilite ao menos um produto antes de rodar o bootstrap.');
    return result;
  }

  logger.info(CTX, `🚀 Bootstrap started for "${company_name}" (${kits.length} kits)`);

  const ac = new ActiveCampaignClient(ac_api_url, ac_api_key);

  // 3. Create Lists (only the main contacts list — newsletter is not used)
  const listsToCreate = [
    { name: 'Todos os contatos', stringid: 'todos-os-contatos' },
  ];

  const listIds: Record<string, string> = {};

  for (const list of listsToCreate) {
    try {
      const existing = await ac.findListByName(list.name);
      if (existing) {
        listIds[list.stringid] = existing.id;
        result.listsCreated.push({ name: list.name, id: existing.id, existed: true });
        logger.info(CTX, `  ✓ List exists: ${list.name} (ID: ${existing.id})`);
      } else {
        const created = await ac.createList(list);
        listIds[list.stringid] = created.id;
        result.listsCreated.push({ name: list.name, id: created.id, existed: false });
        logger.info(CTX, `  ✅ List created: ${list.name} (ID: ${created.id})`);
      }
      await new Promise((r) => setTimeout(r, 250));
    } catch (error: any) {
      const msg = `Falha ao criar lista "${list.name}": ${error.message}`;
      result.errors.push(msg);
      logger.error(CTX, `  ❌ ${msg}`);
    }
  }

  // 4. Create Tags — format: [Kit Name] Evento
  const tagsToCreate = [
    ...kits.flatMap((k) => [
      { tag: `[${k.name}] Compra Aprovada`,    description: `Comprou o ${k.name}` },
      { tag: `[${k.name}] Abandono`,            description: `Abandonou carrinho do ${k.name}` },
      { tag: `[${k.name}] Cartão Recusado`,     description: `Cartão recusado no checkout do ${k.name}` },
      { tag: `[${k.name}] Reembolso`,           description: `Reembolso do ${k.name}` },
      { tag: `[${k.name}] Chargeback`,          description: `Chargeback do ${k.name}` },
    ]),
    { tag: 'lead-engajado', description: 'Abriu/clicou nos últimos 30 dias' },
    { tag: 'lead-frio', description: 'Sem interação em >30 dias' },
  ];

  const tagIds: Record<string, string> = {};

  for (const tag of tagsToCreate) {
    try {
      const existing = await ac.findTagByName(tag.tag);
      if (existing) {
        tagIds[tag.tag] = existing.id;
        result.tagsCreated.push({ name: tag.tag, id: existing.id, existed: true });
        logger.info(CTX, `  ✓ Tag exists: ${tag.tag} (ID: ${existing.id})`);
      } else {
        const created = await ac.createTag(tag);
        tagIds[tag.tag] = created.id;
        result.tagsCreated.push({ name: tag.tag, id: created.id, existed: false });
        logger.info(CTX, `  ✅ Tag created: ${tag.tag} (ID: ${created.id})`);
      }
      await new Promise((r) => setTimeout(r, 250));
    } catch (error: any) {
      const msg = `Falha ao criar tag "${tag.tag}": ${error.message}`;
      result.errors.push(msg);
      logger.error(CTX, `  ❌ ${msg}`);
    }
  }

  // 5. Update kits in DB with AC IDs
  const mainListId = listIds['todos-os-contatos'] || null;
  for (const kit of kits) {
    const tagCompraId          = tagIds[`[${kit.name}] Compra Aprovada`]    || null;
    const tagAbandonoId        = tagIds[`[${kit.name}] Abandono`]            || null;
    const tagCartaoRecusadoId  = tagIds[`[${kit.name}] Cartão Recusado`]     || null;
    const tagReembolsoId       = tagIds[`[${kit.name}] Reembolso`]           || null;
    const tagChargebackId      = tagIds[`[${kit.name}] Chargeback`]          || null;

    await query(
      `UPDATE kits
       SET ac_list_id = $1,
           ac_tag_compra_id = $2,
           ac_tag_abandono_id = $3,
           ac_tag_cartao_recusado_id = $4,
           ac_tag_reembolso_id = $5,
           ac_tag_chargeback_id = $6
       WHERE id = $7`,
      [mainListId, tagCompraId, tagAbandonoId, tagCartaoRecusadoId, tagReembolsoId, tagChargebackId, kit.id]
    );
  }

  // 6. Update client status to 'configuring' if it was 'pending'
  await query(
    `UPDATE clients SET status = 'configuring', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
    [clientId]
  );

  result.success = result.errors.length === 0;
  logger.info(CTX, `🏁 Bootstrap ${result.success ? 'completed' : 'finished with errors'} for "${company_name}"`);

  return result;
}

/**
 * Run bootstrap for a single kit: creates AC tags and links the list.
 * Called automatically when admin enables a product.
 */
export async function runKitBootstrap(clientId: number, kitId: number): Promise<KitBootstrapResult> {
  const result: KitBootstrapResult = { success: false, tagsCreated: [], listId: null };

  const clients = await query<any>(
    `SELECT ac_api_url, ac_api_key FROM clients WHERE id = $1`,
    [clientId]
  );
  if (!clients[0]?.ac_api_url || !clients[0]?.ac_api_key) {
    result.error = 'Credenciais do ActiveCampaign não configuradas para este cliente';
    return result;
  }

  const kit = await queryOne<{ id: number; name: string; ac_list_id: string | null }>(
    `SELECT id, name, ac_list_id FROM kits WHERE id = $1 AND client_id = $2`,
    [kitId, clientId]
  );
  if (!kit) {
    result.error = 'Produto não encontrado';
    return result;
  }

  const ac = new ActiveCampaignClient(clients[0].ac_api_url, clients[0].ac_api_key);

  // Ensure "Todos os contatos" list exists
  let listId = kit.ac_list_id;
  if (!listId) {
    try {
      const existing = await ac.findListByName('Todos os contatos');
      if (existing) {
        listId = existing.id;
      } else {
        const created = await ac.createList({ name: 'Todos os contatos', stringid: 'todos-os-contatos' });
        listId = created.id;
      }
    } catch (err: any) {
      result.error = `Falha ao encontrar lista: ${err.message}`;
      return result;
    }
  }

  // Create the 5 tags for this kit
  const tagsToCreate = [
    { tag: `[${kit.name}] Compra Aprovada`,   field: 'ac_tag_compra_id' },
    { tag: `[${kit.name}] Abandono`,           field: 'ac_tag_abandono_id' },
    { tag: `[${kit.name}] Cartão Recusado`,    field: 'ac_tag_cartao_recusado_id' },
    { tag: `[${kit.name}] Reembolso`,          field: 'ac_tag_reembolso_id' },
    { tag: `[${kit.name}] Chargeback`,         field: 'ac_tag_chargeback_id' },
  ];

  const tagIds: Record<string, string> = {};

  for (const t of tagsToCreate) {
    try {
      const existing = await ac.findTagByName(t.tag);
      if (existing) {
        tagIds[t.field] = existing.id;
        result.tagsCreated.push({ name: t.tag, id: existing.id, existed: true });
      } else {
        const created = await ac.createTag({ tag: t.tag });
        tagIds[t.field] = created.id;
        result.tagsCreated.push({ name: t.tag, id: created.id, existed: false });
      }
      await new Promise((r) => setTimeout(r, 250));
    } catch (err: any) {
      result.error = `Falha ao criar tag "${t.tag}": ${err.message}`;
      return result;
    }
  }

  // Save IDs back to kit
  await query(
    `UPDATE kits
     SET ac_list_id = $1,
         ac_tag_compra_id = $2,
         ac_tag_abandono_id = $3,
         ac_tag_cartao_recusado_id = $4,
         ac_tag_reembolso_id = $5,
         ac_tag_chargeback_id = $6
     WHERE id = $7`,
    [listId, tagIds['ac_tag_compra_id'], tagIds['ac_tag_abandono_id'],
     tagIds['ac_tag_cartao_recusado_id'], tagIds['ac_tag_reembolso_id'],
     tagIds['ac_tag_chargeback_id'], kitId]
  );

  result.listId = listId;
  result.success = true;
  logger.info(CTX, `✅ Kit bootstrap done for kit #${kitId} (${kit.name})`);
  return result;
}

/**
 * Generate DNS records that need to be configured for a client's sending domain.
 */
export function generateDnsRecords(sendingDomain: string, clientSlug: string) {
  return [
    {
      type: 'CNAME',
      name: `em.${sendingDomain}`,
      value: 'return.acems1.com',
      purpose: 'Return Path — SPF alignment',
      priority: 'obrigatório',
    },
    {
      type: 'CNAME',
      name: `s1._domainkey.${sendingDomain}`,
      value: 'dkim.acems1.com',
      purpose: 'DKIM — Autenticação de email',
      priority: 'obrigatório',
    },
    {
      type: 'CNAME',
      name: `s2._domainkey.${sendingDomain}`,
      value: 'dkim2.acems1.com',
      purpose: 'DKIM backup',
      priority: 'obrigatório',
    },
    {
      type: 'TXT',
      name: `_dmarc.${sendingDomain}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${sendingDomain}`,
      purpose: 'DMARC — Política de proteção',
      priority: 'recomendado',
    },
    {
      type: 'TXT',
      name: sendingDomain,
      value: `v=spf1 include:emsd1.com ~all`,
      purpose: 'SPF — Autorização de envio',
      priority: 'obrigatório',
    },
  ];
}
