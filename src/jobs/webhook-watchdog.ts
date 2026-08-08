/**
 * Vigia de webhook parado.
 *
 * Por que existe: em 03/08/2026 21:34 o banco caiu, os webhooks passaram a devolver erro e a
 * Digistore DESATIVOU sozinha as duas conexões de IPN. O sistema ficou 4 dias sem receber uma
 * única venda — 1.023 pagamentos e 384 reembolsos que nunca foram gravados — e NADA na tela
 * disse isso. A falha foi descoberta por acaso, quando alguém estranhou o painel vazio.
 *
 * Esse é o tipo de problema que dobra de tamanho a cada hora que passa despercebido, e o
 * conserto (reativar a conexão) leva 30 segundos. O caro é a demora em perceber.
 *
 * O limite não é chutado: sai da cadência do próprio cliente. Um cliente que vende de 10 em 10
 * minutos está claramente quebrado depois de 3 horas em silêncio; um que vende 3 vezes por dia,
 * não. Por isso o limite é um múltiplo do intervalo médio observado nos últimos 14 dias, preso
 * entre um piso e um teto para não virar alarme falso em fim de semana nem silêncio de uma
 * semana inteira sem aviso.
 *
 * Avisa UMA vez por episódio. Alerta que apita de meia em meia hora é alerta que se aprende a
 * ignorar — e aí a próxima queda de verdade passa batida junto com o ruído.
 */
import { query, queryOne } from '../db/database';
import { logger } from '../utils/logger';
import { notificar, canaisConfigurados } from '../services/notificador';

const CTX = 'VigiaWebhook';
const INTERVALO_MS = 30 * 60 * 1000;
const ATRASO_INICIAL_MS = 2 * 60 * 1000;

/** Quantas vezes o intervalo normal entre vendas pode passar antes de ser considerado silêncio. */
const FATOR_TOLERANCIA = 8;
const PISO_HORAS = 3;   // abaixo disso é oscilação normal, mesmo em cliente de altíssimo volume
const TETO_HORAS = 30;  // acima disso, qualquer cliente ativo já deveria ter vendido alguma coisa

export interface EstadoVigia {
  clientId: number;
  nome: string;
  ultimoWebhook: string | null;
  horasEmSilencio: number | null;
  limiteHoras: number;
  intervaloMedioMinutos: number | null;
  emSilencio: boolean;
}

/**
 * Calcula o limite de silêncio de um cliente a partir do intervalo médio entre vendas.
 *
 * Usa MEDIANA em vez de média: uma única madrugada parada puxaria a média para cima e afrouxaria
 * o alarme justamente no cliente que vende o dia inteiro. A mediana ignora esses extremos.
 */
async function limiteDeSilencio(clientId: number): Promise<{ limiteHoras: number; medianaMin: number | null }> {
  const r = await queryOne<{ mediana_min: string | null }>(
    `WITH vendas AS (
       SELECT created_at,
              LAG(created_at) OVER (ORDER BY created_at) AS anterior
       FROM webhook_logs
       WHERE client_id = $1
         AND event_type = 'order.paid'
         AND created_at >= NOW() - INTERVAL '14 days'
     )
     SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (created_at - anterior)) / 60
            ) AS mediana_min
     FROM vendas WHERE anterior IS NOT NULL`,
    [clientId]
  );

  const medianaMin = r?.mediana_min != null ? parseFloat(r.mediana_min) : null;

  // Sem histórico suficiente não dá pra saber a cadência — usa o teto, que só dispara em
  // silêncio longo o bastante para ser inequívoco. Chutar um limite apertado aqui geraria
  // alarme falso em cliente novo, e alarme falso no primeiro uso mata a confiança no aviso.
  if (medianaMin == null || !isFinite(medianaMin)) {
    return { limiteHoras: TETO_HORAS, medianaMin: null };
  }

  const bruto = (medianaMin * FATOR_TOLERANCIA) / 60;
  return { limiteHoras: Math.min(TETO_HORAS, Math.max(PISO_HORAS, Math.round(bruto))), medianaMin };
}

/** Diagnóstico de um cliente. Exportado porque o painel mostra o mesmo estado na tela. */
export async function estadoDoCliente(clientId: number, nome: string): Promise<EstadoVigia> {
  const ultimo = await queryOne<{ ultimo: string | null; horas: string | null }>(
    `SELECT MAX(created_at)::text AS ultimo,
            EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600 AS horas
     FROM webhook_logs WHERE client_id = $1`,
    [clientId]
  );

  const { limiteHoras, medianaMin } = await limiteDeSilencio(clientId);
  const horas = ultimo?.horas != null ? parseFloat(ultimo.horas) : null;

  return {
    clientId,
    nome,
    ultimoWebhook: ultimo?.ultimo ?? null,
    horasEmSilencio: horas,
    limiteHoras,
    intervaloMedioMinutos: medianaMin,
    // Cliente que nunca recebeu webhook nenhum não está "em silêncio" — está sem integração,
    // que é outro problema e não se resolve reativando conexão nenhuma.
    emSilencio: horas != null && horas > limiteHoras,
  };
}

/**
 * Chave do episódio: a hora do último webhook recebido. Enquanto o silêncio for o mesmo, a chave
 * é a mesma e o alerta não repete. Quando chegar venda e parar de novo, a chave muda e o próximo
 * episódio avisa — sem precisar limpar estado nem marcar nada como resolvido.
 */
function chaveDoEpisodio(ultimoWebhook: string | null): string {
  return ultimoWebhook ? `silencio-desde-${ultimoWebhook}` : 'sem-nenhum-webhook';
}

async function jaAvisou(clientId: number, chave: string): Promise<boolean> {
  const r = await queryOne<{ id: number }>(
    `SELECT id FROM alertas_enviados WHERE client_id = $1 AND tipo = 'webhook_parado' AND chave = $2`,
    [clientId, chave]
  );
  return !!r;
}

function formatarEspera(horas: number): string {
  if (horas < 24) return `${horas.toFixed(1)} horas`;
  const dias = Math.floor(horas / 24);
  const resto = Math.round(horas - dias * 24);
  return `${dias} dia${dias > 1 ? 's' : ''}${resto ? ` e ${resto} horas` : ''}`;
}

async function verificar(): Promise<void> {
  // company_name, não name: a tabela clients nunca teve coluna `name`, e a query quebrava
  // inteira com "column c.name does not exist" — o vigia subia, anunciava que estava ativo e
  // morria em toda verificação. Silêncio de vigia quebrado é indistinguível de silêncio de
  // sistema saudável, que é exatamente o defeito que ele existe para consertar.
  const clientes = await query<{ id: number; nome: string }>(
    `SELECT DISTINCT c.id, c.company_name AS nome
     FROM clients c
     JOIN store_integrations si ON si.client_id = c.id
     WHERE c.status <> 'paused'`
  );

  if (clientes.length === 0) return;

  let emSilencio = 0;
  let avisados = 0;

  for (const c of clientes) {
    try {
      const estado = await estadoDoCliente(c.id, c.nome);
      if (!estado.emSilencio) continue;
      emSilencio++;

      const chave = chaveDoEpisodio(estado.ultimoWebhook);
      if (await jaAvisou(c.id, chave)) continue;

      const espera = formatarEspera(estado.horasEmSilencio!);
      const cadencia = estado.intervaloMedioMinutos != null
        ? `Normalmente entra uma venda a cada ${Math.round(estado.intervaloMedioMinutos)} min.`
        : 'Sem histórico suficiente para estimar a cadência normal.';

      const { enviados, falhas } = await notificar({
        titulo: `Webhook parado: ${c.nome}`,
        urgente: true,
        corpo:
          `Nenhuma venda recebida há ${espera}.\n` +
          `Último webhook: ${estado.ultimoWebhook ?? 'nunca'}\n` +
          `${cadencia}\n\n` +
          `O que checar primeiro: no painel da Digistore, Settings → Integrations (IPN), ` +
          `se as conexões continuam ATIVAS. Já aconteceu de serem desativadas sozinhas ` +
          `depois de o endpoint devolver erro.`,
        url: `${process.env.APP_URL || 'https://app.mailxgroup.com'}/admin/clientes/${c.id}`,
      });

      // Só marca como avisado se algum canal aceitou. Marcar depois de falha faria o episódio
      // nunca mais ser tentado — o alerta morreria em silêncio, que é exatamente o defeito que
      // este job existe para consertar.
      if (enviados.length > 0) {
        await query(
          `INSERT INTO alertas_enviados (client_id, tipo, chave) VALUES ($1, 'webhook_parado', $2)
           ON CONFLICT (client_id, tipo, chave) DO NOTHING`,
          [c.id, chave]
        );
        avisados++;
        logger.warn(CTX, `⚠️ ${c.nome}: sem webhook há ${espera} — avisado por ${enviados.join(', ')}`);
      } else {
        logger.error(CTX, `${c.nome}: sem webhook há ${espera}, mas NENHUM canal aceitou (${falhas.join('; ')})`);
      }
    } catch (err: any) {
      logger.error(CTX, `Falha verificando cliente ${c.id}: ${err.message}`);
    }
  }

  if (emSilencio > 0) {
    logger.info(CTX, `${clientes.length} clientes verificados — ${emSilencio} em silêncio, ${avisados} avisados agora`);
  }
}

/**
 * O vigia avisando que o vigia parou.
 *
 * Na primeira subida em produção ele anunciou "ativo — notificando por ntfy" e depois morreu em
 * TODA verificação com `column c.name does not exist`. Do lado de fora, isso é indistinguível de
 * "está tudo bem": nenhum alerta chegando. O erro só apareceu porque alguém foi ler o log.
 *
 * Um monitor que falha em silêncio é pior que monitor nenhum, porque produz confiança sem
 * cobertura. Uma vez por dia (chave = data), a própria falha vira notificação.
 */
async function avisarQueOVigiaQuebrou(err: any): Promise<void> {
  const hoje = new Date().toISOString().slice(0, 10);
  try {
    // client_id nulo: a falha é do vigia, não de um cliente. O índice único cobre isso porque
    // NULL não colide em UNIQUE — por isso a checagem explícita antes de inserir.
    const jaAvisouHoje = await queryOne<{ id: number }>(
      `SELECT id FROM alertas_enviados
       WHERE client_id IS NULL AND tipo = 'vigia_quebrado' AND chave = $1`,
      [hoje]
    );
    if (jaAvisouHoje) return;

    const { enviados } = await notificar({
      titulo: 'Vigia de webhook com defeito',
      urgente: true,
      corpo:
        `A verificação automática está falhando: ${err.message}\n\n` +
        `Enquanto isso, NINGUÉM está vigiando se os webhooks pararam. ` +
        `Ver o log com: pm2 logs mailx-api --nostream | grep VigiaWebhook`,
    });

    if (enviados.length > 0) {
      await query(
        `INSERT INTO alertas_enviados (client_id, tipo, chave) VALUES (NULL, 'vigia_quebrado', $1)`,
        [hoje]
      );
    }
  } catch (e: any) {
    logger.error(CTX, `Não consegui nem avisar que o vigia quebrou: ${e.message}`);
  }
}

export function startWebhookWatchdog(): void {
  const canais = canaisConfigurados();
  if (canais.length === 0) {
    // Não é motivo para não rodar: o log continua registrando o silêncio, e a página do cliente
    // mostra o mesmo estado. Só o empurrão para o celular é que não sai.
    logger.warn(CTX, 'Sem canal de notificação configurado (TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID ou NTFY_TOPICO) — vigia roda só com log');
  } else {
    logger.info(CTX, `Vigia de webhook ativo — notificando por ${canais.join(', ')}`);
  }

  const rodar = () => {
    verificar().catch((err) => {
      logger.error(CTX, `Falha na verificação: ${err.message}`);
      avisarQueOVigiaQuebrou(err).catch(() => { /* já foi logado; não há mais a quem recorrer */ });
    });
  };

  setTimeout(rodar, ATRASO_INICIAL_MS);
  setInterval(rodar, INTERVALO_MS);
}
