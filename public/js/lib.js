// Shared helpers: safe HTML templating, API calls, formatting, toasts, modals.

// ---------------------------------------------------------------- HTML
// html`` escapes every interpolated value unless it is already Safe (another html`` result
// or raw()). Arrays are joined. This is the only way markup gets built, so user data
// from contractor sites can never inject HTML.
class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = s => new Safe(String(s));
export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Safe(out);
}
export function mount(el, content) {
  el.innerHTML = String(content);
  return el;
}

/** Event delegation scoped to one root element. */
export function on(root, event, selector, fn) {
  root.addEventListener(event, e => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) fn(e, target);
  });
}

// ---------------------------------------------------------------- API
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'acp-crm', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- formatting
const nf = new Intl.NumberFormat('en-US');
export const num = n => nf.format(Math.round(Number(n) || 0));
export function compact(n) {
  n = Number(n) || 0;
  if (Math.abs(n) < 1000) return nf.format(Math.round(n));
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
export const money = cents => {
  const d = (Number(cents) || 0) / 100;
  return d.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d % 1 ? 2 : 0, maximumFractionDigits: 2 });
};
/** AI spend from micro-dollars: cents precision above $1, sub-cent below. */
export function usd(micros) {
  const d = (Number(micros) || 0) / 1e6;
  if (d === 0) return '$0';
  if (d >= 1) return d.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  if (d >= 0.01) return `$${d.toFixed(3)}`;
  return `$${d.toFixed(4)}`;
}
export function date(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export function dateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return date(iso);
}
export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
export const addDays = n => new Date(Date.now() + n * 86400e3).toLocaleDateString('en-CA');
export const telHref = phone => `tel:${String(phone || '').replace(/[^0-9+]/g, '')}`;
export const host = url => String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

// ---------------------------------------------------------------- UI bits
export function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Clipboard blocked; select the text and copy it manually', 'err');
  }
}

/**
 * Opens a <dialog> with a form. onSubmit(values, form) may return a promise; throwing keeps the
 * dialog open and shows the message. Resolves with onSubmit's result, or null if cancelled.
 */
export function modal({ title, body, submitLabel = 'Save', wide = false, onSubmit }) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = `modal${wide ? ' wide' : ''}`;
    mount(dlg, html`
      <form method="dialog" novalidate>
        <header><h2>${title}</h2><button type="button" class="x" data-close aria-label="Close">×</button></header>
        <div class="modal-body">${body}</div>
        <div class="form-error" hidden></div>
        <footer>
          <button type="button" class="btn ghost" data-close>Cancel</button>
          <button type="submit" class="btn stamp">${submitLabel}</button>
        </footer>
      </form>`);
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const err = dlg.querySelector('.form-error');
    const close = result => { dlg.close(); dlg.remove(); resolve(result); };
    dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => close(null)));
    dlg.addEventListener('click', e => {
      const btn = e.target.closest('[data-copy]');
      if (btn) copy(btn.dataset.copy);
    });
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(null); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      err.hidden = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        form.querySelectorAll('input[type=checkbox][name]').forEach(cb => { values[cb.name] = cb.checked; });
        close(await onSubmit(values, form));
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        submit.disabled = false;
      }
    });
    dlg.showModal();
    dlg.querySelector('input, select, textarea')?.focus();
  });
}

export function confirmDialog(message, { confirmLabel = 'Delete' } = {}) {
  return modal({ title: 'Are you sure?', body: html`<p>${message}</p>`, submitLabel: confirmLabel, onSubmit: () => true })
    .then(Boolean);
}

// ---------------------------------------------------------------- shared fragments
export function stagePill(stage, meta) {
  const label = meta?.stages.find(s => s.id === stage)?.label || stage;
  return html`<span class="pill stage-${stage}"><i aria-hidden="true"></i>${label}</span>`;
}

export function options(list, selected, { value = x => x, label = x => x } = {}) {
  return list.map(item => html`<option value="${value(item)}" ${String(value(item)) === String(selected ?? '') ? raw('selected') : ''}>${label(item)}</option>`);
}

/** Meter for token budgets: fill shifts accent -> warning -> danger as it fills. */
export function meter(used, budget) {
  if (!budget) return html`<span class="muted small">No budget</span>`;
  const pct = Math.min(100, (used / budget) * 100);
  const level = pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : 'ok';
  return html`<span class="meter ${level}" role="meter" aria-valuemin="0" aria-valuemax="${budget}" aria-valuenow="${used}"
    title="${num(used)} of ${num(budget)} tokens"><span style="width:${pct.toFixed(1)}%"></span></span>
    <span class="small muted tnum">${Math.round(pct)}%</span>`;
}

export const empty = (title, text) => html`<div class="empty"><strong>${title}</strong><p>${text}</p></div>`;
