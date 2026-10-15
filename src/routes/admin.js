'use strict';

const express = require('express');
const { HttpError, badRequest, notFound } = require('../errors');
const { nowIso, monthStartIso } = require('../db');
const { STAGES, CUSTOMER_TYPES, addActivity, getContractor, advanceStage } = require('../contractors');
const { TRADES } = require('../trades');
const { LEAD_STATUSES } = require('../leads');
const { WEBSITE_STATUSES, normalizeWebsite } = require('../websites');
const { PACKAGES, ORDER_STATUSES, toCents, money } = require('../orders');
const { DEFAULT_PRICING, getPricing, savePricing, TOKENS_SQL } = require('../usage');
const { createUser, generateApiKey, hashPassword, verifyPassword } = require('../auth');
const { toCSV } = require('../csv');

const intParam = v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

function adminRouter({ db, config, notifier }) {
  const router = express.Router();

  router.get('/meta', (req, res) => {
    res.json({
      user: req.user, baseUrl: config.baseUrl, stages: STAGES, trades: TRADES, customerTypes: CUSTOMER_TYPES,
      packages: PACKAGES, leadStatuses: LEAD_STATUSES, orderStatuses: ORDER_STATUSES, websiteStatuses: WEBSITE_STATUSES,
    });
  });

  // ---------------------------------------------------------------- dashboard
  router.get('/dashboard', (req, res) => {
    const month = monthStartIso();
    const week = new Date(Date.now() - 7 * 86400e3).toISOString();
    const days30 = new Date(Date.now() - 30 * 86400e3).toISOString();
    const soon = new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10);
    const stageCounts = Object.fromEntries(STAGES.map(s => [s.id, 0]));
    for (const r of db.all('SELECT stage, COUNT(*) AS n FROM contractors GROUP BY stage')) stageCounts[r.stage] = r.n;

    res.json({
      stageCounts,
      totals: {
        contractors: db.get('SELECT COUNT(*) AS n FROM contractors').n,
        clients: (stageCounts.paid || 0) + (stageCounts.live || 0),
        liveSites: db.get("SELECT COUNT(*) AS n FROM websites WHERE status <> 'offline'").n,
        leadsNew: db.get("SELECT COUNT(*) AS n FROM leads WHERE status = 'new'").n,
        leads7d: db.get("SELECT COUNT(*) AS n FROM leads WHERE status <> 'spam' AND created_at >= ?", [week]).n,
        revenueCents: db.get("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM orders WHERE status = 'paid'").n,
        revenue30dCents: db.get("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM orders WHERE status = 'paid' AND paid_at >= ?", [days30]).n,
        tokensMonth: db.get(`SELECT ${TOKENS_SQL} AS n FROM token_usage WHERE created_at >= ?`, [month]).n,
        costMonthMicros: db.get('SELECT COALESCE(SUM(cost_micros), 0) AS n FROM token_usage WHERE created_at >= ?', [month]).n,
      },
      followUps: db.all(`SELECT id, business_name, stage, next_follow_up, phone FROM contractors
                         WHERE next_follow_up IS NOT NULL AND next_follow_up <= ? AND stage <> 'lost'
                         ORDER BY next_follow_up LIMIT 12`, [soon]),
      recentLeads: db.all(`SELECT l.id, l.name, l.phone, l.service, l.status, l.created_at, l.contractor_id, c.business_name
                           FROM leads l LEFT JOIN contractors c ON c.id = l.contractor_id
                           WHERE l.status <> 'spam' ORDER BY l.created_at DESC LIMIT 8`),
      activity: db.all(`SELECT a.id, a.kind, a.body, a.created_at, a.contractor_id, c.business_name, u.name AS user_name
                        FROM activities a JOIN contractors c ON c.id = a.contractor_id LEFT JOIN users u ON u.id = a.user_id
                        ORDER BY a.created_at DESC, a.id DESC LIMIT 15`),
    });
  });

  // ---------------------------------------------------------------- leads
  function leadQuery(query) {
    const where = [];
    const p = {};
    if (LEAD_STATUSES.includes(query.status)) { where.push('l.status = :status'); p.status = query.status; }
    else if (query.status !== 'all') where.push("l.status <> 'spam'");
    if (query.contractor_id) { where.push('l.contractor_id = :cid'); p.cid = Number(query.contractor_id); }
    if (query.unassigned === '1') where.push('l.contractor_id IS NULL');
    const q = String(query.q || '').trim();
    if (q) {
      where.push(`(l.name LIKE :like ESCAPE '\\' OR l.phone LIKE :like ESCAPE '\\' OR l.email LIKE :like ESCAPE '\\'
                   OR l.message LIKE :like ESCAPE '\\' OR c.business_name LIKE :like ESCAPE '\\')`);
      p.like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    }
    return db.all(`SELECT l.*, c.business_name FROM leads l LEFT JOIN contractors c ON c.id = l.contractor_id
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY l.created_at DESC LIMIT 500`, p);
  }

  router.get('/leads', (req, res) => {
    const counts = Object.fromEntries(LEAD_STATUSES.map(s => [s, 0]));
    for (const r of db.all('SELECT status, COUNT(*) AS n FROM leads GROUP BY status')) counts[r.status] = r.n;
    res.json({ leads: leadQuery(req.query), counts });
  });

  router.get('/leads/export.csv', (req, res) => {
    res.type('text/csv').attachment(`leads-${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(toCSV(leadQuery({ ...req.query, status: req.query.status || 'all' }), [
      { label: 'Received', value: r => r.created_at }, { label: 'Contractor', value: r => r.business_name || r.business_label },
      { label: 'Name', value: r => r.name }, { label: 'Phone', value: r => r.phone }, { label: 'Email', value: r => r.email },
      { label: 'Service', value: r => r.service }, { label: 'Timeline', value: r => r.timeline },
      { label: 'Message', value: r => r.message }, { label: 'Status', value: r => r.status },
      { label: 'Source', value: r => r.source_url },
    ]));
  });

  router.patch('/leads/:id', (req, res) => {
    const id = intParam(req.params.id);
    const lead = db.get('SELECT * FROM leads WHERE id = ?', [id]);
    if (!lead) throw notFound('Lead not found');
    const b = req.body || {};
    db.tx(() => {
      if (b.status !== undefined) {
        if (!LEAD_STATUSES.includes(b.status)) throw badRequest(`status must be one of ${LEAD_STATUSES.join(', ')}`);
        db.run('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?', [b.status, nowIso(), id]);
        if (lead.contractor_id && ['won', 'lost'].includes(b.status) && b.status !== lead.status) {
          addActivity(db, lead.contractor_id, 'lead', `Lead ${b.status}: ${lead.name || lead.phone}`, req.user.id);
        }
      }
      if (b.contractor_id !== undefined) {
        const cid = b.contractor_id === null || b.contractor_id === '' ? null : intParam(b.contractor_id);
        if (cid && !getContractor(db, cid)) throw badRequest('That contractor does not exist');
        db.run('UPDATE leads SET contractor_id = ?, updated_at = ? WHERE id = ?', [cid, nowIso(), id]);
        if (cid) addActivity(db, cid, 'lead', `Lead assigned: ${lead.name || lead.phone || lead.email}`, req.user.id);
      }
    });
    res.json({ lead: db.get('SELECT * FROM leads WHERE id = ?', [id]) });
  });

  router.delete('/leads/:id', (req, res) => {
    db.run('DELETE FROM leads WHERE id = ?', [intParam(req.params.id)]);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- websites
  router.patch('/websites/:id', (req, res) => {
    const id = intParam(req.params.id);
    const site = db.get('SELECT * FROM websites WHERE id = ?', [id]);
    if (!site) throw notFound('Website not found');
    const w = normalizeWebsite(req.body || {});
    const cols = Object.keys(w);
    if (cols.length) {
      db.run(`UPDATE websites SET ${cols.map(c => `${c} = :${c}`).join(', ')}, updated_at = :now WHERE id = :id`,
        { ...w, now: nowIso(), id });
    }
    if (w.status && w.status !== site.status) {
      addActivity(db, site.contractor_id, 'deploy', `Website marked ${w.status}: ${site.url}`, req.user.id);
      if (w.status === 'claimed') advanceStage(db, getContractor(db, site.contractor_id), 'live', 'site claimed');
    }
    res.json({ website: db.get('SELECT * FROM websites WHERE id = ?', [id]) });
  });

  router.delete('/websites/:id', (req, res) => {
    db.run('DELETE FROM websites WHERE id = ?', [intParam(req.params.id)]);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- orders
  router.get('/orders', (req, res) => {
    res.json({
      orders: db.all(`SELECT o.*, c.business_name FROM orders o LEFT JOIN contractors c ON c.id = o.contractor_id
                      ORDER BY o.created_at DESC LIMIT 500`),
      totals: db.get(`SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END), 0) AS paid_cents,
                             COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_cents END), 0) AS pending_cents,
                             COUNT(*) AS count FROM orders`),
    });
  });

  router.patch('/orders/:id', (req, res) => {
    const id = intParam(req.params.id);
    const order = db.get('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) throw notFound('Order not found');
    const b = req.body || {};
    if (b.status !== undefined && !ORDER_STATUSES.includes(b.status)) throw badRequest(`status must be one of ${ORDER_STATUSES.join(', ')}`);
    const status = b.status ?? order.status;
    const becamePaid = status === 'paid' && order.status !== 'paid';
    db.tx(() => {
      db.run(`UPDATE orders SET status = :status, amount_cents = :amount, description = :description,
                paid_at = :paid_at, updated_at = :now WHERE id = :id`, {
        status,
        amount: b.amount !== undefined ? toCents(b.amount, order.package_type) : order.amount_cents,
        description: b.description !== undefined ? String(b.description).slice(0, 200) : order.description,
        paid_at: becamePaid ? nowIso() : order.paid_at,
        now: nowIso(), id,
      });
      if (order.contractor_id && status !== order.status) {
        addActivity(db, order.contractor_id, 'order', `Order ${status}: ${order.description} (${money(order.amount_cents)})`, req.user.id);
        if (becamePaid) advanceStage(db, getContractor(db, order.contractor_id), 'paid', 'payment received');
      }
    });
    res.json({ order: db.get('SELECT * FROM orders WHERE id = ?', [id]) });
  });

  router.delete('/orders/:id', (req, res) => {
    db.run('DELETE FROM orders WHERE id = ?', [intParam(req.params.id)]);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- token usage
  router.get('/usage', (req, res) => {
    const month = monthStartIso();
    const now = new Date();
    const since12 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString();
    const totals = since => db.get(`SELECT ${TOKENS_SQL} AS tokens, COALESCE(SUM(input_tokens), 0) AS input_tokens,
                                           COALESCE(SUM(output_tokens), 0) AS output_tokens,
                                           COALESCE(SUM(cost_micros), 0) AS cost_micros, COUNT(*) AS calls
                                    FROM token_usage WHERE created_at >= ?`, [since]);
    res.json({
      month: totals(month),
      allTime: totals('0000'),
      byMonth: db.all(`SELECT substr(created_at, 1, 7) AS month, ${TOKENS_SQL} AS tokens,
                              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
                              COALESCE(SUM(cost_micros), 0) AS cost_micros, COUNT(*) AS calls
                       FROM token_usage WHERE created_at >= ? GROUP BY month ORDER BY month`, [since12]),
      byContractor: db.all(`
        SELECT c.id, c.business_name, c.stage, c.token_budget_monthly,
          COALESCE(SUM(CASE WHEN t.created_at >= :month THEN t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens END), 0) AS tokens_month,
          COALESCE(SUM(CASE WHEN t.created_at >= :month THEN t.cost_micros END), 0) AS cost_month_micros,
          ${TOKENS_SQL.replace(/\b(input|output|cache_read|cache_write)_tokens/g, 't.$1_tokens')} AS tokens_total,
          COALESCE(SUM(t.cost_micros), 0) AS cost_total_micros,
          COUNT(t.id) AS calls,
          (SELECT COALESCE(SUM(amount_cents), 0) FROM orders o WHERE o.contractor_id = c.id AND o.status = 'paid') AS revenue_cents
        FROM contractors c JOIN token_usage t ON t.contractor_id = c.id
        GROUP BY c.id ORDER BY cost_total_micros DESC LIMIT 200`, { month }),
      unattributed: db.get(`SELECT ${TOKENS_SQL} AS tokens, COALESCE(SUM(cost_micros), 0) AS cost_micros, COUNT(*) AS calls
                            FROM token_usage WHERE contractor_id IS NULL`),
      byModel: db.all(`SELECT model, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
                              COALESCE(SUM(output_tokens), 0) AS output_tokens,
                              COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cache_tokens,
                              COALESCE(SUM(cost_micros), 0) AS cost_micros, MIN(priced) AS priced
                       FROM token_usage GROUP BY model ORDER BY cost_micros DESC`),
      recent: db.all(`SELECT t.*, c.business_name FROM token_usage t LEFT JOIN contractors c ON c.id = t.contractor_id
                      ORDER BY t.created_at DESC LIMIT 50`),
    });
  });

  // ---------------------------------------------------------------- settings
  router.get('/settings', (req, res) => {
    res.json({
      integration: {
        baseUrl: config.baseUrl,
        leadEndpoint: `${config.baseUrl}/hooks/leads/<lead key>`,
        genericLeadEndpoint: `${config.baseUrl}/hooks/leads`,
        builderSyncUrl: `${config.baseUrl}/api/integrations/builder/sync`,
        aiProxyUrl: `${config.baseUrl}/api/integrations/ai/messages`,
        usageUrl: `${config.baseUrl}/api/integrations/usage`,
        ordersUrl: `${config.baseUrl}/api/integrations/orders`,
        squareWebhookUrl: config.square.webhookUrl,
        envBuilderKey: !!config.builderKey,
        anthropicConfigured: !!config.anthropicApiKey,
        aiMaxTokens: config.aiMaxTokens,
        smtpConfigured: notifier.smtpConfigured(),
        squareConfigured: !!config.square.webhookSignatureKey,
        squareOrderLookup: !!config.square.accessToken,
      },
      apiKeys: db.all('SELECT id, name, prefix, last_used_at, revoked_at, created_at FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC'),
      users: db.all('SELECT id, email, name, created_at FROM users ORDER BY created_at'),
      pricing: getPricing(db),
      defaultPricing: DEFAULT_PRICING,
    });
  });

  router.put('/settings/pricing', (req, res) => {
    try {
      savePricing(db, (req.body || {}).pricing);
    } catch (err) {
      throw badRequest(err.message);
    }
    res.json({ pricing: getPricing(db) });
  });

  router.post('/settings/pricing/reset', (req, res) => {
    db.run("DELETE FROM settings WHERE key = 'model_pricing'");
    res.json({ pricing: getPricing(db) });
  });

  router.post('/settings/api-keys', (req, res) => {
    res.status(201).json(generateApiKey(db, (req.body || {}).name));
  });

  router.delete('/settings/api-keys/:id', (req, res) => {
    db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [nowIso(), intParam(req.params.id)]);
    res.json({ ok: true });
  });

  router.post('/settings/users', async (req, res) => {
    const user = await createUser(db, req.body || {});
    res.status(201).json({ user });
  });

  router.delete('/settings/users/:id', (req, res) => {
    const id = intParam(req.params.id);
    if (id === req.user.id) throw badRequest('You cannot remove yourself');
    db.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ ok: true });
  });

  router.post('/settings/password', async (req, res) => {
    const { current, next } = req.body || {};
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!(await verifyPassword(String(current || ''), row.password_hash))) throw new HttpError(400, 'Current password is incorrect');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(String(next || '')), req.user.id]);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { adminRouter };
