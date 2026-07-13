import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { query, queryOne, isDatabaseReady } from '../db/database';
import { logger } from '../utils/logger';
import { requireAuth } from '../middleware/auth';
import { CartPandaClient } from '../services/cartpanda';
import { env } from '../config/env';

const CTX = 'Onboarding';

export const onboardingRouter = Router();

// Requer autenticação de admin para todas as rotas de onboarding
onboardingRouter.use(requireAuth);

// Resolve HTML files directory — works in both dev (tsx) and prod (dist/) mode
function getHtmlDir(): string {
  // When running via tsx: __dirname = .../src/onboarding
  // When running compiled: __dirname = .../dist/onboarding → need src/onboarding
  if (fs.existsSync(path.join(__dirname, 'form.html'))) {
    return __dirname;
  }
  const srcDir = path.join(process.cwd(), 'src', 'onboarding');
  if (fs.existsSync(path.join(srcDir, 'form.html'))) {
    return srcDir;
  }
  return __dirname;
}

const htmlDir = getHtmlDir();
logger.debug(CTX, `HTML dir resolved to: ${htmlDir}`);

// Read HTML file and send as response (avoids Express sendFile path issues)
function serveHtml(filename: string, res: Response): void {
  const filePath = path.resolve(htmlDir, filename);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.type('html').send(content);
  } catch (error: any) {
    logger.error(CTX, `Cannot read ${filename}: ${error.message}`);
    res.status(500).send('Arquivo indisponível');
  }
}

// Wrap async route handlers
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Serve the onboarding form
onboardingRouter.get('/', (_req: Request, res: Response) => {
  serveHtml('form.html', res);
});

// Handle form submission
onboardingRouter.post('/', asyncHandler(async (req: Request, res: Response) => {
  if (!isDatabaseReady()) {
    res.status(503).send('Banco de dados indisponível. Tente novamente em alguns minutos.');
    return;
  }

  const {
    company_name,
    cnpj,
    website,
    contact_email,
    contact_whatsapp,
    platform,
    cartpanda_store_url,
    cartpanda_api_token,
    ds24_vendor_id,
    ds24_ipn_passphrase,
    cb_vendor_nickname,
    cb_ins_secret,
    ac_api_url,
    ac_api_key,
    ac_plan,
    dns_registrar,
    dns_login,
    dns_manages_own,
    logo_url,
    brand_color_primary,
    brand_color_secondary,
    tone_of_voice,
    google_drive_folder_url,
    st_api_token,
    st_brand_id,
    default_currency,
  } = req.body;

  if (!company_name || !contact_email) {
    res.status(400).send('Nome da empresa e email são obrigatórios.');
    return;
  }

  const result = await queryOne<{ id: number }>(
    `INSERT INTO clients (
      company_name, cnpj, website, contact_email, contact_whatsapp,
      cartpanda_store_url, cartpanda_api_token,
      ac_api_url, ac_api_key, ac_plan,
      dns_registrar, dns_login, dns_manages_own,
      logo_url, brand_color_primary, brand_color_secondary, tone_of_voice,
      google_drive_folder_url,
      st_api_token, st_brand_id,
      default_currency
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18,
      $19, $20, $21
    ) RETURNING id`,
    [
      company_name, cnpj || null, website || null, contact_email, contact_whatsapp || null,
      cartpanda_store_url || null, cartpanda_api_token || null,
      ac_api_url || null, ac_api_key || null, ac_plan || null,
      dns_registrar || null, dns_login || null, dns_manages_own === 'true',
      logo_url || null, brand_color_primary || null, brand_color_secondary || null, tone_of_voice || null,
      google_drive_folder_url || null,
      st_api_token || null, st_brand_id || null,
      default_currency || 'USD',
    ]
  );

  const clientId = result?.id;



  // Create store_integrations entry based on selected platform
  const selectedPlatform = platform || 'cartpanda';

  if (selectedPlatform === 'cartpanda' && cartpanda_store_url) {
    // Extract slug from URL: https://minhaloja.cartpanda.com → minhaloja
    const slugMatch = cartpanda_store_url.match(/https?:\/\/([^.]+)\.cartpanda/);
    const storeSlug = slugMatch ? slugMatch[1] : cartpanda_store_url;

    await query(
      `INSERT INTO store_integrations (client_id, platform, shop_slug, api_token, status)
       VALUES ($1, 'cartpanda', $2, $3, 'pending')`,
      [clientId, storeSlug, cartpanda_api_token || '']
    );
    logger.info(CTX, `Store integration created: cartpanda/${storeSlug} for client #${clientId}`);

    // Auto-register webhooks on CartPanda
    if (cartpanda_api_token) {
      try {
        const callbackBase = `https://${env.API_DOMAIN}`;
        const cp = new CartPandaClient(storeSlug, cartpanda_api_token);
        const whResult = await cp.registerWebhooks(callbackBase);
        logger.info(CTX, `Webhooks registered for ${storeSlug}: ${whResult.created.length} created, ${whResult.errors.length} errors`);

        if (whResult.errors.length === 0) {
          await query(
            `UPDATE store_integrations SET status = 'active' WHERE client_id = $1 AND shop_slug = $2`,
            [clientId, storeSlug]
          );
        }
      } catch (whErr: any) {
        logger.warn(CTX, `Auto-register webhooks failed for ${storeSlug}: ${whErr.message}`);
      }
    }
  }

  if (selectedPlatform === 'digistore24' && ds24_vendor_id) {
    await query(
      `INSERT INTO store_integrations (client_id, platform, shop_slug, api_token, status)
       VALUES ($1, 'digistore24', $2, $3, 'pending')`,
      [clientId, ds24_vendor_id, ds24_ipn_passphrase || '']
    );
    logger.info(CTX, `Store integration created: digistore24/${ds24_vendor_id} for client #${clientId}`);
  }

  if (selectedPlatform === 'clickbank' && cb_vendor_nickname) {
    await query(
      `INSERT INTO store_integrations (client_id, platform, shop_slug, api_token, status)
       VALUES ($1, 'clickbank', $2, $3, 'pending')`,
      [clientId, cb_vendor_nickname.toLowerCase(), cb_ins_secret || '']
    );
    logger.info(CTX, `Store integration created: clickbank/${cb_vendor_nickname} for client #${clientId}`);
  }

  logger.info(CTX, `✅ New client onboarded: ${company_name}`, {
    id: clientId,
    platform: selectedPlatform,
  });

  res.redirect('/onboarding/sucesso');
}));

// Success page
onboardingRouter.get('/sucesso', (_req: Request, res: Response) => {
  serveHtml('success.html', res);
});
