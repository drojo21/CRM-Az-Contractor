'use strict';

const { badRequest } = require('./errors');
const { addActivity } = require('./contractors');

const LEAD_STATUSES = ['new', 'contacted', 'won', 'lost', 'spam'];

// The quote form on every builder-generated site posts:
//   { name, phone, email, service, timeline, message, business, submitted }
// The aliases cover hand-built sites and form tools.
const FIELD_ALIASES = {
  name: ['name', 'fullName', 'full_name', 'fullname', 'contact_name'],
  phone: ['phone', 'tel', 'telephone', 'phoneNumber', 'phone_number'],
  email: ['email', 'emailAddress', 'email_address'],
  service: ['service', 'serviceNeeded', 'service_needed', 'project_type'],
  timeline: ['timeline', 'timeframe', 'when'],
  message: ['message', 'details', 'project', 'comments', 'notes', 'description'],
  business: ['business', 'businessName'],
  submitted: ['submitted', 'submittedAt', 'timestamp'],
};
const HONEYPOTS = ['_gotcha', 'bot_field', 'hp'];
const LIMITS = { name: 120, phone: 40, email: 254, service: 160, timeline: 80, message: 4000, business: 200 };

/**
 * The generated sites call fetch(..., { mode: 'no-cors' }), which silently drops the JSON
 * content-type, so the body usually arrives as text/plain containing JSON.
 */
function parseLeadPayload(body) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through to form encoding */ }
  return Object.fromEntries(new URLSearchParams(text));
}

function normalizeLead(payload) {
  const lead = {};
  for (const [field, keys] of Object.entries(FIELD_ALIASES)) {
    const key = keys.find(k => payload[k] != null && payload[k] !== '');
    lead[field] = key ? String(payload[key]).trim().slice(0, LIMITS[field] || 100) : '';
  }
  const submitted = Date.parse(lead.submitted);
  lead.submitted = Number.isFinite(submitted) ? new Date(submitted).toISOString() : null;
  const botTrap = HONEYPOTS.some(k => payload[k]);
  const linkSpam = (lead.message.match(/https?:\/\//g) || []).length > 3;
  lead.spam = botTrap || linkSpam;
  return lead;
}

function insertLead(db, { contractorId, payload, sourceUrl = '' }) {
  const lead = normalizeLead(payload);
  if (!lead.name && !lead.phone && !lead.email) throw badRequest('A lead needs at least a name, phone or email');
  const raw = JSON.stringify(payload).slice(0, 8000);
  const { lastInsertRowid } = db.run(
    `INSERT INTO leads (contractor_id, name, phone, email, service, timeline, message, business_label,
       source_url, status, raw, submitted_at)
     VALUES (:contractor_id, :name, :phone, :email, :service, :timeline, :message, :business,
       :source_url, :status, :raw, :submitted)`,
    {
      contractor_id: contractorId, ...lead, source_url: String(sourceUrl).slice(0, 300),
      status: lead.spam ? 'spam' : 'new', raw,
    },
  );
  if (contractorId && !lead.spam) {
    addActivity(db, contractorId, 'lead',
      `New lead: ${lead.name || lead.phone || lead.email}${lead.service ? ` · ${lead.service}` : ''}`);
  }
  return db.get('SELECT * FROM leads WHERE id = ?', [lastInsertRowid]);
}

/** For leads posted without a lead key: match on the business name the site sends. */
function contractorForBusinessName(db, name) {
  if (!name) return null;
  return db.get('SELECT * FROM contractors WHERE lower(trim(business_name)) = lower(trim(?)) ORDER BY id LIMIT 1', [name]) || null;
}

module.exports = { LEAD_STATUSES, parseLeadPayload, normalizeLead, insertLead, contractorForBusinessName };
