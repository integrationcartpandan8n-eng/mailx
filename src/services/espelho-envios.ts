/**
 * Camada de leitura/escrita do espelho local de envios por mensagem de automação (SlickText).
 *
 * Existe pra parar de depender de countWorkflowNodeMessages() (busca binária sobre
 * GET /messages?offset=N) pra saber envios/créditos de um período — medido em produção que
 * essa paginação fica mais lenta conforme o offset cresce, e já derrubou requisições em
 * 502/504 do nginx pra automações de alto volume. O job automacao-envios-sync.ts grava aqui;
 * o router lê daqui, caindo pro caminho ao vivo (countWorkflowNodeMessages) quando o espelho
 * não cobre o período pedido — nunca o contrário.
 *
 * Compartilhado entre job e router de propósito: a chave de quatro partes e os limites de
 * período só existem escritos UMA vez.
 */

import { query, queryOne } from '../db/database';
import { env } from '../config/env';
import { MensagemDeNode } from './slicktext';

export interface ChaveNode {
  clientId: number;
  stAccountId: number | null;
  workflowId: number;
  nodeId: number;
}

export type ResultadoEspelho =
  | {
      ok: true;
      envios: number;
      creditos: number;
      cobreDesde: string;
      espelhadoAte: string | null;
      sincronizadoEm: string;
      defasagemMin: number;
    }
  | {
      ok: false;
      motivo:
        | 'desligado'
        | 'sem-estado'
        | 'sem-semente'
        | 'degradado'
        | 'periodo-antes-da-cobertura'
        | 'sync-atrasada'
        | 'erro-no-banco';
      detalhe: string;
    };

/** 3 ticks (10 min cada) + folga — ver INTERVALO_MS em automacao-envios-sync.ts. */
export const FRESCOR_MAX_MS = 35 * 60 * 1000;

interface LinhaEstado {
  situacao: string;
  motivo_degradado: string | null;
  cobre_desde: string | null;
  ultimo_created: string | null;
  ultima_sync_em: string | null;
}

/**
 * Envios e créditos de UMA mensagem de automação num período, direto do espelho local.
 * `ok:false` = o espelho não pode responder este período com confiança; o chamador cai no
 * caminho ao vivo (countWorkflowNodeMessages), exatamente como fazia antes deste arquivo
 * existir.
 *
 * `fromYmd`/`toYmd` devem ser as MESMAS strings ("YYYY-MM-DD") que o chamador passaria pra
 * countWorkflowNodeMessages (start.slice(0,10) / end.slice(0,10)) — nenhuma lógica de data
 * nova entra aqui, de propósito, pra não abrir uma segunda definição de "dia" na base.
 *
 * NUNCA lança: uma falha na consulta do espelho não pode derrubar uma rota que responderia
 * bem pelo caminho ao vivo.
 */
export async function enviosDoEspelho(
  chave: ChaveNode,
  fromYmd: string,
  toYmd: string
): Promise<ResultadoEspelho> {
  if (env.ESPELHO_ENVIOS_LEITURA !== 'on') {
    return { ok: false, motivo: 'desligado', detalhe: 'ESPELHO_ENVIOS_LEITURA não está "on"' };
  }

  let estado: LinhaEstado | null;
  try {
    estado = await queryOne<LinhaEstado>(
      `SELECT situacao, motivo_degradado, cobre_desde::text, ultimo_created::text, ultima_sync_em::text
       FROM automacao_sync_estado
       WHERE client_id = $1 AND COALESCE(st_account_id, 0) = COALESCE($2::int, 0)
         AND workflow_id = $3 AND node_id = $4`,
      [chave.clientId, chave.stAccountId, chave.workflowId, chave.nodeId]
    );
  } catch (err: any) {
    return { ok: false, motivo: 'erro-no-banco', detalhe: err.message };
  }

  if (!estado) {
    return { ok: false, motivo: 'sem-estado', detalhe: 'nó ainda não apareceu na enumeração do job' };
  }
  if (estado.situacao === 'degradado') {
    return { ok: false, motivo: 'degradado', detalhe: estado.motivo_degradado || '(sem motivo registrado)' };
  }
  if (estado.situacao !== 'ativo' || !estado.cobre_desde) {
    return { ok: false, motivo: 'sem-semente', detalhe: `situacao=${estado.situacao}` };
  }
  // Comparação lexicográfica de "YYYY-MM-DD" é correta e evita mais um parse de data.
  if (fromYmd < estado.cobre_desde) {
    return {
      ok: false,
      motivo: 'periodo-antes-da-cobertura',
      detalhe: `período pedido começa em ${fromYmd}, espelho cobre desde ${estado.cobre_desde}`,
    };
  }
  // Mesmo padrão de client-detail.html (fmtDataHora): TIMESTAMP sem fuso vem como texto com
  // espaço ("2026-08-15 12:30:00"), não em ISO — troca por 'T' e marca como UTC antes do parse.
  const ultimaSyncMs = estado.ultima_sync_em
    ? Date.parse(`${estado.ultima_sync_em.replace(' ', 'T')}Z`)
    : NaN;
  const defasagemMs = Number.isFinite(ultimaSyncMs) ? Date.now() - ultimaSyncMs : Infinity;
  if (defasagemMs > FRESCOR_MAX_MS) {
    return {
      ok: false,
      motivo: 'sync-atrasada',
      detalhe: `última sincronização há ${Math.round(defasagemMs / 60000)} min (limite ${FRESCOR_MAX_MS / 60000} min)`,
    };
  }

  try {
    const soma = await queryOne<{ envios: number; creditos: number }>(
      `SELECT COUNT(*)::int AS envios, COALESCE(SUM(COALESCE(creditos, 1)), 0)::float8 AS creditos
       FROM automacao_envios
       WHERE client_id = $1 AND COALESCE(st_account_id, 0) = COALESCE($2::int, 0)
         AND workflow_id = $3 AND node_id = $4
         AND enviado_em >= $5::timestamp AND enviado_em <= $6::timestamp`,
      [chave.clientId, chave.stAccountId, chave.workflowId, chave.nodeId, `${fromYmd} 00:00:00`, `${toYmd} 23:59:59`]
    );
    return {
      ok: true,
      envios: soma?.envios ?? 0,
      creditos: soma?.creditos ?? 0,
      cobreDesde: estado.cobre_desde,
      espelhadoAte: estado.ultimo_created,
      sincronizadoEm: estado.ultima_sync_em ?? '',
      defasagemMin: Number.isFinite(defasagemMs) ? Math.round(defasagemMs / 60000) : -1,
    };
  } catch (err: any) {
    return { ok: false, motivo: 'erro-no-banco', detalhe: err.message };
  }
}

/**
 * Insere um lote de mensagens já lidas, ignorando o que já existe (idempotente via o índice
 * único). Devolve quantas linhas ENTRARAM de verdade — é o detector de duplicata/instabilidade
 * de `_id` usado pelo job (se um relance da janela de sobreposição insere muito mais do que
 * o esperado, `_id` pode não ser estável, e isso vira alarme no log).
 *
 * Mensagens sem `messageId` ou sem `created` normalizado são descartadas ANTES de chegar
 * aqui (ver automacao-envios-sync.ts) — nunca gravamos uma linha adivinhada.
 */
export async function gravarLoteDeEnvios(
  chave: ChaveNode,
  msgs: Array<Pick<MensagemDeNode, 'messageId' | 'created' | 'createdRaw' | 'credits' | 'status' | 'direction'>>
): Promise<{ recebidas: number; inseridas: number }> {
  if (msgs.length === 0) return { recebidas: 0, inseridas: 0 };

  const ids = msgs.map((m) => m.messageId as string);
  const createds = msgs.map((m) => m.created as string);
  const createdsRaw = msgs.map((m) => m.createdRaw);
  const creditos = msgs.map((m) => (m.credits != null ? String(m.credits) : null));
  const status = msgs.map((m) => m.status);
  const direcao = msgs.map((m) => m.direction);

  const inseridas = await query<{ id: number }>(
    `INSERT INTO automacao_envios
       (client_id, st_account_id, workflow_id, node_id,
        slicktext_message_id, enviado_em, created_raw, creditos, status, direcao)
     SELECT $1::int, $2::int, $3::int, $4::int,
            u.msg_id, u.enviado_em::timestamp, u.created_raw, u.creditos::numeric, u.status, u.direcao
     FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
          AS u(msg_id, enviado_em, created_raw, creditos, status, direcao)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [chave.clientId, chave.stAccountId, chave.workflowId, chave.nodeId, ids, createds, createdsRaw, creditos, status, direcao]
  );

  return { recebidas: msgs.length, inseridas: inseridas.length };
}
