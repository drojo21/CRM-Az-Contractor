'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, flush } = require('./helpers');

const SITE_LEAD = {
  name: 'Marisol R.', phone: '520-555-0141', email: 'marisol@example.com', service: 'Paver patios and driveways',
  timeline: 'Within a month', message: 'Back patio, about 400 sq ft.', business: "Luis Rojo's Masonry LLC",
  submitted: '2026-10-14T17:00:00.000Z',
};

function fakeMail() {
  const sent = [];
  return { sent, sendMail: async m => { sent.push(m); return { messageId: 'x' }; } };
}

async function seedContractor(t, extra = {}) {
  await t.login();
  const res = await t.api('POST', '/api/contractors', {
    business_name: "Luis Rojo's Masonry LLC", email: 'luis@example.com', roc_number: '337881', ...extra,
  });
  return res.body.contractor;
}

test('lead from a generated site (no-cors text/plain JSON) lands on the right contractor and emails them', async () => {
  const mail = fakeMail();
  const t = await startApp({ mailTransport: mail, config: { adminNotifyEmail: 'agency@example.com' } });
  try {
    const c = await seedContractor(t);
    // Exactly what fetch(..., { mode: 'no-cors', body: JSON.stringify(data) }) puts on the wire
    const res = await t.request('POST', `/hooks/leads/${c.lead_key}`, {
      raw: JSON.stringify(SITE_LEAD),
      headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://luis-rojos-masonry.netlify.app' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.headers.get('access-control-allow-origin'), '*');

    const lead = t.db.get('SELECT * FROM leads');
    assert.equal(lead.contractor_id, c.id);
    assert.equal(lead.name, 'Marisol R.');
    assert.equal(lead.status, 'new');
    assert.equal(lead.source_url, 'https://luis-rojos-masonry.netlify.app');
    assert.equal(lead.submitted_at, '2026-10-14T17:00:00.000Z');

    await flush();
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, 'luis@example.com');
    assert.equal(mail.sent[0].bcc, 'agency@example.com');
    assert.equal(mail.sent[0].replyTo, 'marisol@example.com');
    assert.match(mail.sent[0].subject, /Paver patios/);

    const detail = await t.api('GET', `/api/contractors/${c.id}`);
    assert.equal(detail.body.leads.length, 1);
    assert.match(detail.body.activities[0].body, /New lead: Marisol R\./);
  } finally {
    await t.close();
  }
});

test('lead HTML email escapes form input', async () => {
  const mail = fakeMail();
  const t = await startApp({ mailTransport: mail });
  try {
    const c = await seedContractor(t);
    await t.request('POST', `/hooks/leads/${c.lead_key}`, {
      body: { name: '<img src=x onerror=alert(1)>', phone: '1' },
    });
    await flush();
    assert.equal(mail.sent[0].html.includes('<img src=x'), false);
    assert.ok(mail.sent[0].html.includes('&lt;img src=x'));
  } finally {
    await t.close();
  }
});

test('lead forwarding keeps an existing Apps Script sheet working', async () => {
  const forwarded = [];
  const fetchImpl = async (url, init) => {
    forwarded.push({ url, init });
    return new Response('ok', { status: 200 });
  };
  const t = await startApp({ fetchImpl });
  try {
    const c = await seedContractor(t, { lead_forward_url: 'https://script.google.com/macros/s/abc/exec', notify_leads: false });
    await t.request('POST', `/hooks/leads/${c.lead_key}`, { raw: JSON.stringify(SITE_LEAD), headers: { 'content-type': 'text/plain' } });
    await flush();
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].url, 'https://script.google.com/macros/s/abc/exec');
    assert.equal(forwarded[0].init.headers['content-type'], 'text/plain;charset=UTF-8');
    const body = JSON.parse(forwarded[0].init.body);
    assert.equal(body.name, 'Marisol R.');
    assert.equal(body.business, "Luis Rojo's Masonry LLC");
  } finally {
    await t.close();
  }
});

test('lead edge cases: unknown key, empty lead, honeypot, generic endpoint, rate limit', async () => {
  const t = await startApp();
  try {
    const c = await seedContractor(t);
    assert.equal((await t.request('POST', '/hooks/leads/not-a-real-key', { body: SITE_LEAD })).status, 404);
    assert.equal((await t.request('POST', `/hooks/leads/${c.lead_key}`, { body: { service: 'x' } })).status, 400);

    await t.request('POST', `/hooks/leads/${c.lead_key}`, { body: { name: 'Bot', phone: '1', _gotcha: 'filled' } });
    assert.equal(t.db.get("SELECT COUNT(*) AS n FROM leads WHERE status = 'spam'").n, 1);

    // Generic endpoint matches on the business name the site sends
    await t.request('POST', '/hooks/leads', { raw: JSON.stringify(SITE_LEAD), headers: { 'content-type': 'text/plain' } });
    assert.equal(t.db.get("SELECT contractor_id FROM leads WHERE name = 'Marisol R.'").contractor_id, c.id);
    await t.request('POST', '/hooks/leads', { body: { ...SITE_LEAD, name: 'Who', business: 'Nobody LLC' } });
    assert.equal(t.db.get("SELECT contractor_id FROM leads WHERE name = 'Who'").contractor_id, null);

    // Form-encoded posts work too
    await t.request('POST', `/hooks/leads/${c.lead_key}`, {
      raw: 'name=Form+Person&phone=520-555-0000', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.ok(t.db.get("SELECT id FROM leads WHERE name = 'Form Person'"));

    // Admin inbox: assign the orphan and mark it won
    const orphan = t.db.get("SELECT id FROM leads WHERE name = 'Who'");
    const patched = await t.api('PATCH', `/api/leads/${orphan.id}`, { contractor_id: c.id, status: 'won' });
    assert.equal(patched.body.lead.contractor_id, c.id);
    assert.equal(patched.body.lead.status, 'won');
    const inbox = await t.api('GET', '/api/leads?status=new');
    assert.ok(inbox.body.leads.every(l => l.status === 'new'));
    assert.equal(inbox.body.counts.spam, 1);

    let last;
    for (let i = 0; i < 20; i++) last = await t.request('POST', `/hooks/leads/${c.lead_key}`, { body: { name: `n${i}`, phone: '1' } });
    assert.equal(last.status, 429);
  } finally {
    await t.close();
  }
});

test('test-lead button runs the real notification path', async () => {
  const mail = fakeMail();
  const t = await startApp({ mailTransport: mail });
  try {
    const c = await seedContractor(t);
    const res = await t.api('POST', `/api/contractors/${c.id}/test-lead`);
    assert.equal(res.status, 201);
    assert.equal(res.body.emailed, true);
    assert.equal(mail.sent.length, 1);
  } finally {
    await t.close();
  }
});
