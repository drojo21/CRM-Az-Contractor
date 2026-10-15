'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { startApp } = require('./helpers');

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

    const paid = await t.integration('POST', '/api/integrations/orders', { ...order, status: 'paid', paymentId: 'pi_1', checkoutSessionId: 'cs_1' });
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

// ---------------------------------------------------------------- Stripe webhook

const STRIPE_SECRET = 'whsec_crm_test';
const stripeHeader = (raw, secret = STRIPE_SECRET) => {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
};
const postStripe = (t, event, secret) => {
  const raw = JSON.stringify(event);
  return t.request('POST', '/hooks/stripe', {
    raw, headers: { 'content-type': 'application/json', 'stripe-signature': stripeHeader(raw, secret) },
  });
};
// A Checkout Session as payment-server.js creates it
const checkoutEvent = (type, session = {}) => ({
  id: `evt_${crypto.randomBytes(4).toString('hex')}`, type,
  data: {
    object: {
      id: 'cs_test_9', object: 'checkout.session', payment_status: 'paid', amount_total: 25000,
      payment_intent: 'pi_9', client_reference_id: 'ACP-9', customer_details: { email: 'ben@example.com' },
      metadata: {
        orderId: 'ACP-9', businessName: 'Catalina Roofing Co', contactName: 'Ben Ortiz', email: 'ben@example.com',
        phone: '520-555-0133', tradeType: 'roofing', serviceArea: 'Oro Valley, Tucson', packageType: 'website',
      },
      ...session,
    },
  },
});

test('Stripe webhook: verifies the signature and records the paid order from session metadata', async () => {
  const t = await startApp({ config: { stripe: { webhookSecret: STRIPE_SECRET } } });
  try {
    const forged = await postStripe(t, checkoutEvent('checkout.session.completed'), 'whsec_attacker');
    assert.equal(forged.status, 400);
    assert.equal(t.db.get('SELECT COUNT(*) AS n FROM orders').n, 0);

    const ok = await postStripe(t, checkoutEvent('checkout.session.completed'));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const order = t.db.get('SELECT * FROM orders');
    assert.equal(order.status, 'paid');
    assert.equal(order.reference, 'ACP-9');
    assert.equal(order.payment_id, 'pi_9');
    assert.equal(order.checkout_session_id, 'cs_test_9');
    assert.equal(order.amount_cents, 25000);
    assert.equal(order.description, 'Professional Website');
    const c = t.db.get('SELECT * FROM contractors WHERE id = ?', [order.contractor_id]);
    assert.equal(c.business_name, 'Catalina Roofing Co');
    assert.equal(c.stage, 'paid');
    assert.equal(c.trade, 'Roofing');
    assert.equal(c.source, 'stripe');

    // Redelivery and a late "expired" can't duplicate or undo a paid order
    await postStripe(t, checkoutEvent('checkout.session.completed'));
    await postStripe(t, checkoutEvent('checkout.session.expired', { payment_status: 'unpaid' }));
    assert.equal(t.db.get('SELECT COUNT(*) AS n FROM orders').n, 1);
    assert.equal(t.db.get('SELECT status FROM orders').status, 'paid');
    assert.equal(t.db.get("SELECT COUNT(*) AS n FROM activities WHERE body LIKE 'Payment received%'").n, 1);

    // Unrelated event types are acknowledged and ignored
    const other = await postStripe(t, { id: 'evt_x', type: 'customer.created', data: { object: { id: 'cus_1' } } });
    assert.equal(other.status, 200);
    assert.equal(other.body.ignored, true);
  } finally {
    await t.close();
  }
});

test('Stripe webhook and payment server report the same order: one row, then a refund', async () => {
  const t = await startApp({ config: { stripe: { webhookSecret: STRIPE_SECRET } } });
  try {
    const meta = checkoutEvent('x').data.object.metadata;
    // 1. payment-server.js: checkout started
    await t.integration('POST', '/api/integrations/orders', { ...meta, amount: 250, status: 'pending', checkoutSessionId: 'cs_test_9' });
    // 2. Stripe -> CRM directly (delayed method: completed but unpaid)
    await postStripe(t, checkoutEvent('checkout.session.completed', { payment_status: 'unpaid', payment_intent: null }));
    assert.equal(t.db.get('SELECT status FROM orders').status, 'pending');
    // 3. Stripe -> CRM: the bank payment settled
    await postStripe(t, checkoutEvent('checkout.session.async_payment_succeeded'));
    // 4. payment-server.js: paid (after its own webhook)
    await t.integration('POST', '/api/integrations/orders', { ...meta, amount: 250, status: 'paid', paymentId: 'pi_9', checkoutSessionId: 'cs_test_9' });
    assert.equal(t.db.get('SELECT COUNT(*) AS n FROM orders').n, 1);
    assert.equal(t.db.get('SELECT COUNT(*) AS n FROM contractors').n, 1);
    assert.equal(t.db.get('SELECT status FROM orders').status, 'paid');

    // Partial refund: logged, order stays paid. Full refund: order refunded.
    await postStripe(t, { id: 'evt_r1', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_9', amount_refunded: 5000, refunded: false } } });
    assert.equal(t.db.get('SELECT status FROM orders').status, 'paid');
    await postStripe(t, { id: 'evt_r2', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_9', amount_refunded: 25000, refunded: true } } });
    assert.equal(t.db.get('SELECT status FROM orders').status, 'refunded');
    const log = t.db.all("SELECT body FROM activities WHERE kind = 'order' ORDER BY id").map(r => r.body);
    assert.ok(log.some(b => b.startsWith('Partial refund, $50')));
    assert.ok(log.some(b => b.startsWith('Refunded $250')));
    // A retried "paid" report from days earlier can't undo the refund
    await t.integration('POST', '/api/integrations/orders', { ...meta, status: 'paid', paymentId: 'pi_9' });
    assert.equal(t.db.get('SELECT status FROM orders').status, 'refunded');
  } finally {
    await t.close();
  }
});

test('Stripe webhook is off until the signing secret is set', async () => {
  const t = await startApp();
  try {
    const res = await postStripe(t, checkoutEvent('checkout.session.completed'));
    assert.equal(res.status, 503);
  } finally {
    await t.close();
  }
});
