'use strict';

const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createUser } = require('../src/auth');

const ADMIN = { email: 'admin@test.dev', password: 'correct horse battery', name: 'Admin' };
const BUILDER_KEY = 'test-builder-key';
const silent = { log() {}, warn() {}, error() {} };

/** Boots the app on a random port with an in-memory database and a signed-in-able admin. */
async function startApp({ config: overrides = {}, ...deps } = {}) {
  const db = openDatabase(':memory:');
  const base = loadConfig({});
  const config = {
    ...base,
    baseUrl: 'http://crm.test',
    builderKey: BUILDER_KEY,
    ...overrides,
    stripe: { ...base.stripe, ...(overrides.stripe || {}) },
  };
  await createUser(db, ADMIN);
  const app = createApp({ db, config, log: silent, ...deps });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function request(method, path, { body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined && raw === undefined) h['content-type'] = 'application/json';
    const res = await fetch(url + path, {
      method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, body: json === undefined ? text : json, headers: res.headers };
  }

  // What the CRM UI sends: session cookie + CSRF header
  const api = (method, path, body) => request(method, path, { body, headers: { 'x-requested-with': 'acp-crm' } });
  // What the builder / payment server send
  const integration = (method, path, body, headers = {}) =>
    request(method, path, { body, headers: { 'x-builder-key': BUILDER_KEY, ...headers } });

  async function login() {
    const res = await request('POST', '/api/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  return {
    db, config, url, request, api, integration, login,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** Lets fire-and-forget notification promises settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

module.exports = { startApp, flush, ADMIN, BUILDER_KEY };
