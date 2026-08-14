import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`❌ Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const env = {
  // Server
  PORT: parseInt(optional('PORT', '3000'), 10),
  NODE_ENV: optional('NODE_ENV', 'development'),
  WEBHOOK_SECRET: optional('WEBHOOK_SECRET', ''),
  ADMIN_PASSWORD: optional('ADMIN_PASSWORD', 'mailx2026'),

  // PostgreSQL
  DATABASE_URL: required('DATABASE_URL'),

  /**
   * FUSO DO NEGÓCIO — em que fuso "o dia" do painel começa e termina.
   *
   * Era UTC de forma implícita (CURRENT_DATE do Postgres). O problema: UTC está 3h à frente de
   * Brasília, então o filtro "Hoje" virava o dia seguinte às 21:00 daqui — das 21h à meia-noite
   * quem abrisse o painel veria "Hoje" quase vazio, porque já era amanhã em UTC. Para quem opera
   * no Brasil isso não é "diferente", é errado.
   *
   * Vale para os DOIS lados de toda razão: o corte de dia das vendas (nosso banco) e a janela
   * pedida à SlickText. Mexer num lado só recria o bug de comparar duas janelas de tempo
   * diferentes, que é a classe de erro que mais apareceu nesta base.
   */
  APP_TZ: optional('APP_TZ', 'America/Sao_Paulo'),

  /**
   * Fuso em que `webhook_logs.created_at` (TIMESTAMP sem fuso) está gravado. É o TimeZone da
   * sessão do Postgres no momento do INSERT — o container do docker-compose não define TZ, então
   * é UTC. Fica explícito aqui porque toda conversão de fuso depende de saber isto, e supor errado
   * desloca todo card por horas sem nenhum sintoma óbvio.
   * Conferir com:  SELECT current_setting('TimeZone'), NOW(), NOW()::timestamp;
   */
  DB_TZ: optional('DB_TZ', 'UTC'),

  // ActiveCampaign (global fallback — per-client credentials are in DB)
  AC_API_URL: optional('AC_API_URL', ''),
  AC_API_KEY: optional('AC_API_KEY', ''),

  // ActiveCampaign Automation IDs (global)
  AC_AUTOMATION_COMPRA_APROVADA: optional('AC_AUTOMATION_COMPRA_APROVADA', ''),
  AC_AUTOMATION_CARRINHO_ABANDONADO: optional('AC_AUTOMATION_CARRINHO_ABANDONADO', ''),

  // Digistore24 (global fallback — per-client passphrase is in store_integrations.api_token)
  DS24_IPN_PASSPHRASE: optional('DS24_IPN_PASSPHRASE', ''),

  // Google Drive
  GOOGLE_SERVICE_ACCOUNT_PATH: optional('GOOGLE_SERVICE_ACCOUNT_PATH', ''),
  GOOGLE_DRIVE_ROOT_FOLDER_ID: optional('GOOGLE_DRIVE_ROOT_FOLDER_ID', ''),

  // Domains
  API_DOMAIN: optional('API_DOMAIN', 'api.mailxgroup.com'),
  APP_DOMAIN: optional('APP_DOMAIN', 'app.mailxgroup.com'),
  SENDING_DOMAIN: optional('SENDING_DOMAIN', 'envio.mailxgroup.com'),

  isDev: optional('NODE_ENV', 'development') === 'development',
};

/** When true (default), handlers only record metrics — no AC/SlickText side effects. */
export const METRICS_ONLY = (process.env.METRICS_ONLY ?? 'true').toLowerCase() !== 'false';
