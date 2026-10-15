'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { HttpError, badRequest } = require('../errors');
const { requireApiKey } = require('../auth');
const {
  upsertContractor, findContractorMatch, getContractor, advanceStage, leadCaptureUrl,
} = require('../contractors');
const { recordDeploy } = require('../websites');
const { upsertOrder, toCents } = require('../orders');
const { getPricing, recordUsage, monthTotals } = require('../usage');

const AnthropicClient = Anthropic.default || Anthropic;
const digits = v => String(v ?? '').replace(/[^0-9]/g, '');

/**
 * Endpoints for our own tools, authenticated with an API key (x-builder-key header):
 *   GET  /api/integrations/ping            check a key works
 *   POST /api/integrations/builder/sync    Site Builder: contractor details + published site
 *   POST /api/integrations/ai/messages     Claude Messages API proxy that bills tokens to a contractor
 *   POST /api/integrations/usage           report token usage from calls made elsewhere
 *   POST /api/integrations/orders          payment-server.js: checkout created / paid
 * CORS is open because the builder runs in a browser tab; auth is the key header, never cookies.
 */
function integrationsRouter({ db, config, anthropic }) {
  const router = express.Router();
  const claude = anthropic || (config.anthropicApiKey ? new AnthropicClient({ apiKey: config.anthropicApiKey }) : null);

  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers',
      'content-type, authorization, x-builder-key, x-api-key, x-contractor-id, x-contractor-roc, x-acp-purpose');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.use(requireApiKey(db, config));

  const resolveContractor = ({ contractorId, roc, businessName } = {}) => {
    const id = Number(contractorId);
    return findContractorMatch(db, {
      id: Number.isInteger(id) && id > 0 ? id : undefined,
      roc_number: digits(roc),
      business_name: businessName ? String(businessName) : undefined,
    });
  };

  const syncResponse = (contractor, extra = {}) => ({
    contractorId: contractor.id,
    stage: contractor.stage,
    leadCaptureUrl: leadCaptureUrl(config, contractor),
    crmUrl: `${config.baseUrl}/#/contractors/${contractor.id}`,
    ...extra,
  });

  router.get('/ping', (req, res) => res.json({ ok: true, key: req.apiKey.name }));

  /**
   * Body: { contractor: <builder readForm() object>, site?: { siteId, url, claimUrl }, usage?: [...] }
   * The contractor object may also be sent at the top level. Call it once before building to get
   * the leadCaptureUrl for the work order, and again after publishing with `site`.
   */
  router.post('/builder/sync', (req, res) => {
    const body = req.body || {};
    const input = body.contractor && typeof body.contractor === 'object' ? body.contractor : body;
    const site = body.site && typeof body.site === 'object' ? body.site : null;
    const siteId = site ? site.siteId || site.netlify_site_id || null : null;

    const out = db.tx(() => {
      const { contractor, created } = upsertContractor(db, input, {
        source: 'builder', contractorId: body.contractorId, netlifySiteId: siteId,
      });
      let website = null;
      if (site && (siteId || site.url)) {
        website = recordDeploy(db, contractor.id, site);
        advanceStage(db, contractor, 'demo', 'site published');
      }
      for (const u of Array.isArray(body.usage) ? body.usage.slice(0, 50) : []) {
        recordUsage(db, {
          contractorId: contractor.id, model: u.model, purpose: u.purpose || 'site_copy',
          usage: u.usage || u, source: 'report', requestId: u.requestId || u.id,
        });
      }
      return { contractor: getContractor(db, contractor.id), created, website };
    });
    res.status(out.created ? 201 : 200).json(syncResponse(out.contractor, { created: out.created, website: out.website }));
  });

  /**
   * Drop-in replacement for POST https://api.anthropic.com/v1/messages (non-streaming).
   * Attribute the call with x-contractor-id / x-contractor-roc headers, or an `acp` object in the
   * body: { contractorId, roc, businessName, purpose }. The `acp` field is stripped before forwarding.
   */
  router.post('/ai/messages', async (req, res) => {
    if (!claude) throw new HttpError(503, 'ANTHROPIC_API_KEY is not configured on the CRM');
    const body = { ...(req.body || {}) };
    const acp = body.acp && typeof body.acp === 'object' ? body.acp : {};
    delete body.acp;
    if (body.stream) throw badRequest('The proxy does not stream; omit "stream"');
    if (!body.model || !Array.isArray(body.messages)) throw badRequest('model and messages are required');

    const pricing = getPricing(db);
    if (!pricing[body.model]) {
      throw badRequest(`Model "${body.model}" has no price on file. Add it under Settings → Model pricing so its usage can be billed.`);
    }
    const requested = parseInt(body.max_tokens, 10);
    body.max_tokens = Math.min(Number.isFinite(requested) && requested > 0 ? requested : config.aiMaxTokens, config.aiMaxTokens);

    const contractor = resolveContractor({
      contractorId: req.get('x-contractor-id') || acp.contractorId,
      roc: req.get('x-contractor-roc') || acp.roc,
      businessName: acp.businessName,
    });
    if (contractor && contractor.token_budget_monthly != null) {
      const used = monthTotals(db, contractor.id).tokens;
      if (used >= contractor.token_budget_monthly) {
        throw new HttpError(429, `${contractor.business_name} has used ${used.toLocaleString()} of its ${contractor.token_budget_monthly.toLocaleString()} token monthly budget`);
      }
    }

    let message;
    try {
      message = await claude.messages.create(body);
    } catch (err) {
      if (err instanceof AnthropicClient.APIConnectionError) throw new HttpError(502, 'Could not reach the Claude API');
      if (err instanceof AnthropicClient.APIError) {
        // An auth failure here is the CRM's own key, not the caller's; don't pass it through as a 401.
        if (err.status === 401 || err.status === 403) throw new HttpError(502, 'The CRM\'s Claude API key was rejected');
        return res.status(err.status || 502).json(err.error || { type: 'error', error: { type: 'api_error', message: err.message } });
      }
      throw err;
    }

    recordUsage(db, {
      contractorId: contractor?.id ?? null,
      model: pricing[message.model] ? message.model : body.model,
      purpose: req.get('x-acp-purpose') || acp.purpose || 'site_copy',
      usage: message.usage,
      source: 'proxy',
      requestId: message.id,
    });
    res.json(message);
  });

  /** Body: one event or { events: [...] }. Each: { model, usage, purpose?, requestId?, contractorId? | roc? | businessName? } */
  router.post('/usage', (req, res) => {
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events : [body];
    if (events.length > 200) throw badRequest('At most 200 events per request');
    const results = db.tx(() => events.map(e => {
      if (!e || !e.model) throw badRequest('Each usage event needs a model');
      const contractor = resolveContractor(e);
      const r = recordUsage(db, {
        contractorId: contractor?.id ?? null, model: e.model, purpose: e.purpose,
        usage: e.usage || e, source: 'report', requestId: e.requestId || e.id,
      });
      return { contractorId: contractor?.id ?? null, ...r };
    }));
    res.status(201).json({ recorded: results.filter(r => r.inserted).length, results });
  });

  /** payment-server.js order shape: { orderId, businessName, contactName, email, phone, tradeType, serviceArea, packageType, amount, status? } */
  router.post('/orders', (req, res) => {
    const body = req.body || {};
    const out = db.tx(() => {
      const { contractor } = upsertContractor(db, body, { source: 'payment_server', contractorId: body.contractorId });
      const order = upsertOrder(db, {
        contractorId: contractor.id,
        reference: body.orderId || body.reference || null,
        squareOrderId: body.squareOrderId || null,
        squarePaymentId: body.squarePaymentId || null,
        packageType: body.packageType,
        amountCents: toCents(body.amount, body.packageType),
        status: body.status || 'pending',
      });
      return { contractor: getContractor(db, contractor.id), order };
    });
    res.status(201).json(syncResponse(out.contractor, { order: out.order }));
  });

  return router;
}

module.exports = { integrationsRouter };
