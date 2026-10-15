'use strict';

const { badRequest } = require('./errors');
const { nowIso } = require('./db');
const { addActivity, advanceStage, getContractor } = require('./contractors');

// Same packages and prices as az-contractor-pro.html / payment-server.js
const PACKAGES = {
  website: { label: 'Professional Website', price: 250 },
  social: { label: 'Social Media Setup', price: 120 },
  complete: { label: 'Complete Package', price: 370 },
  custom: { label: 'Custom / other', price: null },
};
const ORDER_STATUSES = ['pending', 'paid', 'refunded', 'canceled'];

const money = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

function toCents(amount, packageType) {
  if (amount === undefined || amount === null || amount === '') {
    const price = PACKAGES[packageType]?.price;
    return price ? price * 100 : 0;
  }
  const dollars = Number(String(amount).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(dollars) || dollars < 0) throw badRequest('Amount must be a dollar amount');
  return Math.round(dollars * 100);
}

/**
 * Create or update an order, matched by reference (the order form's ACP-... id), then Stripe
 * payment intent, then Stripe checkout session. The payment server and the CRM's own Stripe
 * webhook can both report the same order; they converge on one row.
 * A paid order moves the contractor to the Paid stage. Integrations can't move a paid order back
 * to pending or canceled (webhooks arrive out of order and get retried), and a refund is final;
 * only an admin can change it.
 */
function upsertOrder(db, o) {
  const packageType = PACKAGES[o.packageType] ? o.packageType : 'custom';
  let status = ORDER_STATUSES.includes(o.status) ? o.status : 'pending';
  return db.tx(() => {
    const existing =
      (o.reference && db.get('SELECT * FROM orders WHERE reference = ?', [o.reference])) ||
      (o.paymentId && db.get('SELECT * FROM orders WHERE payment_id = ?', [o.paymentId])) ||
      (o.checkoutSessionId && db.get('SELECT * FROM orders WHERE checkout_session_id = ?', [o.checkoutSessionId])) ||
      null;
    if (existing?.status === 'refunded') status = 'refunded';
    else if (existing?.status === 'paid' && ['pending', 'canceled'].includes(status)) status = 'paid';
    const becamePaid = status === 'paid' && (!existing || existing.status !== 'paid');
    const params = {
      contractor_id: o.contractorId ?? existing?.contractor_id ?? null,
      reference: o.reference || existing?.reference || null,
      checkout_session_id: o.checkoutSessionId || existing?.checkout_session_id || null,
      payment_id: o.paymentId || existing?.payment_id || null,
      package_type: o.packageType ? packageType : existing?.package_type || packageType,
      description: o.description ?? existing?.description ?? PACKAGES[packageType].label,
      amount_cents: o.amountCents ?? existing?.amount_cents ?? 0,
      status,
      paid_at: becamePaid ? nowIso() : existing?.paid_at ?? null,
      now: nowIso(),
    };
    let id;
    if (existing) {
      id = existing.id;
      db.run(`UPDATE orders SET contractor_id = :contractor_id, reference = :reference, checkout_session_id = :checkout_session_id,
                payment_id = :payment_id, package_type = :package_type, description = :description,
                amount_cents = :amount_cents, status = :status, paid_at = :paid_at, updated_at = :now WHERE id = :id`,
      { ...params, id });
    } else {
      id = db.run(`INSERT INTO orders (contractor_id, reference, checkout_session_id, payment_id, package_type,
                     description, amount_cents, status, paid_at)
                   VALUES (:contractor_id, :reference, :checkout_session_id, :payment_id, :package_type,
                     :description, :amount_cents, :status, :paid_at)`, params).lastInsertRowid;
    }
    if (params.contractor_id) {
      const contractor = getContractor(db, params.contractor_id);
      if (becamePaid) {
        addActivity(db, contractor.id, 'order', `Payment received: ${money(params.amount_cents)} · ${params.description}`, o.userId ?? null);
        advanceStage(db, contractor, 'paid', 'payment received');
      } else if (!existing) {
        addActivity(db, contractor.id, 'order', `Order started: ${params.description} (${status})`, o.userId ?? null);
      }
    }
    return db.get('SELECT * FROM orders WHERE id = ?', [id]);
  });
}

module.exports = { PACKAGES, ORDER_STATUSES, toCents, upsertOrder, money };
