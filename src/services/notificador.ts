import axios from 'axios';
import { logger } from '../utils/logger';

const CTX = 'Notificador';

/**
 * Manda notificação para o celular. Dois canais, escolhidos por variável de ambiente:
 *
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   → Telegram (privado, recomendado)
 *   NTFY_TOPICO [+ NTFY_SERVIDOR]           → ntfy.sh (app grátis, sem conta)
 *
 * Os dois podem estar ligados ao mesmo tempo; manda nos dois.
 *
 * Sobre o ntfy: tópico é PÚBLICO — quem souber o nome lê tudo que passa por ele. Como estas
 * mensagens carregam nome de cliente e valor de venda, use um nome longo e aleatório, ou
 * prefira o Telegram. A escolha fica com quem configura; o código não decide por ninguém.
 *
 * Nenhuma falha de notificação derruba quem chamou: alerta é acessório, e não pode quebrar o
 * job que estava tentando avisar de um problema.
 */

export interface Aviso {
  titulo: string;
  corpo: string;
  urgente?: boolean;
  /** Link que o toque na notificação abre — geralmente a página do cliente no painel. */
  url?: string;
}

export function canaisConfigurados(): string[] {
  const canais: string[] = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) canais.push('telegram');
  if (process.env.NTFY_TOPICO) canais.push('ntfy');
  return canais;
}

async function mandarTelegram(aviso: Aviso): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_CHAT_ID!;
  const texto = `*${aviso.titulo}*\n\n${aviso.corpo}${aviso.url ? `\n\n${aviso.url}` : ''}`;

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text: texto, parse_mode: 'Markdown', disable_web_page_preview: true },
    { timeout: 15_000 }
  );
}

async function mandarNtfy(aviso: Aviso): Promise<void> {
  const servidor = (process.env.NTFY_SERVIDOR || 'https://ntfy.sh').replace(/\/$/, '');
  const topico = process.env.NTFY_TOPICO!;

  // Título e tags vão em cabeçalho; o ntfy exige ASCII neles, então acento vira erro 400 e a
  // notificação some sem explicação. O texto acentuado fica no corpo, que aceita UTF-8.
  const headers: Record<string, string> = {
    Title: aviso.titulo.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    Priority: aviso.urgente ? 'high' : 'default',
    Tags: aviso.urgente ? 'rotating_light' : 'bar_chart',
  };
  if (aviso.url) headers.Click = aviso.url;

  await axios.post(`${servidor}/${encodeURIComponent(topico)}`, aviso.corpo, {
    headers,
    timeout: 15_000,
  });
}

export async function notificar(aviso: Aviso): Promise<{ enviados: string[]; falhas: string[] }> {
  const enviados: string[] = [];
  const falhas: string[] = [];

  const canais = canaisConfigurados();
  if (canais.length === 0) {
    logger.warn(CTX, `Nenhum canal configurado — aviso não enviado: ${aviso.titulo}`);
    return { enviados, falhas: ['nenhum canal configurado'] };
  }

  for (const canal of canais) {
    try {
      if (canal === 'telegram') await mandarTelegram(aviso);
      else if (canal === 'ntfy') await mandarNtfy(aviso);
      enviados.push(canal);
      logger.info(CTX, `Aviso enviado por ${canal}: ${aviso.titulo}`);
    } catch (err: any) {
      // Detalhe do erro do provedor (o Telegram explica no corpo por que recusou; sem isso
      // fica-se com "Request failed with status code 400" e nenhuma pista).
      const detalhe = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
      falhas.push(`${canal}: ${detalhe}`);
      logger.error(CTX, `Falha enviando por ${canal}: ${detalhe}`);
    }
  }

  return { enviados, falhas };
}
