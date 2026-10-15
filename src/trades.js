'use strict';

// Same trade list and inference rules as the Site Builder (acp-backend-tucson/builder.html),
// so a contractor gets the same trade in the CRM that their site was themed with.

const TRADES = [
  'Masonry', 'Concrete', 'Landscaping', 'Electrical', 'Plumbing', 'HVAC', 'Roofing',
  'Painting', 'Flooring', 'Fencing', 'Carpentry', 'Excavating', 'Grading', 'Sheetrock', 'General',
];

const TRADE_WORDS = [
  [/masonry|block|brick|stone/, 'Masonry'],
  [/concrete|flatwork|cement/, 'Concrete'],
  [/landscap|irrigation|hardscap/, 'Landscaping'],
  [/electric/, 'Electrical'],
  [/plumb/, 'Plumbing'],
  [/air condition|refrigerat|hvac|ventilat|evaporativ|comfort heating/, 'HVAC'],
  [/roof/, 'Roofing'],
  [/paint|wall covering/, 'Painting'],
  [/floor|carpet|tile|ceramic/, 'Flooring'],
  [/fenc/, 'Fencing'],
  [/carpentr/, 'Carpentry'],
  [/excavat/, 'Excavating'],
  [/grading|oil surfacing/, 'Grading'],
  [/drywall|plaster|sheetrock|lath/, 'Sheetrock'],
];

// Arizona ROC classification numbers -> trade (verified against roc.az.gov in the builder)
const TRADE_CODES = {
  2: 'Excavating', 11: 'Electrical', 14: 'Fencing', 21: 'Landscaping', 31: 'Masonry',
  34: 'Painting', 36: 'Sheetrock', 37: 'Plumbing', 39: 'HVAC', 42: 'Roofing',
  48: 'Flooring', 58: 'HVAC', 9: 'Carpentry',
};

function inferTrade(cls, desc) {
  const text = `${desc || ''} ${cls || ''}`.toLowerCase();
  for (const [re, trade] of TRADE_WORDS) if (re.test(text)) return trade;
  const code = String(cls || '').toUpperCase().trim();
  // KB-1/KB-2/B-1/B-2/B-3/A are general classes; their numbers are not trade codes
  if (/^(K?B|A)\b/.test(code) || /^(K?B|A)$/.test(code)) return 'General';
  const m = code.match(/^(?:CR|C|R)-?(\d+)/);
  if (m && TRADE_CODES[m[1]]) return TRADE_CODES[m[1]];
  return 'General';
}

// Accepts the builder's names ("Masonry"), the order form's values ("masonry", "general",
// "other") and free text ("Masonry contractor").
function normalizeTrade(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const exact = TRADES.find(t => t.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  if (/^other$/i.test(s)) return 'General';
  return inferTrade('', s);
}

module.exports = { TRADES, inferTrade, normalizeTrade };
