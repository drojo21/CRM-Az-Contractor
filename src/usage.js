'use strict';

const { monthStartIso } = require('./db');

// USD per million tokens. Editable in Settings; these are the defaults.
// cacheWrite is the 5-minute TTL rate (1.25x input). 1-hour cache writes bill at 2x input.
const DEFAULT_PRICING = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function getPricing(db) {
  const row = db.get("SELECT value FROM settings WHERE key = 'model_pricing'");
  if (!row) return { ...DEFAULT_PRICING };
  try { return JSON.parse(row.value); } catch { return { ...DEFAULT_PRICING }; }
}

function validatePricing(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Pricing must be an object keyed by model id');
  const out = {};
  for (const [model, p] of Object.entries(input)) {
    const id = String(model).trim();
    if (!/^[a-z0-9][a-z0-9.\-]{1,80}$/i.test(id)) throw new Error(`"${model}" is not a valid model id`);
    out[id] = {};
    for (const f of PRICE_FIELDS) {
      const n = Number(p?.[f]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${id}: ${f} must be a non-negative number`);
      out[id][f] = n;
    }
  }
  return out;
}

function savePricing(db, pricing) {
  db.run(`INSERT INTO settings (key, value) VALUES ('model_pricing', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(validatePricing(pricing))]);
}

const n = v => Math.max(0, Math.round(Number(v) || 0));

/** Reads a Claude Messages API `usage` object (or our flat report shape). */
function normalizeUsage(u = {}) {
  const writeTotal = n(u.cache_creation_input_tokens ?? u.cache_write_tokens);
  const write1h = Math.min(writeTotal, n(u.cache_creation?.ephemeral_1h_input_tokens));
  return {
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_read_tokens: n(u.cache_read_input_tokens ?? u.cache_read_tokens),
    cache_write_tokens: writeTotal,
    cache_write_1h_tokens: write1h,
  };
}

/**
 * Price in $/MTok equals micro-dollars per token, so cost_micros is a plain dot product.
 * Returns { costMicros, priced }.
 */
function computeCost(pricing, model, usage) {
  const p = pricing[model];
  if (!p) return { costMicros: 0, priced: false };
  const write5m = usage.cache_write_tokens - usage.cache_write_1h_tokens;
  const micros = usage.input_tokens * p.input
    + usage.output_tokens * p.output
    + usage.cache_read_tokens * p.cacheRead
    + write5m * p.cacheWrite
    + usage.cache_write_1h_tokens * p.input * 2;
  return { costMicros: Math.round(micros), priced: true };
}

const totalTokens = u => u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens;

/** Inserts one usage row. Duplicate request ids (Claude message ids) are ignored. */
function recordUsage(db, { contractorId = null, model, purpose = '', usage, source = 'report', requestId = null }) {
  const u = normalizeUsage(usage);
  const modelId = String(model || '').trim().slice(0, 100);
  if (!modelId) throw new Error('model is required');
  const { costMicros, priced } = computeCost(getPricing(db), modelId, u);
  const result = db.run(
    `INSERT INTO token_usage (contractor_id, model, purpose, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cost_micros, priced, source, request_id)
     VALUES (:contractor_id, :model, :purpose, :input_tokens, :output_tokens, :cache_read_tokens,
       :cache_write_tokens, :cost_micros, :priced, :source, :request_id)
     ON CONFLICT(request_id) DO NOTHING`,
    {
      contractor_id: contractorId, model: modelId, purpose: String(purpose || '').slice(0, 60),
      ...u, cost_micros: costMicros, priced, source, request_id: requestId ? String(requestId).slice(0, 120) : null,
    },
  );
  return { inserted: result.changes > 0, costMicros, priced, tokens: totalTokens(u) };
}

const TOKENS_SQL = 'COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)';

function monthTotals(db, contractorId, since = monthStartIso()) {
  return db.get(
    `SELECT ${TOKENS_SQL} AS tokens, COALESCE(SUM(cost_micros), 0) AS cost_micros, COUNT(*) AS calls
     FROM token_usage WHERE contractor_id = ? AND created_at >= ?`, [contractorId, since]);
}

function contractorUsage(db, contractorId) {
  const since12 = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)).toISOString();
  return {
    month: monthTotals(db, contractorId),
    allTime: db.get(
      `SELECT ${TOKENS_SQL} AS tokens, COALESCE(SUM(cost_micros), 0) AS cost_micros, COUNT(*) AS calls
       FROM token_usage WHERE contractor_id = ?`, [contractorId]),
    byMonth: db.all(
      `SELECT substr(created_at, 1, 7) AS month, ${TOKENS_SQL} AS tokens, COALESCE(SUM(cost_micros), 0) AS cost_micros,
              COUNT(*) AS calls
       FROM token_usage WHERE contractor_id = ? AND created_at >= ? GROUP BY month ORDER BY month`,
      [contractorId, since12]),
    recent: db.all(
      `SELECT id, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cost_micros, priced, source, created_at
       FROM token_usage WHERE contractor_id = ? ORDER BY created_at DESC LIMIT 25`, [contractorId]),
  };
}

module.exports = {
  DEFAULT_PRICING, getPricing, savePricing, validatePricing, normalizeUsage, computeCost,
  recordUsage, monthTotals, contractorUsage, totalTokens, TOKENS_SQL,
};
