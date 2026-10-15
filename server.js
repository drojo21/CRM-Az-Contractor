'use strict';

const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env file; use the real environment
}

const { loadConfig } = require('./src/config');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');
const { ensureBootstrapAdmin } = require('./src/auth');

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  await ensureBootstrapAdmin(db, config);
  const app = createApp({ db, config });
  app.listen(config.port, () => {
    console.log(`AZ Contractor Pro CRM running at ${config.baseUrl} (port ${config.port})`);
    console.log(`Database: ${config.databasePath}`);
    if (!config.anthropicApiKey) console.log('ANTHROPIC_API_KEY not set: the AI proxy is off; usage reports still work.');
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
