'use strict';

// Loads demo data so you can click around: npm run seed
// Uses the builder's example contractor plus a few prospects. Safe to re-run (it upserts).
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* optional */ }

const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { upsertContractor, advanceStage, updateContractor } = require('../src/contractors');
const { recordDeploy } = require('../src/websites');
const { upsertOrder } = require('../src/orders');
const { insertLead } = require('../src/leads');
const { recordUsage } = require('../src/usage');

const db = openDatabase(loadConfig().databasePath);
const daysAgo = d => new Date(Date.now() - d * 86400e3).toISOString();

const contractors = [
  {
    // The Site Builder's "Load example" work order
    input: {
      biz: "Luis Rojo's Masonry LLC", owner: 'Luis Rojo', years: '12', trade: 'Masonry', lic: 'KB-2', roc: '337881',
      phone: '520-481-7579', city: 'Tucson', zip: '85706', area: 'Tucson, Marana, Oro Valley, Vail, Sahuarita',
      spec: 'Paver patios and driveways, Block walls, Artificial turf, Concrete flatwork, Outdoor living spaces',
      cust: 'Both', emerg: false, fin: true,
    },
    site: { siteId: 'demo-rojo-masonry', url: 'https://luis-rojos-masonry-llc-x7k2.netlify.app' },
    order: { reference: 'ACW-DEMO-1', packageType: 'complete', amountCents: 37000, status: 'paid' },
    stage: 'live',
    leads: [
      { name: 'Marisol R.', phone: '520-555-0141', service: 'Paver patios and driveways', timeline: 'Within a month', message: 'Back patio, about 400 sq ft. Want pavers instead of the cracked slab.' },
      { name: 'Dan K.', phone: '520-555-0188', email: 'dan.k@example.com', service: 'Block walls', timeline: 'As soon as possible', message: 'Side yard wall, 60 ft run, need a quote.' },
    ],
  },
  {
    input: {
      biz: 'Saguaro Spark Electric', owner: 'Teresa Nunez', trade: 'Electrical', lic: 'CR-11', roc: '341207',
      phone: '520-555-0122', email: 'teresa@example.com', city: 'Marana', zip: '85653', area: 'Marana, Tucson, Oro Valley',
      spec: 'Panel upgrades, EV charger installs, Lighting, Troubleshooting', cust: 'Homeowners', emerg: true,
    },
    site: { siteId: 'demo-saguaro-spark', url: 'https://saguaro-spark-electric-p3q9.netlify.app', claimUrl: 'https://app.netlify.com/claim#demo' },
    stage: 'contacted',
    followUp: 1,
    leads: [{ name: 'Priya S.', phone: '520-555-0170', service: 'EV charger installs', timeline: '1-3 months' }],
  },
  {
    input: {
      biz: 'Desert Cool HVAC', owner: 'Marcus Webb', trade: 'HVAC', lic: 'CR-39', roc: '339954',
      phone: '520-555-0199', city: 'Tucson', zip: '85710', area: 'Tucson, Vail', spec: 'AC repair, AC replacement, Duct cleaning',
    },
    site: { siteId: 'demo-desert-cool', url: 'https://desert-cool-hvac-m2d4.netlify.app' },
    stage: 'demo',
    followUp: -1,
  },
  { input: { biz: 'Catalina Roofing Co', owner: 'Ben Ortiz', trade: 'Roofing', lic: 'CR-42', roc: '342611', phone: '520-555-0133', city: 'Oro Valley', zip: '85737' }, stage: 'prospect' },
  { input: { biz: 'Rincon Paint Works', owner: 'Jill Park', trade: 'Painting', lic: 'CR-34', roc: '342702', phone: '520-555-0155', city: 'Tucson', zip: '85715' }, stage: 'prospect' },
];

for (const c of contractors) {
  const { contractor } = upsertContractor(db, c.input, { source: c.site ? 'builder' : 'roc_import' });
  if (c.site && !db.get('SELECT id FROM websites WHERE netlify_site_id = ?', [c.site.siteId])) {
    recordDeploy(db, contractor.id, c.site);
    advanceStage(db, contractor, 'demo', 'site published');
    // Two copy-generation calls per build, like the builder's copyPackA / copyPackB
    for (const [purpose, inTok, outTok] of [['site_copy', 520, 610], ['faq_reviews', 470, 780]]) {
      recordUsage(db, {
        contractorId: contractor.id, model: 'claude-sonnet-4-6', purpose,
        usage: { input_tokens: inTok, output_tokens: outTok }, source: 'report', requestId: `seed-${contractor.id}-${purpose}`,
      });
    }
  }
  if (c.order) upsertOrder(db, { contractorId: contractor.id, ...c.order });
  if (c.stage && c.stage !== contractor.stage) updateContractor(db, contractor.id, { stage: c.stage });
  if (c.followUp !== undefined) updateContractor(db, contractor.id, { next_follow_up: daysAgo(-c.followUp).slice(0, 10) });
  for (const lead of c.leads || []) {
    if (!db.get('SELECT id FROM leads WHERE contractor_id = ? AND name = ?', [contractor.id, lead.name])) {
      insertLead(db, { contractorId: contractor.id, payload: { ...lead, business: contractor.business_name }, sourceUrl: c.site?.url || '' });
    }
  }
}

console.log(`Seeded ${contractors.length} contractors into ${loadConfig().databasePath}`);
