'use strict';

const express = require('express');
const { badRequest, notFound } = require('../errors');
const { monthStartIso, nowIso } = require('../db');
const {
  normalizeContractorInput, serializeContractor, getContractor, createContractor, updateContractor,
  upsertContractor, addActivity, leadCaptureUrl, newLeadKey, STAGE_IDS,
} = require('../contractors');
const { parseRocRoster, hasWebsite, toCSV } = require('../csv');
const { normalizeWebsite } = require('../websites');
const { upsertOrder, toCents, ORDER_STATUSES } = require('../orders');
const { insertLead } = require('../leads');
const { contractorUsage, TOKENS_SQL } = require('../usage');

const NOTE_KINDS = ['note', 'call', 'email', 'meeting', 'text'];

const SORTS = {
  name: 'c.business_name COLLATE NOCASE ASC',
  recent: 'c.updated_at DESC',
  created: 'c.created_at DESC',
  followup: 'c.next_follow_up IS NULL, c.next_follow_up ASC, c.business_name COLLATE NOCASE',
  leads: 'leads_new DESC, leads_total DESC, c.business_name COLLATE NOCASE',
  tokens: 'tokens_month DESC, c.business_name COLLATE NOCASE',
};

const LIST_SQL = sort => `
  SELECT c.*,
    (SELECT url FROM websites w WHERE w.contractor_id = c.id
       ORDER BY COALESCE(w.last_deployed_at, w.created_at) DESC LIMIT 1)                      AS site_url,
    (SELECT COUNT(*) FROM leads l WHERE l.contractor_id = c.id AND l.status = 'new')         AS leads_new,
    (SELECT COUNT(*) FROM leads l WHERE l.contractor_id = c.id AND l.status <> 'spam')       AS leads_total,
    (SELECT ${TOKENS_SQL} FROM token_usage t WHERE t.contractor_id = c.id AND t.created_at >= :month) AS tokens_month,
    (SELECT COALESCE(SUM(cost_micros), 0) FROM token_usage t WHERE t.contractor_id = c.id)   AS cost_micros_total,
    (SELECT COALESCE(SUM(amount_cents), 0) FROM orders o WHERE o.contractor_id = c.id AND o.status = 'paid') AS revenue_cents
  FROM contractors c
  WHERE (:q = '' OR c.business_name LIKE :like ESCAPE '\\' OR c.owner_name LIKE :like ESCAPE '\\'
         OR c.roc_number LIKE :like ESCAPE '\\' OR c.city LIKE :like ESCAPE '\\' OR c.email LIKE :like ESCAPE '\\'
         OR c.phone LIKE :like ESCAPE '\\')
    AND (:stage = '' OR c.stage = :stage)
    AND (:trade = '' OR c.trade = :trade)
  ORDER BY ${SORTS[sort] || SORTS.name}
  LIMIT 1000`;

function contractorsRouter({ db, config, notifier }) {
  const router = express.Router();

  const idParam = req => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    return id;
  };
  const mustGet = id => {
    const c = getContractor(db, id);
    if (!c) throw notFound('Contractor not found');
    return c;
  };

  function list(query) {
    const q = String(query.q || '').trim();
    const stage = STAGE_IDS.includes(query.stage) ? query.stage : '';
    return db.all(LIST_SQL(query.sort), {
      q, like: `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`, stage, trade: String(query.trade || ''), month: monthStartIso(),
    }).map(serializeContractor);
  }

  router.get('/', (req, res) => {
    res.json({ contractors: list(req.query) });
  });

  router.get('/export.csv', (req, res) => {
    const rows = list(req.query);
    res.type('text/csv').attachment(`contractors-${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(toCSV(rows, [
      { label: 'ID', value: r => r.id }, { label: 'Business', value: r => r.business_name },
      { label: 'Owner', value: r => r.owner_name }, { label: 'Contact', value: r => r.contact_name },
      { label: 'Email', value: r => r.email }, { label: 'Phone', value: r => r.phone },
      { label: 'Trade', value: r => r.trade }, { label: 'License class', value: r => r.license_class },
      { label: 'ROC #', value: r => r.roc_number }, { label: 'City', value: r => r.city },
      { label: 'ZIP', value: r => r.zip }, { label: 'Service area', value: r => r.service_area.join('; ') },
      { label: 'Stage', value: r => r.stage }, { label: 'Website', value: r => r.site_url || '' },
      { label: 'Leads', value: r => r.leads_total }, { label: 'Revenue', value: r => (r.revenue_cents / 100).toFixed(2) },
      { label: 'AI cost (USD)', value: r => (r.cost_micros_total / 1e6).toFixed(4) },
      { label: 'Next follow-up', value: r => r.next_follow_up || '' }, { label: 'Added', value: r => r.created_at },
    ]));
  });

  router.post('/', (req, res) => {
    const fields = normalizeContractorInput(req.body || {});
    if (fields.roc_number && db.get('SELECT id FROM contractors WHERE roc_number = ?', [fields.roc_number])) {
      throw badRequest(`A contractor with ROC #${fields.roc_number} already exists`);
    }
    const contractor = createContractor(db, fields, { source: 'manual', userId: req.user.id });
    res.status(201).json({ contractor });
  });

  router.post('/import', (req, res) => {
    let parsed;
    try {
      parsed = parseRocRoster(String((req.body || {}).csv || ''));
    } catch (err) {
      throw badRequest(err.message);
    }
    const summary = { total: parsed.rows.length, created: 0, updated: 0, noWebsite: 0 };
    db.tx(() => {
      for (const r of parsed.rows) {
        const { created } = upsertContractor(db, {
          biz: r.biz, roc: r.roc, cls: r.cls, phone: r.phone, city: r.city, zip: r.zip,
          qp: r.qp, email: r.email, web: r.web, issued: r.issued, trade: r.trade,
        }, { source: 'roc_import', fillOnly: true });
        summary[created ? 'created' : 'updated']++;
        if (!hasWebsite(r.web)) summary.noWebsite++;
      }
    });
    res.json(summary);
  });

  router.get('/:id', (req, res) => {
    const id = idParam(req);
    const contractor = mustGet(id);
    res.json({
      contractor,
      leadCaptureUrl: leadCaptureUrl(config, contractor),
      websites: db.all('SELECT * FROM websites WHERE contractor_id = ? ORDER BY created_at DESC', [id]),
      orders: db.all('SELECT * FROM orders WHERE contractor_id = ? ORDER BY created_at DESC', [id]),
      leads: db.all('SELECT * FROM leads WHERE contractor_id = ? ORDER BY created_at DESC LIMIT 100', [id]),
      usage: contractorUsage(db, id),
      activities: db.all(`SELECT a.*, u.name AS user_name, u.email AS user_email FROM activities a
                          LEFT JOIN users u ON u.id = a.user_id
                          WHERE a.contractor_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 150`, [id]),
    });
  });

  router.patch('/:id', (req, res) => {
    const id = idParam(req);
    mustGet(id);
    const fields = normalizeContractorInput(req.body || {});
    if (fields.roc_number && db.get('SELECT id FROM contractors WHERE roc_number = ? AND id <> ?', [fields.roc_number, id])) {
      throw badRequest(`Another contractor already has ROC #${fields.roc_number}`);
    }
    res.json({ contractor: updateContractor(db, id, fields, { userId: req.user.id }) });
  });

  router.delete('/:id', (req, res) => {
    const id = idParam(req);
    mustGet(id);
    db.run('DELETE FROM contractors WHERE id = ?', [id]);
    res.json({ ok: true });
  });

  router.post('/:id/activities', (req, res) => {
    const id = idParam(req);
    mustGet(id);
    const { kind = 'note', body } = req.body || {};
    if (!NOTE_KINDS.includes(kind)) throw badRequest(`kind must be one of ${NOTE_KINDS.join(', ')}`);
    if (!String(body || '').trim()) throw badRequest('Write something first');
    addActivity(db, id, kind, String(body).trim(), req.user.id);
    res.status(201).json({ ok: true });
  });

  router.post('/:id/lead-key', (req, res) => {
    const id = idParam(req);
    mustGet(id);
    db.run('UPDATE contractors SET lead_key = ?, updated_at = ? WHERE id = ?', [newLeadKey(), nowIso(), id]);
    addActivity(db, id, 'system', 'Lead capture URL rotated. The website must be republished with the new URL.', req.user.id);
    const contractor = getContractor(db, id);
    res.json({ leadCaptureUrl: leadCaptureUrl(config, contractor) });
  });

  router.post('/:id/test-lead', async (req, res) => {
    const id = idParam(req);
    const contractor = mustGet(id);
    const lead = insertLead(db, {
      contractorId: id,
      payload: {
        name: 'Test Lead (from the CRM)', phone: '520-555-0100', email: req.user.email,
        service: contractor.services[0] || `${contractor.trade} work`, timeline: 'Just pricing it out',
        message: 'This is a test sent from the CRM to check lead notifications. Mark it as spam or delete it.',
        business: contractor.business_name,
      },
      sourceUrl: 'crm-test',
    });
    await notifier.leadReceived(contractor, lead);
    res.status(201).json({ lead, emailed: notifier.smtpConfigured(), forwarded: !!contractor.lead_forward_url });
  });

  router.post('/:id/websites', (req, res) => {
    const id = idParam(req);
    mustGet(id);
    const w = normalizeWebsite(req.body || {});
    if (!w.url) throw badRequest('Site URL is required');
    const row = db.run(`INSERT INTO websites (contractor_id, netlify_site_id, url, claim_url, custom_domain, status)
                        VALUES (?, ?, ?, ?, ?, ?)`,
    [id, w.netlify_site_id || null, w.url, w.claim_url || '', w.custom_domain || '', w.status || 'live']);
    addActivity(db, id, 'deploy', `Website added: ${w.url}`, req.user.id);
    res.status(201).json({ website: db.get('SELECT * FROM websites WHERE id = ?', [row.lastInsertRowid]) });
  });

  router.post('/:id/orders', (req, res) => {
    const id = idParam(req);
    mustGet(id);
    const b = req.body || {};
    if (b.status && !ORDER_STATUSES.includes(b.status)) throw badRequest(`status must be one of ${ORDER_STATUSES.join(', ')}`);
    const order = upsertOrder(db, {
      contractorId: id, packageType: b.package_type, description: b.description || undefined,
      amountCents: toCents(b.amount, b.package_type), status: b.status || 'paid', userId: req.user.id,
    });
    res.status(201).json({ order });
  });

  return router;
}

module.exports = { contractorsRouter };
