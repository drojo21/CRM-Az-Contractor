'use strict';

const { inferTrade } = require('./trades');

// RFC4180-ish parser: handles quotes, embedded commas and newlines. Ported from builder.html.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  text = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Fuzzy header mapping: ROC exports have moved columns around over the years
const COLS = {
  biz: ['businessname', 'dbaname', 'dba', 'companyname', 'company', 'entityname', 'licensee', 'name', 'businessnamedba'],
  roc: ['licensenumber', 'licensenum', 'licenseno', 'license', 'rocnumber', 'roc', 'licnumber', 'lic'],
  cls: ['classification', 'licenseclass', 'class', 'licensetype', 'type', 'classificationcode', 'classcode'],
  desc: ['classificationdescription', 'classdescription', 'description', 'scopeofwork', 'tradedescription', 'trade'],
  phone: ['phone', 'phonenumber', 'telephone', 'businessphone', 'primaryphone'],
  city: ['city', 'businesscity', 'mailingcity', 'addresscity'],
  zip: ['zip', 'zipcode', 'postalcode', 'businesszip', 'mailingzip'],
  qp: ['qualifyingparty', 'qualifyingpartyname', 'qpname', 'owner', 'ownername', 'principal', 'qp'],
  email: ['email', 'emailaddress', 'businessemail'],
  web: ['website', 'websiteurl', 'url', 'webaddress', 'web'],
  issued: ['issuedate', 'dateissued', 'issued', 'licenseissuedate', 'effectivedate'],
};

function mapHeaders(header) {
  const h = header.map(norm);
  const map = {};
  for (const key in COLS) {
    let idx = h.findIndex(x => COLS[key].includes(x));
    if (idx === -1) idx = h.findIndex(x => x && COLS[key].some(c => c.length > 4 && x.includes(c)));
    if (idx !== -1) map[key] = idx;
  }
  return map;
}

const hasWebsite = url => /\w+\.\w{2,}/.test(url || '');

// Returns { rows, headers } or throws with a message suitable for the UI.
function parseRocRoster(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('That file has no data rows.');
  const map = mapHeaders(rows[0]);
  if (map.biz === undefined) {
    throw new Error(`Could not find a business-name column. Headers seen: ${rows[0].slice(0, 8).join(', ')}`);
  }
  const get = (r, k) => (map[k] === undefined ? '' : String(r[map[k]] || '').trim());
  const out = rows.slice(1).map(r => ({
    biz: get(r, 'biz'),
    roc: get(r, 'roc').replace(/[^0-9]/g, ''),
    cls: get(r, 'cls'),
    desc: get(r, 'desc'),
    phone: get(r, 'phone'),
    city: get(r, 'city'),
    zip: get(r, 'zip').slice(0, 5),
    qp: get(r, 'qp'),
    email: get(r, 'email'),
    web: get(r, 'web'),
    issued: get(r, 'issued'),
    trade: inferTrade(get(r, 'cls'), get(r, 'desc')),
  })).filter(x => x.biz);
  return { rows: out, headers: rows[0] };
}

function toCSV(rows, columns) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    // Lead and contractor fields come from public forms; keep spreadsheets from running them as formulas
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(c => cell(c.label)).join(','),
    ...rows.map(r => columns.map(c => cell(c.value(r))).join(','))].join('\n') + '\n';
}

module.exports = { parseCSV, mapHeaders, parseRocRoster, hasWebsite, toCSV };
