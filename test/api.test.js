'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

test('auth: rejects bad credentials, requires a session, requires the CSRF header', async () => {
  const bad = await t.request('POST', '/api/auth/login', { body: { email: 'admin@test.dev', password: 'nope-nope-nope' } });
  assert.equal(bad.status, 401);
  assert.equal((await t.request('GET', '/api/contractors')).status, 401);

  await t.login();
  assert.equal((await t.request('GET', '/api/auth/me')).body.user.email, 'admin@test.dev');
  // Session cookie alone is not enough for a write (blocks cross-site form posts)
  const noCsrf = await t.request('POST', '/api/contractors', { body: { business_name: 'X' } });
  assert.equal(noCsrf.status, 403);
});

test('contractors: create, list, search, update with stage history, delete', async () => {
  await t.login();
  const created = await t.api('POST', '/api/contractors', {
    business_name: 'Saguaro Spark Electric', trade: 'Electrical', roc_number: 'ROC 341207',
    service_area: 'Marana, Tucson', email: 'teresa@example.com',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const c = created.body.contractor;
  assert.equal(c.roc_number, '341207');
  assert.deepEqual(c.service_area, ['Marana', 'Tucson']);
  assert.equal(c.stage, 'prospect');
  assert.ok(c.lead_key.length >= 20);

  const dup = await t.api('POST', '/api/contractors', { business_name: 'Other', roc_number: '341207' });
  assert.equal(dup.status, 400);

  const found = await t.api('GET', '/api/contractors?q=saguaro');
  assert.equal(found.body.contractors.length, 1);
  assert.equal((await t.api('GET', '/api/contractors?q=zzz')).body.contractors.length, 0);
  assert.equal((await t.api('GET', '/api/contractors?stage=live')).body.contractors.length, 0);

  const patched = await t.api('PATCH', `/api/contractors/${c.id}`, { stage: 'contacted', next_follow_up: '2026-11-01' });
  assert.equal(patched.body.contractor.stage, 'contacted');
  const bad = await t.api('PATCH', `/api/contractors/${c.id}`, { stage: 'bogus' });
  assert.equal(bad.status, 400);

  await t.api('POST', `/api/contractors/${c.id}/activities`, { kind: 'call', body: 'Left a voicemail' });
  const detail = await t.api('GET', `/api/contractors/${c.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.leadCaptureUrl, `http://crm.test/hooks/leads/${c.lead_key}`);
  const kinds = detail.body.activities.map(a => a.kind);
  assert.deepEqual(kinds.slice(0, 3), ['call', 'stage', 'created']);

  const rotated = await t.api('POST', `/api/contractors/${c.id}/lead-key`);
  assert.notEqual(rotated.body.leadCaptureUrl, detail.body.leadCaptureUrl);

  assert.equal((await t.api('DELETE', `/api/contractors/${c.id}`)).status, 200);
  assert.equal((await t.api('GET', `/api/contractors/${c.id}`)).status, 404);
});

test('ROC import creates prospects, fills blanks on re-import, keeps different licensees apart', async () => {
  await t.login();
  const csv = 'License Number,Business Name,Classification,City,Phone,Website\n'
    + '400001,Copper State Plumbing,CR-37,Tucson,,\n'
    + '400002,Old Pueblo Roofing,CR-42,Tucson,520-555-0002,oldpuebloroofing.com\n';
  const first = await t.api('POST', '/api/contractors/import', { csv });
  assert.deepEqual(first.body, { total: 2, created: 2, updated: 0, noWebsite: 1 });

  const second = await t.api('POST', '/api/contractors/import', {
    csv: 'License Number,Business Name,Classification,City,Phone\n'
      + '400001,Copper State Plumbing,CR-37,Marana,520-555-0001\n'
      + '400099,Copper State Plumbing,CR-37,Yuma,520-555-0099\n',
  });
  assert.deepEqual(second.body, { total: 2, created: 1, updated: 1, noWebsite: 2 });

  const list = (await t.api('GET', '/api/contractors?q=copper&sort=name')).body.contractors;
  assert.equal(list.length, 2, 'same DBA, different ROC numbers stay separate');
  const original = list.find(c => c.roc_number === '400001');
  assert.equal(original.city, 'Tucson', 'fill-only import does not overwrite');
  assert.equal(original.phone, '520-555-0001', 'fill-only import fills blanks');
  assert.equal(original.trade, 'Plumbing');
  assert.equal(original.source, 'roc_import');

  const bad = await t.api('POST', '/api/contractors/import', { csv: 'nothing useful' });
  assert.equal(bad.status, 400);
});

test('orders: manual paid order moves the contractor to Paid and shows in revenue', async () => {
  await t.login();
  const c = (await t.api('POST', '/api/contractors', { business_name: 'Rincon Paint Works' })).body.contractor;
  const order = await t.api('POST', `/api/contractors/${c.id}/orders`, { package_type: 'website', status: 'paid' });
  assert.equal(order.status, 201);
  assert.equal(order.body.order.amount_cents, 25000);
  assert.ok(order.body.order.paid_at);
  assert.equal((await t.api('GET', `/api/contractors/${c.id}`)).body.contractor.stage, 'paid');
  const dash = await t.api('GET', '/api/dashboard');
  assert.ok(dash.body.totals.revenueCents >= 25000);
  assert.ok(dash.body.stageCounts.paid >= 1);
});

test('settings: API keys work for integrations and can be revoked; pricing is editable', async () => {
  await t.login();
  const key = await t.api('POST', '/api/settings/api-keys', { name: 'Site Builder' });
  assert.equal(key.status, 201);
  assert.match(key.body.key, /^acp_/);

  const ping = await t.request('GET', '/api/integrations/ping', { headers: { 'x-builder-key': key.body.key } });
  assert.equal(ping.status, 200);
  assert.equal(ping.body.key, 'Site Builder');

  await t.api('DELETE', `/api/settings/api-keys/${key.body.id}`);
  const revoked = await t.request('GET', '/api/integrations/ping', { headers: { 'x-builder-key': key.body.key } });
  assert.equal(revoked.status, 401);

  const settings = await t.api('GET', '/api/settings');
  assert.ok(settings.body.pricing['claude-sonnet-4-6']);
  assert.equal(JSON.stringify(settings.body).includes(key.body.key), false, 'full key is never returned again');

  const saved = await t.api('PUT', '/api/settings/pricing', {
    pricing: { ...settings.body.pricing, 'claude-custom': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
  });
  assert.ok(saved.body.pricing['claude-custom']);
  const reset = await t.api('POST', '/api/settings/pricing/reset');
  assert.equal(reset.body.pricing['claude-custom'], undefined);
});

test('serves the UI shell and blocks unknown API routes', async () => {
  const page = await t.request('GET', '/contractors/1');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  await t.login();
  assert.equal((await t.api('GET', '/api/nope')).status, 404);
});
