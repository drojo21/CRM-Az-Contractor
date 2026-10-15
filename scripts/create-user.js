'use strict';

// Usage: npm run create-user -- <email> <password> [name]
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* optional */ }

const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createUser } = require('../src/auth');

const [email, password, ...name] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run create-user -- <email> <password> [name]');
  process.exit(1);
}

const db = openDatabase(loadConfig().databasePath);
createUser(db, { email, password, name: name.join(' ') })
  .then(u => console.log(`Created user ${u.email}`))
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
