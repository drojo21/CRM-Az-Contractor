'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { startApp, flush } = require('./helpers');

const AnthropicClient = Anthropic.default || Anthropic;

// The builder's readForm() output for its "Load example" contractor
const WORK_ORDER = {
  biz: "Luis Rojo's Masonry LLC", owner: 'Luis Rojo', years: '12', trade: 'Masonry', lic: 'KB-2', roc: '337881',
  phone: '520-481-7579', email: '', city: 'Tucson', zip: '85706',
  area: ['Tucson', 'Marana', 'Oro Valley', 'Vail', 'Sahuarita'],
  spec: ['Paver patios and driveways', 'Block walls', 'Artificial turf'],
  cust: 'Both', emerg: false, fin: true, sheet: '',
};

function fakeClaude() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(body) {
        calls.push(body);
        return {
          id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: '{"tagline":"Built to last"}' }], stop_reason: 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    },
  };
}

test('builder sync: creates the contractor, returns the lead URL, records deploys, advances the stage', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.request('POST', '/api/integrations/builder/sync', { body: { contractor: WORK_ORDER } })).status, 401);

    const pre = await t.integration('POST', '/api/integrations/builder/sync', { contractor: WORK_ORDER });
    assert.equal(pre.status, 201, JSON.stringify(pre.body));
    assert.match(pre.body.leadCaptureUrl, /^http:\/\/crm\.test\/hooks\/leads\/[\w-]{20,}$/);
    assert.equal(pre.body.stage, 'prospect');

    const site = { siteId: 'nf-site-1', url: 'https://luis-rojos-masonry-llc-ab12.netlify.app', claimUrl: 'https://app.netlify.com/claim#x' };
    const post = await t.integration('POST', '/api/integrations/builder/sync', { contractor: WORK_ORDER, site });
    assert.equal(post.status, 200);
    assert.equal(post.body.contractorId, pre.body.contractorId);
    assert.equal(post.body.stage, 'demo');
    assert.equal(post.body.website.deploy_count, 1);

    // Republish: same Netlify site, renamed business — still the same record (matched on ROC)
    const again = await t.integration('POST', '/api/integrations/builder/sync', {
      contractor: { ...WORK_ORDER, biz: "Luis Rojo's Masonry" }, site,
    });
    assert.equal(again.body.contractorId, pre.body.contractorId);
    assert.equal(again.body.website.deploy_count, 2);
    assert.equal(t.db.get('SELECT COUNT(*) AS n FROM contractors').n, 1);
    assert.equal(t.db.get('SELECT COUNT(*) AS n FROM websites').n, 1);
    const c = t.db.get('SELECT * FROM contractors');
    assert.equal(c.business_name, "Luis Rojo's Masonry");
    assert.equal(c.source, 'builder');
    assert.equal(c.payment_plans, 1);

    // CORS preflight from the builder tab
    const pre2 = await t.request('OPTIONS', '/api/integrations/builder/sync', {
      headers: { origin: 'https://builder.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-builder-key' },
    });
    assert.equal(pre2.status, 204);
    assert.match(pre2.headers.get('access-control-allow-headers'), /x-builder-key/);
  } finally {
    await t.close();
  }
});

test('AI proxy: forwards to Claude, bills tokens to the contractor, enforces budgets and the model list', async () => {
  const claude = fakeClaude();
  const t = await startApp({ anthropic: claude });
  try {
    const { contractorId } = (await t.integration('POST', '/api/integrations/builder/sync', { contractor: WORK_ORDER })).body;

    const res = await t.integration('POST', '/api/integrations/ai/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: 'Write a tagline' }],
    }, { 'x-contractor-roc': '337881', 'x-acp-purpose': 'site_copy' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.content[0].type, 'text', 'response is the untouched Messages API shape');
    assert.equal(claude.calls[0].acp, undefined);

    // Attribution by body field instead of header; the acp field is stripped before forwarding
    await t.integration('POST', '/api/integrations/ai/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 99999, messages: [{ role: 'user', content: 'FAQs' }],
      acp: { businessName: "Luis Rojo's Masonry LLC", purpose: 'faq_reviews' },
    });
    assert.equal(claude.calls[1].acp, undefined);
    assert.equal(claude.calls[1].max_tokens, 4096, 'max_tokens is capped');

    const rows = t.db.all('SELECT * FROM token_usage ORDER BY id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].contractor_id, contractorId);
    assert.equal(rows[0].cost_micros, 10500);
    assert.equal(rows[0].source, 'proxy');
    assert.equal(rows[0].request_id, 'msg_1');
    assert.deepEqual(rows.map(r => r.purpose), ['site_copy', 'faq_reviews']);

    const unknown = await t.integration('POST', '/api/integrations/ai/messages', {
      model: 'gpt-4o', max_tokens: 10, messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /no price on file/);

    // Budget: 3000 tokens used so far; set the budget below that
    t.db.run('UPDATE contractors SET token_budget_monthly = 2500 WHERE id = ?', [contractorId]);
    const blocked = await t.integration('POST', '/api/integrations/ai/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'x' }],
    }, { 'x-contractor-id': String(contractorId) });
    assert.equal(blocked.status, 429);
    assert.equal(claude.calls.length, 2, 'blocked call never reaches Claude');

    await t.login();
    const usage = await t.api('GET', '/api/usage');
    assert.equal(usage.body.month.tokens, 3000);
    assert.equal(usage.body.byContractor[0].cost_total_micros, 21000);
    const detail = await t.api('GET', `/api/contractors/${contractorId}`);
    assert.equal(detail.body.usage.month.calls, 2);
  } finally {
    await t.close();
  }
});

test('AI proxy: maps Claude API errors and reports a missing key', async () => {
  const failing = {
    messages: {
      async create() {
        throw AnthropicClient.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', new Headers());
      },
    },
  };
  const t = await startApp({ anthropic: failing });
  const off = await startApp();
  try {
    const res = await t.integration('POST', '/api/integrations/ai/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(res.status, 529);
    assert.equal(res.body.error.type, 'overloaded_error');
    assert.equal(t.db.get('SELECT COUNT(*) AS n FROM token_usage').n, 0);

    const noKey = await off.integration('POST', '/api/integrations/ai/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(noKey.status, 503);
  } finally {
    await t.close();
    await off.close();
  }
});

test('usage reports: batch insert, de-duplicate by request id, keep unpriced models visible', async () => {
  const t = await startApp();
  try {
    await t.integration('POST', '/api/integrations/builder/sync', { contractor: WORK_ORDER });
    const events = [
      { model: 'claude-sonnet-4-6', usage: { input_tokens: 520, output_tokens: 610 }, roc: '337881', requestId: 'msg_a' },
      { model: 'claude-sonnet-4-6', usage: { input_tokens: 520, output_tokens: 610 }, roc: '337881', requestId: 'msg_a' },
      { model: 'some-old-model', input_tokens: 10, output_tokens: 10 },
    ];
    const res = await t.integration('POST', '/api/integrations/usage', { events });
    assert.equal(res.status, 201);
    assert.equal(res.body.recorded, 2);
    assert.equal(res.body.results[2].priced, false);
    assert.equal(res.body.results[2].contractorId, null);
  } finally {
    await t.close();
  }
});

test('payment-server orders: pending checkout, then paid, moves contractor to Paid once', async () => {
  const t = await startApp();
  try {
    const order = {
      orderId: 'ACW-1730000000-abc', businessName: 'Desert Cool HVAC', contactName: 'Marcus Webb',
      email: 'marcus@example.com', phone: '520-555-0199', tradeType: 'hvac', serviceArea: 'Tucson, Vail',
      packageType: 'complete', amount: '370',
    };
    const pending = await t.integration('POST', '/api/integrations/orders', order);
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    assert.equal(pending.body.order.status, 'pending');
    assert.equal(pending.body.stage, 'prospect');

    const paid = await t.integration('POST', '/api/integrations/orders', { ...order, status: 'paid', squarePaymentId: 'sq_pay_1' });
    assert.equal(paid.body.order.id, pending.body.order.id);
    assert.equal(paid.body.order.amount_cents, 37000);
    assert.equal(paid.body.stage, 'paid');
    const c = t.db.get('SELECT * FROM contractors');
    assert.equal(c.trade, 'HVAC');
    assert.equal(c.contact_name, 'Marcus Webb');
    assert.equal(t.db.get("SELECT COUNT(*) AS n FROM activities WHERE body LIKE 'Payment received%'").n, 1);
  } finally {
    await t.close();
  }
});

test('Square webhook: verifies the signature and records the paid order from order metadata', async () => {
  const key = 'sq-signature-key';
  const squareFetch = async url => {
    assert.match(url, /connect\.squareupsandbox\.com\/v2\/orders\/sq_order_9$/);
    return new Response(JSON.stringify({
      order: {
        id: 'sq_order_9', line_items: [{ name: 'Professional Website' }], total_money: { amount: 25000 },
        metadata: { orderId: 'ACW-9', businessName: 'Catalina Roofing Co', email: 'ben@example.com', tradeType: 'roofing', packageType: 'website' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const t = await startApp({ config: { square: { webhookSignatureKey: key, accessToken: 'sq-token' } }, fetchImpl: squareFetch });
  try {
    const event = {
      type: 'payment.updated',
      data: { object: { payment: { id: 'sq_pay_9', order_id: 'sq_order_9', status: 'COMPLETED', amount_money: { amount: 25000, currency: 'USD' } } } },
    };
    const raw = JSON.stringify(event);
    const sign = body => crypto.createHmac('sha256', key).update('http://crm.test/hooks/square' + body).digest('base64');

    const forged = await t.request('POST', '/hooks/square', { raw, headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': 'nope' } });
    assert.equal(forged.status, 401);

    const ok = await t.request('POST', '/hooks/square', { raw, headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': sign(raw) } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const order = t.db.get('SELECT * FROM orders');
    assert.equal(order.status, 'paid');
    assert.equal(order.reference, 'ACW-9');
    assert.equal(order.amount_cents, 25000);
    const c = t.db.get('SELECT * FROM contractors WHERE id = ?', [order.contractor_id]);
    assert.equal(c.business_name, 'Catalina Roofing Co');
    assert.equal(c.stage, 'paid');
    assert.equal(c.trade, 'Roofing');

    // A late payment.created (APPROVED) must not undo "paid"
    const late = JSON.stringify({ ...event, type: 'payment.created', data: { object: { payment: { ...event.data.object.payment, status: 'APPROVED' } } } });
    await t.request('POST', '/hooks/square', { raw: late, headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': sign(late) } });
    assert.equal(t.db.get('SELECT status FROM orders').status, 'paid');
    await flush();
  } finally {
    await t.close();
  }
});
