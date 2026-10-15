'use strict';

const { badRequest } = require('./errors');
const { nowIso } = require('./db');
const { addActivity } = require('./contractors');

const WEBSITE_STATUSES = ['live', 'claimed', 'offline'];
const url = (v, label) => {
  const s = String(v ?? '').trim().slice(0, 500);
  if (s && !/^https?:\/\/\S+$/i.test(s)) throw badRequest(`${label} must start with http:// or https://`);
  return s;
};

function normalizeWebsite(input) {
  const out = {};
  if (input.url !== undefined) out.url = url(input.url, 'Site URL');
  if (input.claim_url !== undefined || input.claimUrl !== undefined) out.claim_url = url(input.claim_url ?? input.claimUrl, 'Claim URL');
  if (input.custom_domain !== undefined) out.custom_domain = String(input.custom_domain).trim().toLowerCase().slice(0, 200);
  const siteId = input.netlify_site_id ?? input.siteId;
  if (siteId !== undefined) out.netlify_site_id = String(siteId).trim().slice(0, 100) || null;
  if (input.status !== undefined) {
    if (!WEBSITE_STATUSES.includes(input.status)) throw badRequest(`status must be one of ${WEBSITE_STATUSES.join(', ')}`);
    out.status = input.status;
  }
  return out;
}

/** Records a publish from the Site Builder: creates the website on first deploy, bumps the count after. */
function recordDeploy(db, contractorId, site) {
  const w = normalizeWebsite({ url: site.url || '', claimUrl: site.claimUrl || '', siteId: site.siteId || site.netlify_site_id });
  return db.tx(() => {
    const existing = w.netlify_site_id
      ? db.get('SELECT * FROM websites WHERE netlify_site_id = ?', [w.netlify_site_id])
      : (w.url ? db.get('SELECT * FROM websites WHERE contractor_id = ? AND url = ?', [contractorId, w.url]) : null);
    const now = nowIso();
    let id;
    if (existing) {
      id = existing.id;
      db.run(`UPDATE websites SET url = COALESCE(NULLIF(:url, ''), url), claim_url = COALESCE(NULLIF(:claim_url, ''), claim_url),
                deploy_count = deploy_count + 1, last_deployed_at = :now,
                status = CASE WHEN status = 'offline' THEN 'live' ELSE status END, updated_at = :now
              WHERE id = :id`, { url: w.url, claim_url: w.claim_url, now, id });
    } else {
      id = db.run(`INSERT INTO websites (contractor_id, netlify_site_id, url, claim_url, deploy_count, last_deployed_at)
                   VALUES (?, ?, ?, ?, 1, ?)`, [contractorId, w.netlify_site_id || null, w.url, w.claim_url, now]).lastInsertRowid;
    }
    const row = db.get('SELECT * FROM websites WHERE id = ?', [id]);
    addActivity(db, contractorId, 'deploy',
      `${existing ? 'Site republished' : 'Site published'}${row.url ? `: ${row.url}` : ''} (deploy #${row.deploy_count})`);
    return row;
  });
}

module.exports = { WEBSITE_STATUSES, normalizeWebsite, recordDeploy };
