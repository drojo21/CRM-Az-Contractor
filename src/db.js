'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

// Append-only. Each entry runs once, in order, tracked by PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,               -- sha256 of the cookie token
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE contractors (
    id                   INTEGER PRIMARY KEY,
    business_name        TEXT NOT NULL,
    owner_name           TEXT NOT NULL DEFAULT '',
    contact_name         TEXT NOT NULL DEFAULT '',
    email                TEXT NOT NULL DEFAULT '',
    phone                TEXT NOT NULL DEFAULT '',
    trade                TEXT NOT NULL DEFAULT 'General',
    license_class        TEXT NOT NULL DEFAULT '',
    roc_number           TEXT NOT NULL DEFAULT '',
    license_issued       TEXT NOT NULL DEFAULT '',
    years_in_business    INTEGER,
    city                 TEXT NOT NULL DEFAULT '',
    zip                  TEXT NOT NULL DEFAULT '',
    service_area         TEXT NOT NULL DEFAULT '[]',   -- JSON array of cities
    services             TEXT NOT NULL DEFAULT '[]',   -- JSON array of services
    customer_type        TEXT NOT NULL DEFAULT 'Homeowners',
    emergency_service    INTEGER NOT NULL DEFAULT 0,
    payment_plans        INTEGER NOT NULL DEFAULT 0,
    previous_website     TEXT NOT NULL DEFAULT '',
    stage                TEXT NOT NULL DEFAULT 'prospect',
    source               TEXT NOT NULL DEFAULT 'manual',
    lead_key             TEXT NOT NULL UNIQUE,
    lead_forward_url     TEXT NOT NULL DEFAULT '',
    notify_leads         INTEGER NOT NULL DEFAULT 1,
    token_budget_monthly INTEGER,
    next_follow_up       TEXT,
    created_at           TEXT NOT NULL DEFAULT ${NOW},
    updated_at           TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE UNIQUE INDEX contractors_roc   ON contractors(roc_number) WHERE roc_number <> '';
  CREATE INDEX        contractors_stage ON contractors(stage);
  CREATE INDEX        contractors_name  ON contractors(business_name COLLATE NOCASE);

  CREATE TABLE websites (
    id               INTEGER PRIMARY KEY,
    contractor_id    INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
    netlify_site_id  TEXT,
    url              TEXT NOT NULL DEFAULT '',
    claim_url        TEXT NOT NULL DEFAULT '',
    custom_domain    TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'live',
    deploy_count     INTEGER NOT NULL DEFAULT 0,
    last_deployed_at TEXT,
    created_at       TEXT NOT NULL DEFAULT ${NOW},
    updated_at       TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE UNIQUE INDEX websites_site       ON websites(netlify_site_id) WHERE netlify_site_id IS NOT NULL;
  CREATE INDEX        websites_contractor ON websites(contractor_id);

  CREATE TABLE leads (
    id             INTEGER PRIMARY KEY,
    contractor_id  INTEGER REFERENCES contractors(id) ON DELETE SET NULL,
    name           TEXT NOT NULL DEFAULT '',
    phone          TEXT NOT NULL DEFAULT '',
    email          TEXT NOT NULL DEFAULT '',
    service        TEXT NOT NULL DEFAULT '',
    timeline       TEXT NOT NULL DEFAULT '',
    message        TEXT NOT NULL DEFAULT '',
    business_label TEXT NOT NULL DEFAULT '',          -- the "business" field the site sends
    source_url     TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'new',
    raw            TEXT NOT NULL DEFAULT '{}',
    submitted_at   TEXT,
    created_at     TEXT NOT NULL DEFAULT ${NOW},
    updated_at     TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX leads_contractor ON leads(contractor_id, created_at);
  CREATE INDEX leads_status     ON leads(status, created_at);

  CREATE TABLE orders (
    id                INTEGER PRIMARY KEY,
    contractor_id     INTEGER REFERENCES contractors(id) ON DELETE SET NULL,
    reference         TEXT UNIQUE,                    -- ACW-... id from payment-server.js
    square_order_id   TEXT,
    square_payment_id TEXT UNIQUE,
    package_type      TEXT NOT NULL DEFAULT 'website',
    description       TEXT NOT NULL DEFAULT '',
    amount_cents      INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending',
    paid_at           TEXT,
    created_at        TEXT NOT NULL DEFAULT ${NOW},
    updated_at        TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX orders_contractor ON orders(contractor_id);

  CREATE TABLE token_usage (
    id                 INTEGER PRIMARY KEY,
    contractor_id      INTEGER REFERENCES contractors(id) ON DELETE SET NULL,
    model              TEXT NOT NULL,
    purpose            TEXT NOT NULL DEFAULT '',
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_micros        INTEGER NOT NULL DEFAULT 0,    -- USD x 1,000,000
    priced             INTEGER NOT NULL DEFAULT 1,    -- 0 when the model had no price on file
    source             TEXT NOT NULL DEFAULT 'report',
    request_id         TEXT UNIQUE,                   -- Claude message id, for de-duplication
    created_at         TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX token_usage_contractor ON token_usage(contractor_id, created_at);
  CREATE INDEX token_usage_created    ON token_usage(created_at);

  CREATE TABLE activities (
    id            INTEGER PRIMARY KEY,
    contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX activities_contractor ON activities(contractor_id, created_at);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Payments moved from Square to Stripe
  `
  ALTER TABLE orders RENAME COLUMN square_order_id TO checkout_session_id;   -- Stripe cs_...
  ALTER TABLE orders RENAME COLUMN square_payment_id TO payment_id;          -- Stripe pi_...
  CREATE INDEX orders_checkout_session ON orders(checkout_session_id);
  UPDATE contractors SET source = 'stripe' WHERE source = 'square';
  `,
];

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(raw);
  return wrap(raw);
}

function migrate(raw) {
  const { user_version: version } = raw.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    raw.exec('BEGIN');
    try {
      raw.exec(MIGRATIONS[i]);
      raw.exec(`PRAGMA user_version = ${i + 1}`);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }
}

// node:sqlite rejects undefined, booleans and unknown named parameters, so params
// are cleaned up here once instead of at every call site.
function bindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function wrap(raw) {
  const cache = new Map();
  let depth = 0;

  function statement(sql) {
    let entry = cache.get(sql);
    if (!entry) {
      const names = new Set([...sql.matchAll(/[:@$]([A-Za-z_]\w*)/g)].map(m => m[1]));
      entry = { stmt: raw.prepare(sql), names };
      cache.set(sql, entry);
    }
    return entry;
  }

  function args(entry, params) {
    if (params === undefined) return [];
    if (Array.isArray(params)) return params.map(bindValue);
    if (params !== null && typeof params === 'object') {
      const named = {};
      for (const name of entry.names) if (name in params) named[name] = bindValue(params[name]);
      return [named];
    }
    return [bindValue(params)];
  }

  const call = method => (sql, params) => {
    const entry = statement(sql);
    return entry.stmt[method](...args(entry, params));
  };

  return {
    raw,
    get: call('get'),
    all: call('all'),
    run: call('run'),
    exec: sql => raw.exec(sql),
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
}

const nowIso = () => new Date().toISOString();

const monthStartIso = (date = new Date()) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();

module.exports = { openDatabase, nowIso, monthStartIso };
