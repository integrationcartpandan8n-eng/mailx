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

  // CartPanda
  CARTPANDA_API_TOKEN: optional('CARTPANDA_API_TOKEN', ''),
  CARTPANDA_STORE_SLUG: optional('CARTPANDA_STORE_SLUG', ''),

  // ActiveCampaign
  AC_API_URL: optional('AC_API_URL', ''),
  AC_API_KEY: optional('AC_API_KEY', ''),

  // ActiveCampaign IDs
  AC_AUTOMATION_COMPRA_APROVADA: optional('AC_AUTOMATION_COMPRA_APROVADA', ''),
  AC_AUTOMATION_CARRINHO_ABANDONADO: optional('AC_AUTOMATION_CARRINHO_ABANDONADO', ''),

  // Google Drive
  GOOGLE_SERVICE_ACCOUNT_PATH: optional('GOOGLE_SERVICE_ACCOUNT_PATH', ''),
  GOOGLE_DRIVE_ROOT_FOLDER_ID: optional('GOOGLE_DRIVE_ROOT_FOLDER_ID', ''),

  // Domains
  API_DOMAIN: optional('API_DOMAIN', 'api.mailxgroup.com'),
  APP_DOMAIN: optional('APP_DOMAIN', 'app.mailxgroup.com'),
  SENDING_DOMAIN: optional('SENDING_DOMAIN', 'envio.mailxgroup.com'),

  isDev: optional('NODE_ENV', 'development') === 'development',
};
