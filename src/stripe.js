'use strict';

const crypto = require('node:crypto');
const { nowIso } = require('./db');
const { upsertContractor, findContractorMatch, addActivity, getContractor } = require('./contractors');
const { upsertOrder, money } = require('./orders');

const TOLERANCE_SECONDS = 300;

/**
 * Stripe signs each webhook with the endpoint's secret:
 *   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">[,v1=...]
 * Rejects stale timestamps (replays) as Stripe's own libraries do.
 */
function verifyStripeSignature({ rawBody, header, secret, now = Date.now() }) {
  if (!secret || !header) return false;
  const pairs = String(header).split(',').map(p => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  });
  const t = pairs.find(([k]) => k === 't')?.[1];
  const signatures = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!/^\d+$/.test(t || '') || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'), 'hex');
  return signatures.some(sig => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

const idOf = v => (typeof v === 'string' ? v : v?.id) || null;

// Checkout Session events -> order status. Delayed payment methods complete as "unpaid"
// and settle later with async_payment_succeeded / async_payment_failed.
const SESSION_EVENTS = {
  'checkout.session.completed': s => (s.payment_status === 'unpaid' ? 'pending' : 'paid'),
  'checkout.session.async_payment_succeeded': () => 'paid',
  'checkout.session.async_payment_failed': () => 'canceled',
  'checkout.session.expired': () => 'canceled',
};

function handleSession(db, event) {
  const session = event.data.object;
  const meta = session.metadata || {};
  const email = session.customer_details?.email || session.customer_email || meta.email || '';
  return db.tx(() => {
    // payment-server.js puts the order form fields in the session metadata
    let contractorId = null;
    if (meta.businessName) contractorId = upsertContractor(db, meta, { source: 'stripe' }).contractor.id;
    else if (email) contractorId = findContractorMatch(db, { email })?.id ?? null;

    const order = upsertOrder(db, {
      contractorId,
      reference: meta.orderId || session.client_reference_id || null,
      checkoutSessionId: session.id,
      paymentId: idOf(session.payment_intent),
      packageType: meta.packageType,
      amountCents: Number.isFinite(session.amount_total) ? session.amount_total : undefined,
      status: SESSION_EVENTS[event.type](session),
    });
    return { order };
  });
}

function handleRefund(db, charge) {
  const paymentId = idOf(charge.payment_intent);
  const order = paymentId && db.get('SELECT * FROM orders WHERE payment_id = ?', [paymentId]);
  if (!order) return { ignored: true };
  return db.tx(() => {
    const amount = money(charge.amount_refunded || 0);
    if (charge.refunded) {
      if (order.status !== 'refunded') {
        db.run("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?", [nowIso(), order.id]);
        if (order.contractor_id && getContractor(db, order.contractor_id)) {
          addActivity(db, order.contractor_id, 'order', `Refunded ${amount}: ${order.description}`);
        }
      }
    } else if (order.contractor_id && getContractor(db, order.contractor_id)) {
      addActivity(db, order.contractor_id, 'order', `Partial refund, ${amount} so far: ${order.description}`);
    }
    return { order: db.get('SELECT * FROM orders WHERE id = ?', [order.id]) };
  });
}

/** Records Stripe payment events. Safe to receive the same event more than once. */
function handleStripeEvent(db, event) {
  if (!event?.data?.object) return { ignored: true };
  if (SESSION_EVENTS[event.type]) return handleSession(db, event);
  if (event.type === 'charge.refunded') return handleRefund(db, event.data.object);
  return { ignored: true };
}

module.exports = { verifyStripeSignature, handleStripeEvent };
