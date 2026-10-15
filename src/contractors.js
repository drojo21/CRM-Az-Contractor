'use strict';

const crypto = require('node:crypto');
const { normalizeTrade } = require('./trades');
const { badRequest } = require('./errors');
const { nowIso } = require('./db');

const STAGES = [
  { id: 'prospect', label: 'Prospect' },
  { id: 'demo', label: 'Demo site' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'paid', label: 'Paid' },
  { id: 'live', label: 'Live' },
  { id: 'lost', label: 'Lost' },
];
const STAGE_IDS = STAGES.map(s => s.id);
const STAGE_LABEL = Object.fromEntries(STAGES.map(s => [s.id, s.label]));
const PIPELINE_RANK = { prospect: 0, demo: 1, contacted: 2, paid: 3, live: 4 };
const CUSTOMER_TYPES = ['Homeowners', 'Commercial', 'Both'];

// Every column an admin or integration may set. Order matters only for INSERT readability.
const COLUMNS = [
  'business_name', 'owner_name', 'contact_name', 'email', 'phone', 'trade', 'license_class',
  'roc_number', 'license_issued', 'years_in_business', 'city', 'zip', 'service_area', 'services',
  'customer_type', 'emergency_service', 'payment_plans', 'previous_website', 'stage', 'source',
  'lead_forward_url', 'notify_leads', 'token_budget_monthly', 'next_follow_up',
];
const JSON_COLUMNS = new Set(['service_area', 'services']);

// Field aliases: CRM (snake_case), payment-server.js order form (camelCase),
// Site Builder work order (short ids) and ROC roster rows.
const ALIASES = {
  business_name: ['business_name', 'businessName', 'biz', 'business'],
  owner_name: ['owner_name', 'ownerName', 'owner', 'qp'],
  contact_name: ['contact_name', 'contactName'],
  email: ['email'],
  phone: ['phone'],
  trade: ['trade', 'tradeType'],
  license_class: ['license_class', 'licenseClass', 'lic', 'cls'],
  roc_number: ['roc_number', 'rocNumber', 'roc'],
  license_issued: ['license_issued', 'issued'],
  years_in_business: ['years_in_business', 'yearsInBusiness', 'years'],
  city: ['city'],
  zip: ['zip'],
  service_area: ['service_area', 'serviceArea', 'area'],
  services: ['services', 'spec'],
  customer_type: ['customer_type', 'customerType', 'cust'],
  emergency_service: ['emergency_service', 'emergencyService', 'emerg'],
  payment_plans: ['payment_plans', 'paymentPlans', 'fin'],
  previous_website: ['previous_website', 'web'],
  stage: ['stage'],
  lead_forward_url: ['lead_forward_url', 'leadForwardUrl'],
  notify_leads: ['notify_leads', 'notifyLeads'],
  token_budget_monthly: ['token_budget_monthly', 'tokenBudgetMonthly'],
  next_follow_up: ['next_follow_up', 'nextFollowUp'],
};

const pick = (input, keys) => {
  for (const k of keys) if (input[k] !== undefined) return input[k];
  return undefined;
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const list = v => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/))
  .map(x => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 50);
const flag = v => v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v ?? ''));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turns any supported input shape into contractor columns. Only keys present in the input
 * appear in the output, so the result works for both create and partial update.
 * strict = true (admin edits) rejects bad values; strict = false (integrations) drops them.
 */
function normalizeContractorInput(input, { strict = true } = {}) {
  if (!input || typeof input !== 'object') throw badRequest('Expected a contractor object');
  const out = {};
  const reject = msg => { if (strict) throw badRequest(msg); };

  for (const [col, keys] of Object.entries(ALIASES)) {
    const v = pick(input, keys);
    if (v === undefined) continue;
    switch (col) {
      case 'trade':
        out.trade = normalizeTrade(v) || 'General';
        break;
      case 'roc_number':
        out.roc_number = String(v ?? '').replace(/[^0-9]/g, '').slice(0, 12);
        break;
      case 'years_in_business': {
        const n = parseInt(v, 10);
        out.years_in_business = Number.isFinite(n) && n >= 0 && n < 200 ? n : null;
        break;
      }
      case 'zip':
        out.zip = str(v, 10);
        break;
      case 'service_area':
      case 'services':
        out[col] = list(v);
        break;
      case 'customer_type': {
        const match = CUSTOMER_TYPES.find(t => t.toLowerCase() === str(v).toLowerCase());
        if (match) out.customer_type = match;
        else reject(`customer_type must be one of ${CUSTOMER_TYPES.join(', ')}`);
        break;
      }
      case 'emergency_service':
      case 'payment_plans':
      case 'notify_leads':
        out[col] = flag(v);
        break;
      case 'stage':
        if (STAGE_IDS.includes(v)) out.stage = v;
        else reject(`stage must be one of ${STAGE_IDS.join(', ')}`);
        break;
      case 'email': {
        const e = str(v, 254);
        if (!e || EMAIL_RE.test(e)) out.email = e;
        else reject('That email address does not look right');
        break;
      }
      case 'lead_forward_url': {
        const u = str(v, 500);
        if (!u || /^https?:\/\/[^\s]+$/i.test(u)) out.lead_forward_url = u;
        else reject('Lead forwarding URL must start with http:// or https://');
        break;
      }
      case 'previous_website':
        out.previous_website = str(v, 300);
        break;
      case 'token_budget_monthly': {
        if (v === null || v === '') { out.token_budget_monthly = null; break; }
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 0) out.token_budget_monthly = n;
        else reject('Token budget must be a whole number of tokens');
        break;
      }
      case 'next_follow_up': {
        if (v === null || v === '') { out.next_follow_up = null; break; }
        const d = str(v, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.next_follow_up = d;
        else reject('Follow-up date must be YYYY-MM-DD');
        break;
      }
      default:
        out[col] = str(v);
    }
  }
  if (out.business_name !== undefined && !out.business_name) reject('Business name is required');
  if (out.business_name === '') delete out.business_name;
  return out;
}

const toDb = (col, v) => (JSON_COLUMNS.has(col) ? JSON.stringify(v ?? []) : v);

function serializeContractor(row) {
  if (!row) return null;
  const c = { ...row };
  for (const col of JSON_COLUMNS) {
    try { c[col] = JSON.parse(c[col] || '[]'); } catch { c[col] = []; }
  }
  c.emergency_service = !!c.emergency_service;
  c.payment_plans = !!c.payment_plans;
  c.notify_leads = !!c.notify_leads;
  return c;
}

const newLeadKey = () => crypto.randomBytes(18).toString('base64url');

function addActivity(db, contractorId, kind, body, userId = null) {
  db.run('INSERT INTO activities (contractor_id, user_id, kind, body) VALUES (?, ?, ?, ?)',
    [contractorId, userId, kind, String(body).slice(0, 4000)]);
}

function getContractor(db, id) {
  return serializeContractor(db.get('SELECT * FROM contractors WHERE id = ?', [id]));
}

function createContractor(db, fields, { source = 'manual', userId = null } = {}) {
  if (!fields.business_name) throw badRequest('Business name is required');
  return db.tx(() => {
    const data = { ...fields, source: fields.source || source };
    const cols = COLUMNS.filter(c => data[c] !== undefined);
    const now = nowIso();
    const result = db.run(
      `INSERT INTO contractors (${cols.join(', ')}, lead_key, created_at, updated_at)
       VALUES (${cols.map(c => ':' + c).join(', ')}, :lead_key, :now, :now)`,
      { ...Object.fromEntries(cols.map(c => [c, toDb(c, data[c])])), lead_key: newLeadKey(), now },
    );
    const id = result.lastInsertRowid;
    addActivity(db, id, 'created', `Added from ${SOURCE_LABEL[data.source] || data.source}`, userId);
    return getContractor(db, id);
  });
}

const SOURCE_LABEL = {
  manual: 'the CRM', builder: 'the Site Builder', roc_import: 'an ROC roster import',
  square: 'a Square payment', payment_server: 'the order form',
};

function updateContractor(db, id, fields, { userId = null } = {}) {
  return db.tx(() => {
    const before = getContractor(db, id);
    if (!before) return null;
    const cols = COLUMNS.filter(c => fields[c] !== undefined && c !== 'source');
    if (cols.length) {
      db.run(
        `UPDATE contractors SET ${cols.map(c => `${c} = :${c}`).join(', ')}, updated_at = :now WHERE id = :id`,
        { ...Object.fromEntries(cols.map(c => [c, toDb(c, fields[c])])), now: nowIso(), id },
      );
    }
    if (fields.stage && fields.stage !== before.stage) {
      addActivity(db, id, 'stage', `Stage: ${STAGE_LABEL[before.stage]} → ${STAGE_LABEL[fields.stage]}`, userId);
    }
    return getContractor(db, id);
  });
}

/**
 * Finds an existing contractor for incoming data, strongest identifier first. The weaker
 * matches (site, name, email) skip records holding a different ROC number: two licensees can
 * share a DBA name, and they must stay separate.
 */
function findContractorMatch(db, { id, roc_number, netlify_site_id, business_name, email } = {}) {
  if (id) return db.get('SELECT * FROM contractors WHERE id = ?', [id]) || null;
  if (roc_number) {
    const row = db.get('SELECT * FROM contractors WHERE roc_number = ?', [roc_number]);
    if (row) return row;
  }
  const compatible = `(roc_number = '' OR :roc = '' OR roc_number = :roc)`;
  const roc = roc_number || '';
  if (netlify_site_id) {
    const row = db.get(`SELECT c.* FROM websites w JOIN contractors c ON c.id = w.contractor_id
                        WHERE w.netlify_site_id = :site AND ${compatible.replace(/roc_number/g, 'c.roc_number')}`,
    { site: netlify_site_id, roc });
    if (row) return row;
  }
  if (business_name) {
    const row = db.get(`SELECT * FROM contractors WHERE lower(trim(business_name)) = lower(trim(:name)) AND ${compatible}
                        ORDER BY id LIMIT 1`, { name: business_name, roc });
    if (row) return row;
  }
  if (email) {
    const row = db.get(`SELECT * FROM contractors WHERE email = :email COLLATE NOCASE AND ${compatible}
                        ORDER BY id LIMIT 1`, { email, roc });
    if (row) return row;
  }
  return null;
}

const isBlank = v => v === '' || v == null || (Array.isArray(v) && v.length === 0);

/**
 * Create-or-update from an integration (builder, order form, ROC import).
 * fillOnly = true never overwrites a value already in the CRM (used for ROC imports).
 * Stage is never set here; callers use advanceStage so pipeline moves stay forward-only.
 */
function upsertContractor(db, input, { source, contractorId, netlifySiteId, fillOnly = false } = {}) {
  const fields = normalizeContractorInput(input, { strict: false });
  delete fields.stage;
  return db.tx(() => {
    const match = findContractorMatch(db, {
      id: contractorId, netlify_site_id: netlifySiteId,
      roc_number: fields.roc_number, business_name: fields.business_name, email: fields.email,
    });
    if (!match) {
      if (!fields.business_name) throw badRequest('Business name is required to add a new contractor');
      return { contractor: createContractor(db, fields, { source }), created: true };
    }
    const existing = serializeContractor(match);
    const patch = {};
    for (const [k, v] of Object.entries(fields)) {
      if (isBlank(v)) continue;
      if (fillOnly && !isBlank(existing[k])) continue;
      patch[k] = v;
    }
    // The ROC number is the strongest identity; never let a fuzzy match rewrite it.
    if (existing.roc_number && patch.roc_number && patch.roc_number !== existing.roc_number) delete patch.roc_number;
    return { contractor: updateContractor(db, existing.id, patch), created: false };
  });
}

/** Moves a contractor forward in the pipeline. Never moves backwards; a payment revives a lost deal. */
function advanceStage(db, contractor, target, reason = '') {
  const current = contractor.stage;
  const forward = current === 'lost'
    ? target === 'paid'
    : (PIPELINE_RANK[current] ?? -1) < (PIPELINE_RANK[target] ?? -1);
  if (!forward) return false;
  db.run('UPDATE contractors SET stage = ?, updated_at = ? WHERE id = ?', [target, nowIso(), contractor.id]);
  addActivity(db, contractor.id, 'stage',
    `Stage: ${STAGE_LABEL[current]} → ${STAGE_LABEL[target]}${reason ? ` (${reason})` : ''}`);
  contractor.stage = target;
  return true;
}

const leadCaptureUrl = (config, contractor) => `${config.baseUrl}/hooks/leads/${contractor.lead_key}`;

module.exports = {
  STAGES, STAGE_IDS, STAGE_LABEL, CUSTOMER_TYPES,
  normalizeContractorInput, serializeContractor, getContractor, createContractor,
  updateContractor, findContractorMatch, upsertContractor, advanceStage, addActivity,
  leadCaptureUrl, newLeadKey,
};
