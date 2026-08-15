/**
 * Sincronização incremental do espelho local de envios por mensagem de automação (SlickText).
 *
 * Ver o comentário grande em src/db/database.ts (ESPELHO LOCAL DE ENVIOS POR MENSAGEM DE
 * AUTOMAÇÃO) pra motivação completa. Resumo: countWorkflowNodeMessages() (busca binária sobre
 * /messages?offset=N) foi medida em produção ficando mais lenta conforme o offset cresce, já
 * causando 502/504 pra automações de alto volume — exatamente as que o botão "Calcular" dos
 * Créditos por Automação soma, mensagem por mensagem, sequencialmente. Este job grava o que a
 * API já respondeu (mesmo espírito de list-snapshots.ts, mas por EVENTO, não por total diário),
 * e src/services/espelho-envios.ts serve as leituras a partir daqui, com fallback pro caminho ao
 * vivo sempre que o espelho não cobrir o período pedido.
 *
 * Só sincroniza DAQUI PRA FRENTE: cada node é semeado UMA vez perto da ponta viva (nunca faz
 * backfill do histórico inteiro — isso pagaria de novo o preço do offset alto que o espelho
 * existe pra evitar), e todo tick subsequente busca só o que é NOVO, sempre perto da ponta,
 * sempre barato.
 */

import { query } from '../db/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { SlickTextClient, MensagemDeNode } from '../services/slicktext';
import { ChaveNode, gravarLoteDeEnvios } from '../services/espelho-envios';

const CTX = 'EspelhoEnvios';

const INTERVALO_MS = 10 * 60 * 1000;   // tick de 10 min
const ATRASO_INICIAL_MS = 3 * 60 * 1000; // deixa o servidor terminar de subir antes de sair na API

const ORCAMENTO_TICK_MS = 4 * 60 * 1000;    // < INTERVALO_MS, ticks nunca se encavalam
const ORCAMENTO_SEMENTE_MS = 90 * 1000;     // fatia RESERVADA pra semeadura, não sobra da incremental
const ORCAMENTO_POR_NODE_MS = 45 * 1000;
const MAX_REQS_POR_NODE = 25;
const MAX_SEMENTES_POR_TICK = 2;
const TIMEOUT_REQ_MS = 60 * 1000;

const LOTE = 100;              // limite máximo aceito por /messages (confirmado em produção)
const SOBREPOSICAO = 250;      // quantos offsets reler pra reencontrar a âncora
// Quanto a âncora fica pra trás da ponta real. Em rows, não em tempo: nunca provamos (mesmo
// tentando duas vezes) que a lista é estável bem na ponta viva sob escrita concorrente — só
// longe dela. Um recuo em linhas não depende de comparar `created` (fuso ainda não confirmado)
// contra o relógio, e faz os últimos itens serem relidos e reconfirmados no próximo tick,
// quando já não estiverem na borda.
const RECUO_ASSENTAMENTO = 50;

// Um node degradado só volta a ser tentado depois deste intervalo — evita bater na mesma
// falha a cada 10 min se o motivo real ainda não foi resolvido, mas ainda assim se autocura
// sem intervenção manual quando a causa era passageira (rede, sha_sign etc.).
const RECUPERACAO_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_RECUPERACOES_POR_TICK = 3;

interface EstadoCombo {
  situacao: string;
  motivo_degradado: string | null;
  offset_semente: number | null;
  semente_progresso_offset: number | null;
  proximo_offset: number;
  ancora_message_id: string | null;
  ancora_offset: number | null;
  cobre_desde: string | null;
  ultima_sync_em: string | null;
  atualizado_em: string | null;
}

interface ComboVinculado {
  clientId: number;
  stAccountId: number | null;
  workflowId: number;
  nodeId: number;
  estado: EstadoCombo | null;
}

interface Credencial {
  token: string;
  brandId: string;
}

let rodando = false;

function hojeLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.APP_TZ }).format(new Date());
}

function diaSeguinte(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Todo vínculo Workflow com node_id (client_id, st_account_id, workflow_id, node_id), com o
 * estado de sincronização já existente quando houver. Roda no INÍCIO de todo tick — um vínculo
 * novo em sms_campaign_map aparece aqui automaticamente no próximo tick, sem registro manual.
 *
 * DISTINCT importa de verdade: sms_campaign_map é único só em (client_id, utm_campaign), então
 * duas mensagens (utms) podem apontar pro MESMO node.
 */
async function enumerarCombos(): Promise<ComboVinculado[]> {
  const linhas = await query<{
    client_id: number; st_account_id: number | null; workflow_id: number; node_id: number;
    situacao: string | null; motivo_degradado: string | null;
    offset_semente: number | null; semente_progresso_offset: number | null;
    proximo_offset: number | null; ancora_message_id: string | null; ancora_offset: number | null;
    cobre_desde: string | null; ultima_sync_em: string | null; atualizado_em: string | null;
  }>(
    `WITH vinculos AS (
       SELECT DISTINCT
              m.client_id, m.st_account_id,
              m.slicktext_campaign_id AS workflow_id,
              m.workflow_node_id      AS node_id
       FROM sms_campaign_map m
       JOIN clients c ON c.id = m.client_id
       WHERE m.source_type = 'Workflow'
         AND m.workflow_node_id IS NOT NULL
         AND m.slicktext_campaign_id IS NOT NULL
         AND c.status <> 'paused'
     )
     SELECT v.client_id, v.st_account_id, v.workflow_id, v.node_id,
            e.situacao, e.motivo_degradado, e.offset_semente, e.semente_progresso_offset, e.proximo_offset,
            e.ancora_message_id, e.ancora_offset, e.cobre_desde::text AS cobre_desde,
            e.ultima_sync_em::text AS ultima_sync_em, e.atualizado_em::text AS atualizado_em
     FROM vinculos v
     LEFT JOIN automacao_sync_estado e
            ON e.client_id = v.client_id
           AND COALESCE(e.st_account_id, 0) = COALESCE(v.st_account_id, 0)
           AND e.workflow_id = v.workflow_id
           AND e.node_id     = v.node_id
     ORDER BY e.ultima_sync_em ASC NULLS FIRST`
  );

  return linhas.map((r) => ({
    clientId: r.client_id,
    stAccountId: r.st_account_id,
    workflowId: r.workflow_id,
    nodeId: r.node_id,
    estado: r.situacao == null ? null : {
      situacao: r.situacao,
      motivo_degradado: r.motivo_degradado,
      offset_semente: r.offset_semente,
      semente_progresso_offset: r.semente_progresso_offset,
      proximo_offset: r.proximo_offset ?? 0,
      ancora_message_id: r.ancora_message_id,
      ancora_offset: r.ancora_offset,
      cobre_desde: r.cobre_desde,
      ultima_sync_em: r.ultima_sync_em,
      atualizado_em: r.atualizado_em,
    },
  }));
}

/** Mesmo padrão de contasComSlickText() em list-snapshots.ts, carregado uma vez por tick. */
async function carregarCredenciais(): Promise<Map<string, Credencial>> {
  const mapa = new Map<string, Credencial>();
  const principais = await query<{ id: number; st_api_token: string; st_brand_id: string }>(
    `SELECT id, st_api_token, st_brand_id FROM clients WHERE st_api_token IS NOT NULL AND st_brand_id IS NOT NULL`
  );
  for (const c of principais) mapa.set(`${c.id}:null`, { token: c.st_api_token, brandId: c.st_brand_id });

  const extras = await query<{ client_id: number; id: number; st_api_token: string; st_brand_id: string }>(
    `SELECT client_id, id, st_api_token, st_brand_id FROM client_slicktext_accounts`
  );
  for (const a of extras) mapa.set(`${a.client_id}:${a.id}`, { token: a.st_api_token, brandId: a.st_brand_id });

  return mapa;
}

function resolverCredencial(mapa: Map<string, Credencial>, clientId: number, stAccountId: number | null): Credencial | null {
  return mapa.get(`${clientId}:${stAccountId ?? 'null'}`) ?? null;
}

async function marcarDegradado(combo: ComboVinculado, motivo: string): Promise<void> {
  logger.warn(CTX, `Node ${combo.workflowId}/${combo.nodeId} (cliente ${combo.clientId}) degradado: ${motivo}`);
  await query(
    `UPDATE automacao_sync_estado
     SET situacao = 'degradado', motivo_degradado = $5, atualizado_em = NOW()
     WHERE client_id = $1 AND COALESCE(st_account_id, 0) = COALESCE($2::int, 0)
       AND workflow_id = $3 AND node_id = $4`,
    [combo.clientId, combo.stAccountId, combo.workflowId, combo.nodeId, motivo]
  );
}

/**
 * Persiste uma exceção não tratada de sincronizarNode/semearNode em ultima_falha/ultima_falha_em
 * — sem isso, um node que segue 'ativo' mas falha em TODO tick (rede, credencial, erro de
 * banco fora dos três gatilhos de marcarDegradado) fica com o mesmo estado persistido de um
 * node recém-semeado esperando o primeiro sync (cobre_desde=NULL, ultima_sync_em=NULL) — sem
 * nenhum jeito de distinguir "prestes a sincronizar" de "quebrado em silêncio há semanas".
 * Melhor esforço: se o node ainda não tem linha em automacao_sync_estado, o UPDATE não afeta
 * nada e a falha continua visível só pelo log — não é regressão, é o mesmo que já acontecia.
 */
async function registrarFalha(combo: ComboVinculado, mensagem: string): Promise<void> {
  try {
    await query(
      `UPDATE automacao_sync_estado
       SET ultima_falha = $5, ultima_falha_em = NOW(), atualizado_em = NOW()
       WHERE client_id = $1 AND COALESCE(st_account_id, 0) = COALESCE($2::int, 0)
         AND workflow_id = $3 AND node_id = $4`,
      [combo.clientId, combo.stAccountId, combo.workflowId, combo.nodeId, String(mensagem).slice(0, 2000)]
    );
  } catch (err: any) {
    logger.warn(CTX, `Não consegui registrar falha do node ${combo.workflowId}/${combo.nodeId}: ${err.message}`);
  }
}

/**
 * Semeia um node novo: acha um offset perto da ponta viva (nunca o histórico inteiro) e marca
 * o node como pronto pra sincronização incremental. Pode levar mais de um tick pra convergir
 * numa automação de altíssimo volume — `semente_progresso_offset` guarda o progresso.
 */
async function semearNode(combo: ComboVinculado, cred: Credencial): Promise<void> {
  const st = new SlickTextClient(cred.token, cred.brandId);
  const retomarDe = combo.estado?.semente_progresso_offset ?? 0;

  const ponta = await st.descobrirPontaDeMensagens(combo.workflowId, combo.nodeId, {
    retomarDe,
    orcamentoMs: ORCAMENTO_POR_NODE_MS,
    maxRequisicoes: 12,
    timeoutMs: TIMEOUT_REQ_MS,
  });

  // Node sem mensagem nenhuma: espelho responde 0 pra qualquer período, o que já está certo.
  // cobre_desde = hoje (conservador — não sabemos quando o node foi criado).
  if (ponta.loCheio === null && ponta.hiVazio === 0) {
    await query(
      `INSERT INTO automacao_sync_estado
         (client_id, st_account_id, workflow_id, node_id, situacao, offset_semente, proximo_offset,
          cobre_desde, vitalicio_na_semente, semente_em, ultima_sync_em)
       VALUES ($1, $2, $3, $4, 'ativo', 0, 0, $5::date, 0, NOW(), NOW())
       ON CONFLICT (client_id, COALESCE(st_account_id, 0), workflow_id, node_id)
       DO UPDATE SET situacao = 'ativo', offset_semente = 0, proximo_offset = 0, cobre_desde = $5::date,
                     vitalicio_na_semente = 0, semente_em = NOW(), ultima_sync_em = NOW(), atualizado_em = NOW()`,
      [combo.clientId, combo.stAccountId, combo.workflowId, combo.nodeId, hojeLocal()]
    );
    return;
  }

  // Retomando um galope anterior que já não bate (lista encolheu, ou a semente anterior
  // avançou demais) — sem convicção nenhuma pra decidir; mantém pendente e tenta de novo.
  if (ponta.loCheio === null) {
    logger.warn(
      CTX,
      `Semeadura do node ${combo.workflowId}/${combo.nodeId} sem convicção (retomarDe=${retomarDe} já vazio) — mantendo pendente`
    );
    return;
  }

  // Galope não convergiu dentro do orçamento: grava o progresso e tenta de novo no próximo
  // tick a partir daqui. NÃO semeia com um chute — a semente define a cobertura anunciada.
  if (!ponta.exato) {
    await query(
      `INSERT INTO automacao_sync_estado
         (client_id, st_account_id, workflow_id, node_id, situacao, semente_progresso_offset)
       VALUES ($1, $2, $3, $4, 'semente_pendente', $5)
       ON CONFLICT (client_id, COALESCE(st_account_id, 0), workflow_id, node_id)
       DO UPDATE SET situacao = 'semente_pendente', semente_progresso_offset = $5, atualizado_em = NOW()`,
      [combo.clientId, combo.stAccountId, combo.workflowId, combo.nodeId, ponta.loCheio]
    );
    return;
  }

  // Semeia em loCheio (sempre por baixo — ver descobrirPontaDeMensagens). O vitalício vira a
  // "régua" de auditoria (comparar vitalício de agora menos este contra linhas_totais).
  const vitalicio = await st
    .getWorkflowNodeAnalytics(combo.workflowId, combo.nodeId, '2000-01-01', '2100-01-01')
    .then((d: any) => (typeof d?.totals?.messages === 'number' ? d.totals.messages : null))
    .catch(() => null);

  await query(
    `INSERT INTO automacao_sync_estado
       (client_id, st_account_id, workflow_id, node_id, situacao, offset_semente, proximo_offset,
        semente_progresso_offset, vitalicio_na_semente, semente_em)
     VALUES ($1, $2, $3, $4, 'ativo', $5, $5, NULL, $6, NOW())
     ON CONFLICT (client_id, COALESCE(st_account_id, 0), workflow_id, node_id)
     DO UPDATE SET situacao = 'ativo', offset_semente = $5, proximo_offset = $5,
                   semente_progresso_offset = NULL, vitalicio_na_semente = $6, semente_em = NOW(),
                   atualizado_em = NOW()`,
    [combo.clientId, combo.stAccountId, combo.workflowId, combo.nodeId, ponta.loCheio, vitalicio]
  );
  logger.info(CTX, `Node ${combo.workflowId}/${combo.nodeId} (cliente ${combo.clientId}) semeado no offset ${ponta.loCheio}`);
}

/**
 * Sincronização incremental de um node já ativo: relê a janela de sobreposição, reencontra a
 * âncora pelo `_id`, grava só o que vem depois dela, e recua a âncora ~50 linhas da ponta —
 * nunca confia que os últimos itens lidos agora já "assentaram".
 */
async function sincronizarNode(combo: ComboVinculado, cred: Credencial): Promise<{ inseridas: number }> {
  const inicioNode = Date.now();
  const st = new SlickTextClient(cred.token, cred.brandId);
  const estado = combo.estado!;
  const offsetSemente = estado.offset_semente ?? 0;
  const proximoOffset = estado.proximo_offset;
  const anteriorAncoraId = estado.ancora_message_id;
  const anteriorAncoraOffset = estado.ancora_offset;

  const inicioLeitura = Math.max(offsetSemente, proximoOffset - SOBREPOSICAO);

  let reqs = 0;
  const buffer: Array<{ offset: number; msg: MensagemDeNode }> = [];
  let offset = inicioLeitura;
  let fimDaLista = false;

  while (!fimDaLista && reqs < MAX_REQS_POR_NODE && Date.now() - inicioNode < ORCAMENTO_POR_NODE_MS) {
    const msgs = await st.lerMensagensDoNode(combo.workflowId, combo.nodeId, offset, LOTE, { timeoutMs: TIMEOUT_REQ_MS });
    reqs++;
    msgs.forEach((msg, i) => buffer.push({ offset: offset + i, msg }));
    if (msgs.length < LOTE) fimDaLista = true;
    else offset += LOTE;
  }

  if (buffer.length === 0) {
    // Node sem NENHUMA mensagem desde a semente (estado válido, montado por semearNode:
    // offset_semente=0, proximo_offset=0, sem âncora ainda) — buffer vazio aqui é "continua
    // sem nada", não "lista encolheu". Só atualiza o frescor pra não cair em sync-atrasada.
    if (anteriorAncoraId == null && offsetSemente === 0 && proximoOffset === 0) {
      await query(
        `UPDATE automacao_sync_estado
         SET ultima_sync_em = NOW(), requisicoes_ultimo_tick = $5, ms_ultimo_tick = $6, atualizado_em = NOW()
         WHERE client_id = $1 AND COALESCE(st_account_id, 0) = COALESCE($2::int, 0)
           AND workflow_id = $3 AND node_id = $4`,
        [combo.clientId, combo.stAccountId, combo.workflowId, combo.nodeId, reqs, Date.now() - inicioNode]
      );
      return { inseridas: 0 };
    }
    // Nem o offset da semente/marca d'água devolve item: a lista ENCOLHEU sob nossos pés.
    await marcarDegradado(combo, `sobreposição vazia lendo a partir do offset ${inicioLeitura} — lista pode ter encolhido`);
    return { inseridas: 0 };
  }

  // Âncora: é aqui que o pulo silencioso vira evento detectado, não um número errado.
  let novas: Array<{ offset: number; msg: MensagemDeNode }>;
  let deriva = 0;
  if (anteriorAncoraId != null) {
    const pos = buffer.findIndex((b) => b.msg.messageId === anteriorAncoraId);
    if (pos < 0) {
      // buffer[...].offset, não a variável de laço "offset" — esta só é incrementada em
      // páginas CHEIAS, então numa página final parcial (o caso normal de fim de lista) ela
      // subestima a extensão real do buffer em até LOTE-2, o que confundiria uma investigação
      // manual por log mesmo sem afetar a lógica de sync em si (que já usa buffer[...].offset).
      await marcarDegradado(
        combo,
        `âncora ${anteriorAncoraId} não encontrada relendo offsets ${inicioLeitura}..${buffer[buffer.length - 1].offset}`
      );
      return { inseridas: 0 };
    }
    deriva = buffer[pos].offset - (anteriorAncoraOffset ?? buffer[pos].offset);
    if (deriva !== 0) {
      logger.warn(CTX, `Node ${combo.workflowId}/${combo.nodeId}: âncora deslocou ${deriva} offset(s) — lista instável, recalibrando`);
    }
    novas = buffer.slice(pos + 1);
  } else {
    // Primeira sincronização pós-semente: tudo a partir da semente é novo.
    novas = buffer;
  }

  // Qualidade do payload — nada entra adivinhado.
  const semId = novas.filter((n) => !n.msg.messageId).length;
  if (semId > 0) {
    await marcarDegradado(combo, `${semId} item(ns) de /messages sem _id`);
    return { inseridas: 0 };
  }
  const semData = novas.filter((n) => !n.msg.created).length;
  if (semData > 0) {
    await marcarDegradado(combo, `${semData} item(ns) com "created" em formato inesperado`);
    return { inseridas: 0 };
  }

  const chave: ChaveNode = {
    clientId: combo.clientId, stAccountId: combo.stAccountId,
    workflowId: combo.workflowId, nodeId: combo.nodeId,
  };
  const r = await gravarLoteDeEnvios(chave, novas.map((n) => n.msg));

  // Âncora recuada da ponta encontrada NESTE tick — nunca abaixo de onde já estávamos.
  let novaAncoraId = anteriorAncoraId;
  let novaAncoraOffset = anteriorAncoraOffset;
  let novoProximoOffset = proximoOffset;
  const idxAncora = Math.max(0, buffer.length - 1 - RECUO_ASSENTAMENTO);
  const candidata = buffer[idxAncora];
  if (candidata.offset >= (anteriorAncoraOffset ?? -1)) {
    novaAncoraId = candidata.msg.messageId;
    novaAncoraOffset = candidata.offset;
    novoProximoOffset = candidata.offset + 1;
  }
  const ultimoCreated = buffer[buffer.length - 1].msg.created;

  // Sinal de recalibração indevida de âncora: menos linhas ENTRARAM do que as que a âncora
  // disse serem novas — algumas já existiam no espelho e o ON CONFLICT as absorveu como
  // duplicata. Só é suspeito quando a marca d'água REALMENTE avançou (novoProximoOffset
  // mudou) e mesmo assim os dados já existiam — em node de baixo volume, sem mensagem nova
  // entre um tick e outro, a mesma janela é relida e a âncora recai no mesmo lugar de
  // sempre (proximoOffset não muda); aí "novas" ser sempre a mesma fatia já gravada é o
  // estado estável esperado, não um alarme (visto em produção: dois nós de baixo volume
  // disparando isso em TODO tick sem nenhum dado se perder — ON CONFLICT já protege).
  if (anteriorAncoraId != null && novoProximoOffset !== proximoOffset && r.inseridas < novas.length) {
    logger.warn(
      CTX,
      `Node ${combo.workflowId}/${combo.nodeId}: só ${r.inseridas} de ${novas.length} linha(s) novas entraram mesmo com a marca d'água avançando — âncora pode estar mal calibrada`
    );
  }

  // cobre_desde só no PRIMEIRO lote de mensagens realmente lido — nunca um palpite na semente.
  let cobreDesde: string | null = null;
  if (!estado.cobre_desde && novas.length > 0) {
    const primeiroDia = novas[0].msg.created!.slice(0, 10);
    // +1 dia quando a semente não começou no offset 0: ela cai no meio de um dia, e servir
    // esse dia pela metade subcontaria em silêncio. Um dia a menos de cobertura é barato.
    cobreDesde = offsetSemente === 0 ? primeiroDia : diaSeguinte(primeiroDia);
  }

  await query(
    `UPDATE automacao_sync_estado
     SET situacao = 'ativo', motivo_degradado = NULL,
         ancora_message_id = $5, ancora_offset = $6, proximo_offset = $7,
         ultimo_created = COALESCE($8::timestamp, ultimo_created),
         cobre_desde = COALESCE(cobre_desde, $9::date),
         ultima_sync_em = NOW(), linhas_totais = linhas_totais + $10,
         requisicoes_ultimo_tick = $11, ms_ultimo_tick = $12, deriva_ultimo_tick = $13,
         atualizado_em = NOW()
     WHERE client_id = $1 AND COALESCE(st_account_id, 0) = COALESCE($2::int, 0)
       AND workflow_id = $3 AND node_id = $4`,
    [
      combo.clientId, combo.stAccountId, combo.workflowId, combo.nodeId,
      novaAncoraId, novaAncoraOffset, novoProximoOffset,
      ultimoCreated, cobreDesde, r.inseridas, reqs, Date.now() - inicioNode, deriva,
    ]
  );

  return { inseridas: r.inseridas };
}

async function tick(): Promise<void> {
  if (env.ESPELHO_ENVIOS !== 'on') return;
  if (rodando) {
    logger.warn(CTX, 'Tick anterior ainda rodando — pulando este (pm2 roda em modo fork, um processo só)');
    return;
  }
  rodando = true;
  const inicio = Date.now();

  try {
    const combos = await enumerarCombos();
    const credenciais = await carregarCredenciais();

    const ativos = combos.filter((c) => c.estado?.situacao === 'ativo');
    const pendentes = combos.filter((c) => !c.estado || c.estado.situacao === 'semente_pendente');
    const degradados = combos.filter((c) => c.estado?.situacao === 'degradado');

    // Fase 1 — incremental primeiro (barata, mantém a frota inteira fresca).
    let sincronizados = 0;
    let linhasNovas = 0;
    let falhasSinc = 0;
    for (const combo of ativos) {
      if (Date.now() - inicio > ORCAMENTO_TICK_MS - ORCAMENTO_SEMENTE_MS) break;
      const cred = resolverCredencial(credenciais, combo.clientId, combo.stAccountId);
      if (!cred) continue;
      try {
        const r = await sincronizarNode(combo, cred);
        sincronizados++;
        linhasNovas += r.inseridas;
      } catch (err: any) {
        falhasSinc++;
        logger.warn(CTX, `Falha sincronizando node ${combo.workflowId}/${combo.nodeId} (cliente ${combo.clientId}): ${err.message}`);
        await registrarFalha(combo, err.message);
      }
    }

    // Fase 2 — semeadura depois, numa fatia RESERVADA (não nas sobras da fase 1).
    let sementes = 0;
    for (const combo of pendentes) {
      if (sementes >= MAX_SEMENTES_POR_TICK) break;
      if (Date.now() - inicio > ORCAMENTO_TICK_MS) break;
      const cred = resolverCredencial(credenciais, combo.clientId, combo.stAccountId);
      if (!cred) continue;
      try {
        await semearNode(combo, cred);
        sementes++;
      } catch (err: any) {
        logger.warn(CTX, `Falha semeando node ${combo.workflowId}/${combo.nodeId} (cliente ${combo.clientId}): ${err.message}`);
        await registrarFalha(combo, err.message);
      }
    }

    // Fase 3 — recuperação de degradados: tenta de novo depois de um período de espera,
    // reusando a MESMA sincronizarNode (ela já sabe reencontrar/recalibrar a âncora). Sem
    // isso, um node degradado ficava preso ali pra sempre — nenhum código em nenhum outro
    // lugar volta a marcar situacao='ativo' num node degradado.
    let recuperados = 0;
    const paraRecuperar = degradados.filter((c) => {
      const desde = c.estado?.atualizado_em ? Date.parse(`${c.estado.atualizado_em.replace(' ', 'T')}Z`) : NaN;
      return !Number.isFinite(desde) || Date.now() - desde > RECUPERACAO_COOLDOWN_MS;
    });
    for (const combo of paraRecuperar) {
      if (recuperados >= MAX_RECUPERACOES_POR_TICK) break;
      if (Date.now() - inicio > ORCAMENTO_TICK_MS) break;
      const cred = resolverCredencial(credenciais, combo.clientId, combo.stAccountId);
      if (!cred) continue;
      try {
        const r = await sincronizarNode(combo, cred);
        recuperados++;
        linhasNovas += r.inseridas;
      } catch (err: any) {
        logger.warn(CTX, `Falha recuperando node degradado ${combo.workflowId}/${combo.nodeId} (cliente ${combo.clientId}): ${err.message}`);
        await registrarFalha(combo, err.message);
      }
    }

    logger.info(
      CTX,
      `tick: ${ativos.length} ativo(s) — ${sincronizados} sincronizado(s), ${linhasNovas} linha(s) nova(s), ${falhasSinc} falha(s); ` +
        `${sementes}/${pendentes.length} semeadura(s); ${degradados.length} degradado(s) (${recuperados}/${paraRecuperar.length} recuperação(ões) tentada(s) neste tick); ${Date.now() - inicio}ms`
    );
    // Visibilidade consolidada: sem isto, um node degradado só aparecia no log do tick em que
    // degradou — grep depois disso não achava nada. Uma linha por tick com todos os
    // degradados + motivo (pm2 logs mailx-api | grep 'degradados ativos').
    if (degradados.length > 0) {
      const lista = degradados
        .map((c) => `${c.workflowId}/${c.nodeId}(cliente ${c.clientId})="${c.estado?.motivo_degradado ?? '?'}"`)
        .join('; ');
      logger.warn(CTX, `degradados ativos (${degradados.length}): ${lista}`);
    }
  } catch (err: any) {
    logger.error(CTX, `Falha no tick: ${err.message}`);
  } finally {
    rodando = false;
  }
}

export function startAutomacaoEnviosSync(): void {
  if (env.ESPELHO_ENVIOS !== 'on') {
    logger.warn(CTX, 'Espelho de envios DESLIGADO por ESPELHO_ENVIOS — /sms-campaign-sends segue 100% ao vivo');
    return;
  }
  const rodar = () => {
    tick().catch((err) => logger.error(CTX, `Falha não tratada no tick: ${err.message}`));
  };
  setTimeout(rodar, ATRASO_INICIAL_MS);
  setInterval(rodar, INTERVALO_MS).unref();
  logger.info(CTX, `Espelho de envios ligado (tick a cada ${INTERVALO_MS / 60000} min)`);
}
