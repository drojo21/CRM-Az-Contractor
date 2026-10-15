import {
  html, mount, api, on, modal, options, stagePill, compact, date, today, host, toast, empty, raw,
} from '../lib.js';

export function newContractorDialog(meta) {
  return modal({
    title: 'New contractor',
    body: html`
      <label class="f"><span>Business name</span><input name="business_name" required></label>
      <div class="grid2">
        <label class="f"><span>Owner</span><input name="owner_name"></label>
        <label class="f"><span>Trade</span><select name="trade">${options(meta.trades, 'General')}</select></label>
        <label class="f"><span>ROC number</span><input name="roc_number" inputmode="numeric"></label>
        <label class="f"><span>License class</span><input name="license_class" placeholder="KB-2"></label>
        <label class="f"><span>Phone</span><input name="phone" inputmode="tel"></label>
        <label class="f"><span>Email</span><input name="email" type="email"></label>
        <label class="f"><span>City</span><input name="city" placeholder="Tucson"></label>
        <label class="f"><span>Stage</span><select name="stage">${options(meta.stages, 'prospect', { value: s => s.id, label: s => s.label })}</select></label>
      </div>`,
    submitLabel: 'Add contractor',
    onSubmit: async v => (await api('POST', '/api/contractors', v)).contractor,
  });
}

function wireImportDrop() {
  const drop = document.getElementById('drop');
  if (!drop) return null;
  const state = { text: '' };
  const input = drop.querySelector('input');
  const take = async file => {
    if (!file) return;
    state.text = await file.text();
    document.getElementById('picked').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  };
  input.addEventListener('change', () => take(input.files[0]));
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
  drop.addEventListener('drop', e => take(e.dataTransfer.files[0]));
  return state;
}

async function runImport(ctx) {
  let state = null;
  const pending = modal({
    title: 'Import ROC new-licenses CSV',
    wide: true,
    body: html`
      <p class="muted">The same file the Site Builder's Roster tab takes. New license numbers become Prospects;
      license numbers already in the CRM only get their blank fields filled in.</p>
      <label class="drop" id="drop">
        <strong>Drop the CSV here</strong><span>or click to choose a file</span>
        <input type="file" accept=".csv,text/csv">
      </label>
      <p class="small muted" id="picked"></p>`,
    submitLabel: 'Import',
    onSubmit: async () => {
      if (!state?.text) throw new Error('Choose a CSV file first');
      return api('POST', '/api/contractors/import', { csv: state.text });
    },
  });
  state = wireImportDrop();
  const result = await pending;
  if (result) {
    toast(`Imported ${result.total}: ${result.created} new, ${result.updated} updated, ${result.noWebsite} with no website`);
    ctx.refresh();
  }
}

export async function render(ctx) {
  const q = ctx.query;
  const params = new URLSearchParams({ q: q.q || '', stage: q.stage || '', trade: q.trade || '', sort: q.sort || 'name' });
  const { contractors } = await api('GET', `/api/contractors?${params}`);
  const now = today();
  ctx.root.dataset.title = 'Contractors';
  const filtered = q.q || q.stage || q.trade;

  mount(ctx.root, html`
    <header class="page-head">
      <div><p class="eyebrow">${contractors.length} ${filtered ? 'matching' : 'total'}</p><h1>Contractors</h1></div>
      <div class="actions">
        <button class="btn ghost" data-act="import">Import ROC CSV</button>
        <a class="btn ghost" href="/api/contractors/export.csv?${params}" download>Export CSV</a>
        <button class="btn stamp" data-act="new">New contractor</button>
      </div>
    </header>

    <form class="filters" id="filters" role="search">
      <input type="search" name="q" value="${q.q || ''}" placeholder="Search name, owner, ROC #, city, phone…" aria-label="Search contractors">
      <select name="stage" aria-label="Stage"><option value="">All stages</option>${options(ctx.meta.stages, q.stage, { value: s => s.id, label: s => s.label })}</select>
      <select name="trade" aria-label="Trade"><option value="">All trades</option>${options(ctx.meta.trades, q.trade)}</select>
      <select name="sort" aria-label="Sort">
        ${options([['name', 'Name A–Z'], ['recent', 'Recently updated'], ['created', 'Newest'], ['followup', 'Follow-up date'], ['leads', 'Most new leads'], ['tokens', 'Most tokens this month']],
          q.sort || 'name', { value: x => x[0], label: x => x[1] })}
      </select>
      ${filtered ? html`<a class="linky" href="#/contractors">Clear</a>` : ''}
    </form>

    ${contractors.length ? html`
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>Business</th><th>Trade</th><th>Stage</th><th>ROC #</th><th>Website</th>
          <th class="r">Leads</th><th class="r">Tokens (mo)</th><th>Follow-up</th>
        </tr></thead>
        <tbody>
          ${contractors.map(c => html`
            <tr data-href="#/contractors/${c.id}">
              <td><a class="biz" href="#/contractors/${c.id}">${c.business_name}</a>
                <div class="small muted">${[c.owner_name, c.city].filter(Boolean).join(' · ')}</div></td>
              <td><span class="tag">${c.trade}</span></td>
              <td>${stagePill(c.stage, ctx.meta)}</td>
              <td class="tnum">${c.roc_number}</td>
              <td>${c.site_url
                ? html`<a href="${c.site_url}" target="_blank" rel="noopener">${host(c.site_url)}</a>`
                : c.previous_website ? html`<span class="small muted" title="${c.previous_website}">Has own site</span>` : html`<span class="small muted">None</span>`}</td>
              <td class="r tnum">${c.leads_new ? html`<strong class="newcount">${c.leads_new} new</strong> / ` : ''}${c.leads_total}</td>
              <td class="r tnum">${c.tokens_month ? compact(c.tokens_month) : raw('<span class="muted">0</span>')}</td>
              <td>${c.next_follow_up ? html`<span class="due ${c.next_follow_up < now ? 'late' : c.next_follow_up === now ? 'now' : ''}">${date(c.next_follow_up)}</span>` : ''}</td>
            </tr>`)}
        </tbody>
      </table>
    </div>` : filtered
      ? empty('No matches', 'Try a different search or clear the filters.')
      : empty('No contractors yet', 'Import the ROC new-licenses CSV, add one by hand, or connect the Site Builder in Settings so every site you publish lands here automatically.')}
  `);

  const form = ctx.root.querySelector('#filters');
  const apply = () => {
    const next = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v && !(k === 'sort' && v === 'name')) next.set(k, v);
    ctx.navigate(`#/contractors${next.toString() ? `?${next}` : ''}`);
  };
  form.addEventListener('change', apply);
  form.addEventListener('submit', e => { e.preventDefault(); apply(); });
  let timer;
  form.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 350); });
  if (q.q) requestAnimationFrame(() => { form.q.focus(); form.q.setSelectionRange(form.q.value.length, form.q.value.length); });

  on(ctx.root, 'click', 'tr[data-href]', (e, tr) => {
    if (e.target.closest('a')) return;
    ctx.navigate(tr.dataset.href);
  });
  on(ctx.root, 'click', '[data-act=new]', async () => {
    const c = await newContractorDialog(ctx.meta);
    if (c) ctx.navigate(`#/contractors/${c.id}`);
  });
  on(ctx.root, 'click', '[data-act=import]', () => runImport(ctx));
}
