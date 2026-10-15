'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError } = require('./errors');
const { nowIso } = require('./db');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const COOKIE = 'acp_session';
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'acp-crm';

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

async function hashPassword(password) {
  if (String(password).length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

async function createUser(db, { email, name = '', password }) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'A valid email is required');
  if (db.get('SELECT id FROM users WHERE email = ?', [e])) throw new HttpError(409, 'A user with that email already exists');
  const hash = await hashPassword(password);
  const { lastInsertRowid } = db.run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)',
    [e, String(name).trim().slice(0, 100), hash]);
  return { id: lastInsertRowid, email: e, name };
}

/** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when the users table is empty. */
async function ensureBootstrapAdmin(db, config, log = console) {
  const { count } = db.get('SELECT COUNT(*) AS count FROM users');
  if (count > 0) return;
  if (!config.adminEmail || !config.adminPassword) {
    log.warn('No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run: npm run create-user -- <email> <password>');
    return;
  }
  await createUser(db, { email: config.adminEmail, name: 'Admin', password: config.adminPassword });
  log.log(`Created admin user ${config.adminEmail}`);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

function sessionCookie(config, token, maxAgeSeconds) {
  return [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
    config.cookieSecure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

function createSession(db, config, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400e3).toISOString();
  db.run('DELETE FROM sessions WHERE expires_at <= ?', [nowIso()]);
  db.run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [sha256(token), userId, expires]);
  return { token, maxAge: config.sessionDays * 86400 };
}

function destroySession(db, token) {
  if (token) db.run('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
}

function sessionUser(db, token) {
  if (!token) return null;
  return db.get(`SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.id = ? AND s.expires_at > ?`, [sha256(token), nowIso()]) || null;
}

/** Session auth for the CRM UI. Mutations also need the CSRF header the UI always sends. */
function requireUser(db) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const user = sessionUser(db, token);
    if (!user) return next(new HttpError(401, 'Sign in required'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get(CSRF_HEADER) !== CSRF_VALUE) {
      return next(new HttpError(403, 'Missing request header'));
    }
    req.user = user;
    next();
  };
}

// ---------------- API keys (builder, payment server) ----------------

function generateApiKey(db, name) {
  const label = String(name || '').trim().slice(0, 60);
  if (!label) throw new HttpError(400, 'Give the key a name, e.g. "Site Builder"');
  const key = `acp_${crypto.randomBytes(24).toString('base64url')}`;
  const { lastInsertRowid } = db.run('INSERT INTO api_keys (name, key_hash, prefix) VALUES (?, ?, ?)',
    [label, sha256(key), key.slice(0, 10)]);
  return { id: lastInsertRowid, name: label, key, prefix: key.slice(0, 10) };
}

function presentedKey(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return req.get('x-builder-key') || req.get('x-api-key') || (bearer && bearer[1]) || '';
}

function safeEqual(a, b) {
  const x = Buffer.from(sha256(a), 'hex');
  const y = Buffer.from(sha256(b), 'hex');
  return crypto.timingSafeEqual(x, y);
}

/** Accepts the BUILDER_KEY env value or any non-revoked key created in Settings. */
function requireApiKey(db, config) {
  return (req, res, next) => {
    const key = presentedKey(req);
    if (!key) return next(new HttpError(401, 'Missing API key (send it as the x-builder-key header)'));
    if (config.builderKey && safeEqual(key, config.builderKey)) {
      req.apiKey = { id: null, name: 'BUILDER_KEY' };
      return next();
    }
    const row = db.get('SELECT id, name FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [sha256(key)]);
    if (!row) return next(new HttpError(401, 'Invalid API key'));
    db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [nowIso(), row.id]);
    req.apiKey = row;
    next();
  };
}

module.exports = {
  COOKIE, CSRF_HEADER, CSRF_VALUE,
  hashPassword, verifyPassword, createUser, ensureBootstrapAdmin, parseCookies, sessionCookie,
  createSession, destroySession, sessionUser, requireUser, generateApiKey, requireApiKey,
};
