import { Pool, PoolClient } from 'pg';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let pool: Pool | null = null;
let dbReady = false;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error('DB', 'Unexpected pool error', err.message);
      dbReady = false;
    });
  }
  return pool;
}

export function isDatabaseReady(): boolean {
  return dbReady;
}

export async function initDatabase(): Promise<void> {
  try {
    const p = getPool();
    const client = await p.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS clients (
          id SERIAL PRIMARY KEY,
          company_name VARCHAR(255) NOT NULL,
          cnpj VARCHAR(20),
          website VARCHAR(255),
          contact_email VARCHAR(255) NOT NULL,
          contact_whatsapp VARCHAR(30),
          
          -- CartPanda
          cartpanda_store_url VARCHAR(255),
          cartpanda_api_token TEXT,
          
          -- ActiveCampaign
          ac_api_url VARCHAR(255),
          ac_api_key TEXT,
          ac_plan VARCHAR(50),
          
          -- DNS
          dns_registrar VARCHAR(100),
          dns_login VARCHAR(255),
          dns_manages_own BOOLEAN DEFAULT false,
          
          -- Branding
          logo_url TEXT,
          brand_color_primary VARCHAR(10),
          brand_color_secondary VARCHAR(10),
          tone_of_voice VARCHAR(50),
          
          -- Google
          google_postmaster_access BOOLEAN DEFAULT false,
          google_drive_folder_url TEXT,
          
          -- Meta
          status VARCHAR(30) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS kits (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          slug VARCHAR(255) NOT NULL,
          price DECIMAL(10,2),
          
          -- ActiveCampaign IDs (populated after bootstrap)
          ac_list_id VARCHAR(50),
          ac_tag_compra_id VARCHAR(50),
          ac_tag_abandono_id VARCHAR(50),
          
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS webhook_logs (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(50) NOT NULL,
          source VARCHAR(50) NOT NULL,
          payload JSONB,
          status VARCHAR(20) DEFAULT 'received',
          error TEXT,
          processed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS store_integrations (
          id SERIAL PRIMARY KEY,
          client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
          platform VARCHAR(30) DEFAULT 'cartpanda',
          shop_slug VARCHAR(255) NOT NULL,
          api_token TEXT NOT NULL,
          events JSONB DEFAULT '{}',
          status VARCHAR(30) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        -- Add platform column if table already exists without it
        DO $$ BEGIN
          ALTER TABLE store_integrations ADD COLUMN IF NOT EXISTS platform VARCHAR(30) DEFAULT 'cartpanda';
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;
      `);
      dbReady = true;
      logger.info('DB', '✅ Database tables initialized successfully');
    } finally {
      client.release();
    }
  } catch (error: any) {
    logger.warn('DB', `⚠️ Database not available: ${error.message}. Server will start without DB.`);
    dbReady = false;
  }
}

function ensureDb(): Pool {
  if (!dbReady) {
    throw new Error('Database is not connected');
  }
  return getPool();
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const p = ensureDb();
  const result = await p.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbReady = false;
  }
}
