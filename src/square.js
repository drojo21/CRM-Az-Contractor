'use strict';

const crypto = require('node:crypto');
const { upsertContractor, findContractorMatch } = require('./contractors');
const { upsertOrder } = require('./orders');

/**
 * Square signs each webhook as base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody)),
 * sent in the x-square-hmacsha256-signature header. notificationUrl must match the URL
 * configured in the Square dashboard byte for byte.
 */
function verifySquareSignature({ signatureKey, notificationUrl, rawBody, signature }) {
  if (!signatureKey || !signature) return false;
  const expected = crypto.createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchSquareOrder(config, orderId, fetchImpl = fetch) {
  if (!config.square.accessToken || !orderId) return null;
  const base = config.square.environment === 'production'
    ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const res = await fetchImpl(`${base}/v2/orders/${encodeURIComponent(orderId)}`, {
    headers: {
      Authorization: `Bearer ${config.square.accessToken}`,
      'Square-Version': config.square.apiVersion,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Square orders API returned ${res.status}`);
  return (await res.json()).order || null;
}

const SQUARE_STATUS = { COMPLETED: 'paid', CANCELED: 'canceled', FAILED: 'canceled' };

/**
 * Handles payment.created / payment.updated. Webhook payloads are snake_case and do not
 * include the order, so the order (with the metadata payment-server.js attached at checkout:
 * orderId, businessName, packageType, ...) is fetched from the Orders API.
 */
async function handleSquareEvent(db, config, event, { fetchImpl = fetch, log = console } = {}) {
  if (!/^payment\.(created|updated)$/.test(event?.type || '')) return { ignored: true };
  const payment = event.data?.object?.payment;
  if (!payment?.id) return { ignored: true };

  let order = null;
  try {
    order = await fetchSquareOrder(config, payment.order_id, fetchImpl);
  } catch (err) {
    log.warn(`Square order lookup failed: ${err.message}`);
  }
  const meta = order?.metadata || {};

  let contractorId = null;
  if (meta.businessName) {
    contractorId = upsertContractor(db, meta, { source: 'square' }).contractor.id;
  } else if (payment.buyer_email_address) {
    contractorId = findContractorMatch(db, { email: payment.buyer_email_address })?.id ?? null;
  }

  const saved = upsertOrder(db, {
    contractorId,
    reference: meta.orderId || null,
    squareOrderId: payment.order_id || null,
    squarePaymentId: payment.id,
    packageType: meta.packageType,
    description: order?.line_items?.[0]?.name,
    amountCents: Number(payment.amount_money?.amount ?? order?.total_money?.amount ?? 0),
    status: SQUARE_STATUS[payment.status] || 'pending',
  });
  return { order: saved };
}

module.exports = { verifySquareSignature, fetchSquareOrder, handleSquareEvent };
