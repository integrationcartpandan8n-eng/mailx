/**
 * Retrato diário das listas da SlickText — gravação automática.
 *
 * Por que existe: leads por período são a diferença entre dois retratos do tamanho de cada lista, e
 * a API da SlickText não conta contatos de uma lista dentro de um período. Até aqui o retrato era
 * gravado de carona, quando alguém abria a aba SMS de um cliente — o que deixava a série com
 * buracos: no cliente de referência havia 5 retratos em 8 dias, e por isso qualquer recorte de 30
 * dias caía no total vitalício, e recortes curtos caíam na tolerância de 3 dias com a janela de
 * leads maior que a das vendas.
 *
 * Um dia sem retrato é perdido para sempre: não existe como recuperar retroativamente quantos
 * contatos uma lista tinha ontem. Por isso a gravação passa a ser do servidor, e não do visitante.
 *
 * Como roda: verifica de meia em meia hora se o retrato de HOJE já existe, e grava o que faltar.
 * Não é um horário fixo de propósito — com horário fixo, um restart ou uma indisponibilidade da
 * SlickText naquele minuto exato custaria o dia inteiro. Verificando com frequência, o dia é
 * gravado na primeira janela em que der, e as verificações seguintes não fazem nada.
 */
import { query } from '../db/database';
import { SlickTextClient } from '../services/slicktext';
import { logger } from '../utils/logger';

const CTX = 'RetratoListas';
const INTERVALO_MS = 30 * 60 * 1000;
const ATRASO_INICIAL_MS = 60 * 1000; // deixa o servidor subir antes de sair consultando API externa

type ContaSt = { clientId: number; accountId: number | null; token: string; brandId: string };

async function contasComSlickText(): Promise<ContaSt[]> {
  const principais = await query<{ id: number; st_api_token: string; st_brand_id: string }>(
    `SELECT id, st_api_token, st_brand_id FROM clients
     WHERE st_api_token IS NOT NULL AND st_brand_id IS NOT NULL AND status <> 'paused'`
  );
  const extras = await query<{ client_id: number; id: number; st_api_token: string; st_brand_id: string }>(
    `SELECT a.client_id, a.id, a.st_api_token, a.st_brand_id
     FROM client_slicktext_accounts a
     JOIN clients c ON c.id = a.client_id
     WHERE c.status <> 'paused'`
  );
  return [
    ...principais.map(c => ({ clientId: c.id, accountId: null, token: c.st_api_token, brandId: c.st_brand_id })),
    ...extras.map(a => ({ clientId: a.client_id, accountId: a.id, token: a.st_api_token, brandId: a.st_brand_id })),
  ];
}

/**
 * Grava o retrato de hoje das listas que ainda não têm. Devolve quantas listas foram gravadas.
 *
 * Uma lista é contada em TODAS as contas do cliente e vale o MAIOR valor: um list_id existe em uma
 * conta só, e nas outras a chamada falha e devolve 0 — somar contaria a mesma lista de novo se duas
 * respondessem, e usar a primeira resposta gravaria 0 quando a conta errada respondesse primeiro.
 */
export async function gravarRetratosDeHoje(): Promise<{ gravadas: number; jaTinham: number; falhas: number }> {
  const resultado = { gravadas: 0, jaTinham: 0, falhas: 0 };

  const listas = await query<{ client_id: number; list_id: string }>(
    `SELECT DISTINCT k.client_id, x.list_id
     FROM kits k
     CROSS JOIN LATERAL (VALUES (k.st_list_compra_id), (k.st_list_abandono_id)) AS x(list_id)
     JOIN clients c ON c.id = k.client_id
     WHERE k.enabled = true AND x.list_id IS NOT NULL AND c.status <> 'paused'`
  );
  if (listas.length === 0) return resultado;

  // O que já tem retrato de hoje sai da fila antes de qualquer chamada externa: numa segunda
  // passada do dia isso zera o trabalho e não gasta uma requisição sequer.
  const jaGravadas = await query<{ client_id: number; list_id: string }>(
    `SELECT DISTINCT client_id, list_id FROM list_contact_snapshots WHERE snapshot_date = CURRENT_DATE`
  );
  const jaTem = new Set(jaGravadas.map(r => `${r.client_id}:${r.list_id}`));
  const pendentes = listas.filter(l => !jaTem.has(`${l.client_id}:${l.list_id}`));
  resultado.jaTinham = listas.length - pendentes.length;
  if (pendentes.length === 0) return resultado;

  const contas = await contasComSlickText();
  const porCliente = new Map<number, ContaSt[]>();
  for (const c of contas) {
    const arr = porCliente.get(c.clientId) ?? [];
    arr.push(c);
    porCliente.set(c.clientId, arr);
  }

  for (const lista of pendentes) {
    const doCliente = porCliente.get(lista.client_id);
    if (!doCliente || doCliente.length === 0) continue;

    let melhor = { count: 0, accountId: null as number | null };
    for (const conta of doCliente) {
      try {
        const st = new SlickTextClient(conta.token, conta.brandId);
        const count = await st.getListContactCount(parseInt(lista.list_id));
        if (count > melhor.count) melhor = { count, accountId: conta.accountId };
      } catch {
        // Conta que não tem essa lista responde erro — esperado, não é falha do job.
      }
    }

    // Zero não é gravado: pode ser lista realmente vazia ou nenhuma conta ter respondido, e as duas
    // são indistinguíveis daqui. Gravar 0 criaria um degrau falso na diferença entre dois dias — a
    // lista pareceria ter perdido todos os contatos e ganhado de volta no dia seguinte.
    if (melhor.count <= 0) {
      resultado.falhas++;
      continue;
    }

    try {
      await query(
        `INSERT INTO list_contact_snapshots (client_id, st_account_id, list_id, snapshot_date, contact_count)
         VALUES ($1, $2, $3, CURRENT_DATE, $4)
         ON CONFLICT (client_id, COALESCE(st_account_id, 0), list_id, snapshot_date)
         DO UPDATE SET contact_count = EXCLUDED.contact_count`,
        [lista.client_id, melhor.accountId, lista.list_id, melhor.count]
      );
      resultado.gravadas++;
    } catch (err: any) {
      logger.warn(CTX, `Falha ao gravar retrato da lista ${lista.list_id} (cliente ${lista.client_id}): ${err.message}`);
      resultado.falhas++;
    }
  }

  return resultado;
}

export function startListSnapshotJob(): void {
  const rodar = async () => {
    try {
      const r = await gravarRetratosDeHoje();
      if (r.gravadas > 0 || r.falhas > 0) {
        logger.info(CTX, `Retratos de hoje: ${r.gravadas} gravadas, ${r.jaTinham} já tinham, ${r.falhas} sem contagem`);
      }
    } catch (err: any) {
      // Nunca derruba o servidor: o retrato é para o relatório de amanhã, não para a requisição de
      // agora. Falhar em silêncio ruidoso (log) é melhor que matar o processo.
      logger.error(CTX, `Job de retratos falhou: ${err.message}`);
    }
  };

  setTimeout(rodar, ATRASO_INICIAL_MS);
  setInterval(rodar, INTERVALO_MS).unref();
  logger.info(CTX, `Gravação automática de retratos ligada (verifica a cada ${INTERVALO_MS / 60000} min)`);
}
