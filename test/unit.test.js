'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizeContractorInput } = require('../src/contractors');
const { inferTrade, normalizeTrade } = require('../src/trades');
const { parseRocRoster, toCSV } = require('../src/csv');
const { computeCost, normalizeUsage, DEFAULT_PRICING, validatePricing } = require('../src/usage');
const { parseLeadPayload, normalizeLead } = require('../src/leads');
const { verifySquareSignature } = require('../src/square');
const { toCents } = require('../src/orders');

test('normalizes the Site Builder work order shape', () => {
  const out = normalizeContractorInput({
    biz: "Luis Rojo's Masonry LLC", owner: 'Luis Rojo', years: '12', trade: 'Masonry', lic: 'KB-2', roc: '337881',
    phone: '520-481-7579', email: '', city: 'Tucson', zip: '85706', area: ['Tucson', 'Marana'],
    spec: ['Block walls'], cust: 'Both', emerg: false, fin: true, sheet: 'https://script.google.com/x',
  }, { strict: false });
  assert.equal(out.business_name, "Luis Rojo's Masonry LLC");
  assert.equal(out.owner_name, 'Luis Rojo');
  assert.equal(out.years_in_business, 12);
  assert.equal(out.license_class, 'KB-2');
  assert.equal(out.roc_number, '337881');
  assert.deepEqual(out.service_area, ['Tucson', 'Marana']);
  assert.deepEqual(out.services, ['Block walls']);
  assert.equal(out.customer_type, 'Both');
  assert.equal(out.emergency_service, false);
  assert.equal(out.payment_plans, true);
  assert.equal(out.email, '');
  assert.equal('sheet' in out, false);
});

test('normalizes the payment-server order form shape', () => {
  const out = normalizeContractorInput({
    businessName: 'Desert Cool HVAC', contactName: 'Marcus', email: 'm@example.com', phone: '520-555-0199',
    tradeType: 'hvac', serviceArea: 'Tucson, Vail', packageType: 'website', amount: '250',
  }, { strict: false });
  assert.equal(out.business_name, 'Desert Cool HVAC');
  assert.equal(out.contact_name, 'Marcus');
  assert.equal(out.trade, 'HVAC');
  assert.deepEqual(out.service_area, ['Tucson', 'Vail']);
});

test('strict mode rejects bad values, lenient mode drops them', () => {
  assert.throws(() => normalizeContractorInput({ stage: 'nope' }), /stage must be/);
  assert.throws(() => normalizeContractorInput({ email: 'not-an-email' }), /email/);
  assert.throws(() => normalizeContractorInput({ lead_forward_url: 'javascript:alert(1)' }), /http/);
  assert.throws(() => normalizeContractorInput({ business_name: '   ' }), /required/);
  const lenient = normalizeContractorInput({ stage: 'nope', email: 'bad', cust: 'Martians' }, { strict: false });
  assert.deepEqual(lenient, {});
});

test('trade inference matches the builder', () => {
  assert.equal(inferTrade('CR-37', ''), 'Plumbing');
  assert.equal(inferTrade('KB-2', ''), 'General');
  assert.equal(inferTrade('C-9', 'Carpentry, remodeling'), 'Carpentry');
  assert.equal(inferTrade('', 'Masonry walls'), 'Masonry');
  assert.equal(normalizeTrade('general'), 'General');
  assert.equal(normalizeTrade('other'), 'General');
  assert.equal(normalizeTrade('masonry'), 'Masonry');
});

test('parses an ROC roster with quoted fields and odd headers', () => {
  const csv = '﻿License No,Business Name (DBA),Class,Classification Description,City,Zip Code,Phone,Website\r\n'
    + '345001,"Smith & Sons, Plumbing",CR-37,Plumbing,Tucson,85705-1234,520-555-0001,\r\n'
    + '345002,"Acme ""Best"" Roofing",R-42,,Marana,85653,,acmeroofing.com\r\n';
  const { rows } = parseRocRoster(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].biz, 'Smith & Sons, Plumbing');
  assert.equal(rows[0].roc, '345001');
  assert.equal(rows[0].zip, '85705');
  assert.equal(rows[0].trade, 'Plumbing');
  assert.equal(rows[1].biz, 'Acme "Best" Roofing');
  assert.equal(rows[1].trade, 'Roofing');
  assert.throws(() => parseRocRoster('foo,bar\n1,2\n'), /business-name column/);
});

test('CSV export neutralizes spreadsheet formulas', () => {
  const out = toCSV([{ a: '=HYPERLINK("x")', b: 'plain' }], [{ label: 'A', value: r => r.a }, { label: 'B', value: r => r.b }]);
  assert.match(out, /"'=HYPERLINK\(""x""\)"/);
});

test('token cost uses $/MTok as micro-dollars per token', () => {
  const p = DEFAULT_PRICING;
  // Sonnet 4.6: $3 in / $15 out. 1000 in + 500 out = 3000 + 7500 micro$ = $0.0105
  const u = normalizeUsage({ input_tokens: 1000, output_tokens: 500 });
  assert.deepEqual(computeCost(p, 'claude-sonnet-4-6', u), { costMicros: 10500, priced: true });
  // Cache: 1000 read at $0.30, 2000 written of which 500 at the 1h rate (2x input = $6)
  const c = normalizeUsage({
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
  });
  assert.equal(computeCost(p, 'claude-sonnet-4-6', c).costMicros, 1000 * 0.3 + 1500 * 3.75 + 500 * 6);
  assert.deepEqual(computeCost(p, 'mystery-model', u), { costMicros: 0, priced: false });
});

test('pricing validation', () => {
  assert.throws(() => validatePricing({ 'claude-x': { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }), /input/);
  assert.throws(() => validatePricing({ 'bad id!': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }), /valid model/);
  assert.deepEqual(validatePricing({ 'claude-x': { input: '1', output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }),
    { 'claude-x': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } });
});

test('lead payloads: no-cors text/plain JSON, form encoding, aliases, spam', () => {
  const site = { name: 'Ana', phone: '520-555-0100', service: 'Block walls', business: 'X', submitted: '2026-10-01T10:00:00Z' };
  assert.deepEqual(parseLeadPayload(JSON.stringify(site)), site);
  assert.deepEqual(parseLeadPayload('name=Bo&phone=123'), { name: 'Bo', phone: '123' });
  const lead = normalizeLead({ fullName: 'Cy', tel: '555', details: 'hi' });
  assert.equal(lead.name, 'Cy');
  assert.equal(lead.phone, '555');
  assert.equal(lead.message, 'hi');
  assert.equal(lead.spam, false);
  assert.equal(normalizeLead({ name: 'Bot', _gotcha: 'x' }).spam, true);
  assert.equal(normalizeLead({ name: 'Bot', message: 'http://a http://b http://c http://d' }).spam, true);
});

test('Square signature verification', () => {
  const key = 'sq-key';
  const url = 'https://crm.example.com/hooks/square';
  const body = '{"type":"payment.updated"}';
  const signature = crypto.createHmac('sha256', key).update(url + body).digest('base64');
  assert.equal(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: body, signature }), true);
  assert.equal(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: body + ' ', signature }), false);
  assert.equal(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: body, signature: '' }), false);
});

test('order amounts', () => {
  assert.equal(toCents('250', 'website'), 25000);
  assert.equal(toCents('$1,370.50'), 137050);
  assert.equal(toCents(undefined, 'complete'), 37000);
  assert.equal(toCents(undefined, 'custom'), 0);
  assert.throws(() => toCents('abc'), /dollar/);
});
