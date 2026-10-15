import { html, mount, api, setUnauthorizedHandler, toast } from './lib.js';
import * as dashboard from './views/dashboard.js';
import * as contractors from './views/contractors.js';
import * as contractor from './views/contractor.js';
import * as leads from './views/leads.js';
import * as usage from './views/usage.js';
import * as orders from './views/orders.js';
import * as settings from './views/settings.js';

const app = document.getElementById('app');
const state = { meta: null, user: null };

const ROUTES = [
  { re: /^\/?$/, view: dashboard, nav: 'dashboard' },
  { re: /^\/contractors\/?$/, view: contractors, nav: 'contractors' },
  { re: /^\/contractors\/(\d+)$/, view: contractor, nav: 'contractors', params: ['id'] },
  { re: /^\/leads\/?$/, view: leads, nav: 'leads' },
  { re: /^\/usage\/?$/, view: usage, nav: 'usage' },
  { re: /^\/orders\/?$/, view: orders, nav: 'orders' },
  { re: /^\/settings\/?$/, view: settings, nav: 'settings' },
];

const NAV = [
  ['dashboard', '#/', 'Dashboard'],
  ['contractors', '#/contractors', 'Contractors'],
  ['leads', '#/leads', 'Leads'],
  ['usage', '#/usage', 'Token usage'],
  ['orders', '#/orders', 'Orders'],
  ['settings', '#/settings', 'Settings'],
];

export const navigate = hash => { location.hash = hash; };

function parseHash() {
  const [path, qs = ''] = location.hash.replace(/^#/, '').split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs)) };
}

function shell() {
  return html`
    <div class="layout">
      <aside class="side">
        <a class="brand" href="#/">
          <span class="brand-mark" aria-hidden="true"></span>
          <span>AZ Contractor Pro<small>Client CRM</small></span>
        </a>
        <nav aria-label="Main">
          ${NAV.map(([id, href, label]) => html`<a href="${href}" data-nav="${id}">${label}</a>`)}
        </nav>
        <div class="side-foot">
          <span class="who" title="${state.user.email}">${state.user.name || state.user.email}</span>
          <button class="linky" id="logout" type="button">Sign out</button>
        </div>
      </aside>
      <main id="main" tabindex="-1"></main>
    </div>`;
}

async function refreshBadge() {
  try {
    const { counts } = await api('GET', '/api/leads?status=new');
    const nav = document.querySelector('.side nav a[href="#/leads"]');
    if (!nav) return;
    nav.querySelector('.badge')?.remove();
    if (counts.new) nav.insertAdjacentHTML('beforeend', `<span class="badge" title="New leads">${counts.new}</span>`);
  } catch { /* badge is decoration */ }
}

let renderSeq = 0;
async function route() {
  if (!state.user) return;
  const { path, query } = parseHash();
  const match = ROUTES.map(r => ({ r, m: path.match(r.re) })).find(x => x.m);
  if (!match) { navigate('#/'); return; }
  const params = Object.fromEntries((match.r.params || []).map((p, i) => [p, match.m[i + 1]]));

  if (!document.getElementById('main')) {
    mount(app, shell());
    document.getElementById('logout').onclick = logout;
  }
  document.querySelectorAll('.side nav a').forEach(a => {
    const active = a.dataset.nav === match.r.nav;
    a.classList.toggle('on', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  refreshBadge();
  const main = document.getElementById('main');
  const seq = ++renderSeq;
  const view = document.createElement('div');
  view.className = 'view';
  const ctx = { root: view, params, query, meta: state.meta, user: state.user, navigate, refresh: route };
  try {
    await match.r.view.render(ctx);
    if (seq !== renderSeq) return; // a newer navigation won
    main.replaceChildren(view);
    document.title = `${view.dataset.title || 'CRM'} · AZ Contractor Pro`;
  } catch (err) {
    if (seq !== renderSeq || err.status === 401) return;
    main.replaceChildren();
    mount(main, html`<div class="view"><div class="empty"><strong>Could not load this page</strong><p>${err.message}</p></div></div>`);
  }
}

function showLogin(message) {
  state.user = null;
  mount(app, html`
    <div class="login">
      <form class="login-card" id="login">
        <div class="brand big"><span class="brand-mark" aria-hidden="true"></span><span>AZ Contractor Pro<small>Client CRM</small></span></div>
        <label class="f"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="f"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <div class="form-error" ${message ? '' : html`hidden`}>${message || ''}</div>
        <button class="btn stamp block" type="submit">Sign in</button>
      </form>
    </div>`);
  const form = document.getElementById('login');
  form.email.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('POST', '/api/auth/login', { email: form.email.value, password: form.password.value });
      await start();
    } catch (err) {
      showLogin(err.message);
    }
  });
}

async function logout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  showLogin();
}

async function start() {
  try {
    state.meta = await api('GET', '/api/meta');
    state.user = state.meta.user;
  } catch (err) {
    if (err.status === 401) return showLogin();
    mount(app, html`<div class="boot">Could not reach the CRM: ${err.message}</div>`);
    return;
  }
  route();
}

setUnauthorizedHandler(() => {
  if (state.user) toast('Your session ended. Sign in again.', 'err');
  showLogin();
});
window.addEventListener('hashchange', route);
start();
