/**
 * SlickText Sync Helper
 *
 * Shared logic for syncing contacts with SlickText SMS from webhook handlers.
 * Handles: phone validation, contact creation, list auto-creation, list management.
 */

import { SlickTextClient } from '../services/slicktext';
import { query, queryOne } from '../db/database';
import { logger } from '../utils/logger';
import type { StoreContext } from './store-lookup';
import type { KitRecord } from './product-upsert';

const CTX = 'SlickTextSync';

interface SyncContactData {
  phone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  address?: string;
}

interface SyncResult {
  synced: boolean;
  contactId?: number;
  listId?: number;
  reason?: string;
}

/**
 * Format address from webhook payload.
 * Handles both object and JSON-string formats.
 */
function formatAddress(raw: any): string {
  if (!raw) return '';

  let addressData: any = {};
  try {
    addressData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return '';
  }

  const street = addressData?.address || addressData?.street || '';
  const city = addressData?.city || '';
  const state = addressData?.province || addressData?.state || '';
  const zip = addressData?.zip || addressData?.zip_code || addressData?.zipcode || '';
  const country = addressData?.country || addressData?.country_name || '';

  return [street, city, state, zip, country]
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Extract address from CartPanda webhook payload.
 */
export function extractCartPandaAddress(payload: any): string {
  const data = payload?.order || payload;
  const raw =
    data?.shipping_address ||
    payload?.data?.shipping_address ||
    data?.billing_address ||
    '';
  return formatAddress(raw);
}

/**
 * Extract address from Digistore24 webhook payload.
 */
export function extractDS24Address(params: Record<string, any>): string {
  const street = params.street || '';
  const city = params.city || '';
  const state = params.state || '';
  const zip = params.zipcode || params.zip || '';
  const country = params.country_name || params.country || '';

  return [street, city, state, zip, country]
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Ensure SlickText lists exist for a product.
 * Creates "[Product] [Compra Aprovada]" and "[Product] [Abandono de Carrinho]" if they don't exist.
 * Saves list IDs back to the kits table.
 */
async function ensureSlickTextLists(
  st: SlickTextClient,
  kit: KitRecord
): Promise<{ compraListId: number | null; abandonoListId: number | null }> {
  let compraListId: number | null = kit.st_list_compra_id ? parseInt(kit.st_list_compra_id) : null;
  let abandonoListId: number | null = kit.st_list_abandono_id ? parseInt(kit.st_list_abandono_id) : null;

  try {
    // Create/find purchase list
    if (!compraListId) {
      const listName = `[${kit.name}] [Compra Aprovada]`;
      const list = await st.findOrCreateList(listName, `Compradores do produto ${kit.name}`);
      compraListId = list.contact_list_id;
      await query(`UPDATE kits SET st_list_compra_id = $1 WHERE id = $2`, [String(compraListId), kit.id]);
      logger.info(CTX, `SlickText list created/found: "${listName}" → ID ${compraListId}`);
    }

    // Create/find abandonment list
    if (!abandonoListId) {
      const listName = `[${kit.name}] [Abandono de Carrinho]`;
      const list = await st.findOrCreateList(listName, `Carrinhos abandonados do produto ${kit.name}`);
      abandonoListId = list.contact_list_id;
      await query(`UPDATE kits SET st_list_abandono_id = $1 WHERE id = $2`, [String(abandonoListId), kit.id]);
      logger.info(CTX, `SlickText list created/found: "${listName}" → ID ${abandonoListId}`);
    }
  } catch (err: any) {
    logger.error(CTX, `Failed to ensure SlickText lists for kit "${kit.name}": ${err.message}`);
  }

  return { compraListId, abandonoListId };
}

/**
 * Sync a contact with SlickText for a "Compra Aprovada" (order paid) event.
 * - Creates contact in SlickText
 * - Adds to purchase list
 * - Removes from abandonment list (if they were there)
 */
export async function syncSlickTextOrderPaid(
  store: StoreContext,
  kit: KitRecord | null,
  contactData: SyncContactData
): Promise<SyncResult> {
  if (!store.stApiToken || !store.stBrandId) {
    return { synced: false, reason: 'SlickText credentials not configured' };
  }

  const phone = SlickTextClient.formatPhone(contactData.phone);
  if (!phone) {
    return { synced: false, reason: `Invalid phone: "${contactData.phone}"` };
  }

  if (!kit?.enabled) {
    return { synced: false, reason: 'Product not enabled' };
  }

  try {
    const st = new SlickTextClient(store.stApiToken, store.stBrandId);

    // 1. Create/find contact
    const contact = await st.createContact({
      mobile_number: phone,
      first_name: contactData.firstName,
      last_name: contactData.lastName,
      email: contactData.email,
      address: contactData.address,
    });

    // 2. Ensure lists exist
    const { compraListId, abandonoListId } = await ensureSlickTextLists(st, kit);

    // 3. Add to purchase list
    if (compraListId) {
      await st.addContactToLists(contact.contact_id, [compraListId]);
    }

    // 4. Remove from abandonment list (they bought — stop recovery SMS)
    if (abandonoListId) {
      await st.removeContactFromList(contact.contact_id, abandonoListId);
    }

    logger.info(CTX, `Order paid synced to SlickText: ${phone} → [${kit.name}] Compra`);
    return { synced: true, contactId: contact.contact_id, listId: compraListId || undefined };
  } catch (err: any) {
    logger.error(CTX, `SlickText sync failed (order paid): ${err.message}`);
    return { synced: false, reason: err.message };
  }
}

/**
 * Sync a contact with SlickText for an "Abandono de Carrinho" event.
 * - Creates contact in SlickText
 * - Adds to abandonment list
 */
export async function syncSlickTextAbandonedCart(
  store: StoreContext,
  kit: KitRecord | null,
  contactData: SyncContactData
): Promise<SyncResult> {
  if (!store.stApiToken || !store.stBrandId) {
    return { synced: false, reason: 'SlickText credentials not configured' };
  }

  const phone = SlickTextClient.formatPhone(contactData.phone);
  if (!phone) {
    return { synced: false, reason: `Invalid phone: "${contactData.phone}"` };
  }

  if (!kit?.enabled) {
    return { synced: false, reason: 'Product not enabled' };
  }

  try {
    const st = new SlickTextClient(store.stApiToken, store.stBrandId);

    // 1. Create/find contact
    const contact = await st.createContact({
      mobile_number: phone,
      first_name: contactData.firstName,
      last_name: contactData.lastName,
      email: contactData.email,
      address: contactData.address,
    });

    // 2. Ensure lists exist
    const { abandonoListId } = await ensureSlickTextLists(st, kit);

    // 3. Add to abandonment list
    if (abandonoListId) {
      await st.addContactToLists(contact.contact_id, [abandonoListId]);
    }

    logger.info(CTX, `Abandoned cart synced to SlickText: ${phone} → [${kit.name}] Abandono`);
    return { synced: true, contactId: contact.contact_id, listId: abandonoListId || undefined };
  } catch (err: any) {
    logger.error(CTX, `SlickText sync failed (abandoned cart): ${err.message}`);
    return { synced: false, reason: err.message };
  }
}

/**
 * Vincula kits sem st_list_abandono_id/st_list_compra_id às listas do SlickText
 * cujo nome segue o padrão "[Produto] [Abandono de Carrinho]" / "[Produto] [Compra Aprovada]".
 * Não cria nada no SlickText — só lê e persiste o ID localmente (compatível com METRICS_ONLY).
 * Retorna a lista de kits que continuam sem correspondência (pra sinalizar no dashboard).
 */
/** Reduz um nome a letras e dígitos minúsculos, pra comparar "Night Calm" com "NightCalm". */
function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acento
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Uma lista só é aceita como SEGUNDA lista (slot 2) se tiver crescido de verdade nos retratos —
 * "de verdade" significando mais que ruído, não só "mais que zero".
 *
 * Por que existe, e por que "mais que zero" não bastava: o NeuroMind provou o risco DUAS vezes.
 * Primeiro com a lista 107460 (parada em 19.706 exatos, zero variação — essa a versão anterior
 * desta checagem já rejeitava). Depois com a lista 119972 — outra sobra da mesma migração, também
 * abandonada — que tinha ido de 20.095 para 20.096 num contato isolado ao longo de 9 dias de
 * retrato. Tecnicamente "cresceu" (20.096 > 20.095), e a versão anterior aceitou. O resultado:
 * 6 dos 8 kits do NeuroMind passaram a excluir a venda real do cálculo exato, porque a query de
 * leads via webhook só cobre produto com list_compra_id_2 vazio.
 *
 * MINIMO_LEADS_REAIS existe pra separar as duas coisas: uma lista que recebe LEAD de verdade
 * ganha dezenas ou centenas em poucos dias; uma lista morta que alguém tocou por engano ganha 1.
 * O valor é um julgamento, não uma medição — mas rejeitar +1 e aceitar +50 no mesmo teste é uma
 * escolha melhor que aceitar os dois igualmente por serem ambos "positivos".
 *
 * Sem retrato ainda (menos de 2 dias de série): NÃO aceita. Não dá pra provar que cresce, e
 * escrever sem prova é o mesmo erro que esta função existe para não repetir — a lista entra assim
 * que tiver dois dias de retrato e mostrar crescimento acima do ruído.
 */
const MINIMO_LEADS_REAIS_PARA_SEGUNDA_LISTA = 5;

async function candidataDeSegundaListaCresceu(clientId: number, listId: number): Promise<boolean> {
  const r = await queryOne<{ primeiro: string; ultimo: string; dias: string }>(
    `SELECT (ARRAY_AGG(contact_count ORDER BY snapshot_date))[1]::text AS primeiro,
            (ARRAY_AGG(contact_count ORDER BY snapshot_date DESC))[1]::text AS ultimo,
            COUNT(*)::text AS dias
     FROM list_contact_snapshots WHERE client_id = $1 AND list_id = $2`,
    [clientId, String(listId)]
  );
  if (!r || parseInt(r.dias) < 2) return false;
  return (parseInt(r.ultimo) - parseInt(r.primeiro)) >= MINIMO_LEADS_REAIS_PARA_SEGUNDA_LISTA;
}

export async function autoLinkSlickTextLists(
  st: SlickTextClient,
  clientId: number
): Promise<{ linked: number; unmatched: Array<{ kitId: number; kitName: string }> }> {
  const lists = await st.getLists();
  const pattern = /^\[(.+?)\]\s*\[(Abandono de Carrinho|Compra Aprovada)\]$/i;

  const abandonoByProduct = new Map<string, number>();
  const compraByProduct = new Map<string, number>();
  for (const list of lists) {
    const m = list.name.match(pattern);
    if (!m) continue;
    const product = m[1].trim();
    const kind = m[2].toLowerCase();
    if (kind === 'abandono de carrinho') abandonoByProduct.set(product, list.contact_list_id);
    else compraByProduct.set(product, list.contact_list_id);
  }

  // Só produtos ATIVADOS: os descobertos automaticamente entram desativados e só ganham lista no
  // bootstrap da ativação — contá-los como "sem lista vinculada" enchia o aviso de ruído
  // (13 dos 15 avisos no cliente de referência eram produtos que ninguém ativou).
  const kits = await query<{ id: number; name: string; st_list_abandono_id: string | null; st_list_abandono_id_2: string | null; st_list_compra_id: string | null; st_list_compra_id_2: string | null }>(
    `SELECT id, name, st_list_abandono_id, st_list_abandono_id_2, st_list_compra_id, st_list_compra_id_2
     FROM kits WHERE client_id = $1 AND enabled = true`,
    [clientId]
  );

  let linked = 0;
  const unmatched: Array<{ kitId: number; kitName: string }> = [];

  for (const kit of kits) {
    let abandonoId = kit.st_list_abandono_id ? parseInt(kit.st_list_abandono_id) : null;
    let abandonoId2 = kit.st_list_abandono_id_2 ? parseInt(kit.st_list_abandono_id_2) : null;
    let compraId = kit.st_list_compra_id ? parseInt(kit.st_list_compra_id) : null;
    let compraId2 = kit.st_list_compra_id_2 ? parseInt(kit.st_list_compra_id_2) : null;

    // Comparação normalizada (sem espaço, hífen, pontuação ou caixa): as listas são nomeadas por
    // FAMÍLIA de produto ("[NeuroMind Pro]") e os produtos vêm do gateway por SKU
    // ("M1 - NeuroMind Pro (2 Bottles)"), então o casamento é por substring. Sem normalizar, uma
    // lista "[Night Calm]" não casaria com o produto "UP2 - NightCalm" — mesma família, escrita
    // diferente. Normalizar remove essa classe inteira de falso negativo.
    const kitKey = normalizeForMatch(kit.name);

    // Esta função roda uma vez PARA CADA CONTA da SlickText do cliente (o chamador itera as
    // contas). O slot 1 fica com a primeira lista encontrada e nunca é sobrescrito — mesmo
    // comportamento de sempre. A novidade é o slot 2: se o produto já tem uma lista (de uma
    // chamada anterior, outra conta) e ESTA conta tem outra lista da MESMA família com ID
    // diferente, essa segunda lista é candidata a sinal de que o produto é vendido por mais de um
    // gateway de lead (Digistore, JVZoo, BuyGoods) — mas só ENTRA se o retrato provar que ela
    // recebe contato de verdade (ver candidataDeSegundaListaCresceu). Lista congelada nunca é
    // aceita, mesmo com o nome batendo perfeito.
    for (const [product, listId] of abandonoByProduct) {
      if (!kitKey.includes(normalizeForMatch(product))) continue;
      if (!abandonoId) { abandonoId = listId; break; }
      if (listId !== abandonoId && !abandonoId2 && await candidataDeSegundaListaCresceu(clientId, listId)) { abandonoId2 = listId; break; }
    }
    for (const [product, listId] of compraByProduct) {
      if (!kitKey.includes(normalizeForMatch(product))) continue;
      if (!compraId) { compraId = listId; break; }
      if (listId !== compraId && !compraId2 && await candidataDeSegundaListaCresceu(clientId, listId)) { compraId2 = listId; break; }
    }

    if (abandonoId !== (kit.st_list_abandono_id ? parseInt(kit.st_list_abandono_id) : null)
        || abandonoId2 !== (kit.st_list_abandono_id_2 ? parseInt(kit.st_list_abandono_id_2) : null)
        || compraId !== (kit.st_list_compra_id ? parseInt(kit.st_list_compra_id) : null)
        || compraId2 !== (kit.st_list_compra_id_2 ? parseInt(kit.st_list_compra_id_2) : null)) {
      await query(
        `UPDATE kits SET st_list_abandono_id = $1, st_list_abandono_id_2 = $2, st_list_compra_id = $3, st_list_compra_id_2 = $4 WHERE id = $5`,
        [abandonoId ? String(abandonoId) : null, abandonoId2 ? String(abandonoId2) : null, compraId ? String(compraId) : null, compraId2 ? String(compraId2) : null, kit.id]
      );
      linked++;
    }

    if (!abandonoId) unmatched.push({ kitId: kit.id, kitName: kit.name });
  }

  return { linked, unmatched };
}
