/**
 * Bootstrap CLI Script
 * Wraps the bootstrap service for command-line usage.
 *
 * Usage:
 *   npm run bootstrap -- --client-id=1
 */

import { config } from 'dotenv';
config();

import { runBootstrap } from './bootstrap-service';
import { initDatabase, closeDatabase } from '../db/database';
import { logger } from '../utils/logger';

const CTX = 'Bootstrap CLI';

async function main() {
  await initDatabase();

  const clientIdArg = process.argv.find((a) => a.startsWith('--client-id='));
  if (!clientIdArg) {
    logger.error(CTX, 'Usage: npm run bootstrap -- --client-id=<ID>');
    process.exit(1);
  }

  const clientId = parseInt(clientIdArg.split('=')[1]);
  if (isNaN(clientId)) {
    logger.error(CTX, 'client-id must be a number');
    process.exit(1);
  }

  const result = await runBootstrap(clientId);

  // Print summary
  console.log('\n══════════════════════════════════════════');
  console.log('  BOOTSTRAP COMPLETE');
  console.log('══════════════════════════════════════════');
  console.log(`\n  Client ID: ${result.clientId}`);
  console.log(`  Lists: ${result.listsCreated.length}`);
  console.log(`  Tags:  ${result.tagsCreated.length}`);
  console.log(`  Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log('\n  ❌ Errors:');
    result.errors.forEach((e) => console.log(`     - ${e}`));
  }

  console.log('\n══════════════════════════════════════════\n');

  await closeDatabase();
}

main().catch((err) => {
  logger.error(CTX, 'Bootstrap failed', err);
  process.exit(1);
});
