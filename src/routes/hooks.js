'use strict';

const express = require('express');
const { HttpError, notFound } = require('../errors');
const { rateLimit } = require('../ratelimit');
const { serializeContractor } = require('../contractors');
const { parseLeadPayload, insertLead, contractorForBusinessName } = require('../leads');
const { verifySquareSignature, handleSquareEvent } = require('../square');

/**
 * Public, unauthenticated endpoints:
 *   POST /hooks/leads/:key   quote forms on contractor websites (one key per contractor)
 *   POST /hooks/leads        same, matched by the "business" field, for sites without a key
 *   POST /hooks/square       Square payment webhooks (HMAC verified)
 */
function hooksRouter({ db, config, notifier, fetchImpl, log }) {
  const router = express.Router();

  const openCors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'content-type');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
  const leadBody = [
    express.json({ limit: '32kb' }),
    express.urlencoded({ extended: false, limit: '32kb' }),
    express.text({ type: ['text/plain', 'text/*'], limit: '32kb' }),
  ];
  const leadLimiter = rateLimit({ windowMs: 10 * 60e3, max: 20, message: 'Too many submissions from this address' });

  function accept(req, res, contractorRow) {
    const contractor = serializeContractor(contractorRow);
    const lead = insertLead(db, {
      contractorId: contractor?.id ?? null,
      payload: parseLeadPayload(req.body),
      sourceUrl: req.get('origin') || req.get('referer') || '',
    });
    notifier.leadReceived(contractor, lead);
    res.status(201).json({ ok: true, id: lead.id });
  }

  router.options('/leads', openCors);
  router.options('/leads/:key', openCors);

  router.post('/leads/:key', openCors, leadLimiter, ...leadBody, (req, res) => {
    const row = db.get('SELECT * FROM contractors WHERE lead_key = ?', [req.params.key]);
    if (!row) throw notFound('Unknown lead key');
    accept(req, res, row);
  });

  router.post('/leads', openCors, leadLimiter, ...leadBody, (req, res) => {
    const payload = parseLeadPayload(req.body);
    accept(req, res, contractorForBusinessName(db, payload.business || payload.businessName));
  });

  router.post('/square', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    if (!config.square.webhookSignatureKey) throw new HttpError(503, 'SQUARE_WEBHOOK_SIGNATURE_KEY is not configured');
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const ok = verifySquareSignature({
      signatureKey: config.square.webhookSignatureKey,
      notificationUrl: config.square.webhookUrl,
      rawBody,
      signature: req.get('x-square-hmacsha256-signature'),
    });
    if (!ok) throw new HttpError(401, 'Invalid Square signature');
    let event;
    try { event = JSON.parse(rawBody); } catch { throw new HttpError(400, 'Invalid JSON'); }
    const result = await handleSquareEvent(db, config, event, { fetchImpl, log });
    res.json({ ok: true, ignored: !!result.ignored, orderId: result.order?.id });
  });

  return router;
}

module.exports = { hooksRouter };
