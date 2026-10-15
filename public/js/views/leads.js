import { html, mount, api, on, options, num, ago, telHref, toast, empty } from '../lib.js';

const TABS = [['new', 'New'], ['contacted', 'Contacted'], ['won', 'Won'], ['lost', 'Lost'], ['spam', 'Spam'], ['all', 'All']];

export async function render(ctx) {
  const status = ctx.query.status || 'new';
  const qs = new URLSearchParams({ status, q: ctx.query.q || '' });
  if (ctx.query.unassigned) qs.set('unassigned', '1');
  const { leads, counts } = await api('GET', `/api/leads?${qs}`);
  const needsAssign = leads.some(l => !l.contractor_id);
  const contractors = needsAssign ? (await api('GET', '/api/contractors?sort=name')).contractors : [];
  const total = Object.entries(counts).filter(([k]) => k !== 'spam').reduce((s, [, n]) => s + n, 0);
  ctx.root.dataset.title = 'Leads';

  const tabHref = s => {
    const p = new URLSearchParams({ status: s });
    if (ctx.query.q) p.set('q', ctx.query.q);
    return `#/leads?${p}`;
  };

  mount(ctx.root, html`
    <header class="page-head">
      <div><p class="eyebrow">Quote requests from contractor sites</p><h1>Leads</h1></div>
      <div class="actions"><a class="btn ghost" href="/api/leads/export.csv?${qs}" download>Export CSV</a></div>
    </header>

    <nav class="tabs" aria-label="Lead status">
      ${TABS.map(([s, label]) => html`<a href="${tabHref(s)}" class="${s === status ? 'on' : ''}">${label}
        <span class="count">${num(s === 'all' ? total + (counts.spam || 0) : counts[s] || 0)}</span></a>`)}
    </nav>
    <form class="filters" id="lead-search" role="search">
      <input type="search" name="q" value="${ctx.query.q || ''}" placeholder="Search name, phone, email, message, contractor…" aria-label="Search leads">
    </form>

    ${leads.length ? html`<ul class="lead-list">${leads.map(l => html`
      <li class="lead st-${l.status}">
        <div class="lead-who">
          <strong>${l.name || 'No name'}</strong>
          ${l.phone ? html`<a href="${telHref(l.phone)}" class="lead-phone">${l.phone}</a>` : ''}
          ${l.email ? html`<a href="mailto:${l.email}" class="small">${l.email}</a>` : ''}
        </div>
        <div class="lead-what">
          <div>${l.service || html`<span class="muted">No service picked</span>`}${l.timeline ? html` <span class="muted small">· ${l.timeline}</span>` : ''}</div>
          ${l.message ? html`<p class="small clamp">${l.message}</p>` : ''}
          <div class="small">
            ${l.contractor_id
              ? html`For <a href="#/contractors/${l.contractor_id}">${l.business_name}</a>`
              : html`<span class="warn-text">Unassigned</span>${l.business_label ? html` <span class="muted">(form said “${l.business_label}”)</span>` : ''}
                 <select data-assign="${l.id}" aria-label="Assign to contractor"><option value="">Assign to…</option>
                 ${options(contractors, '', { value: c => c.id, label: c => c.business_name })}</select>`}
          </div>
        </div>
        <div class="lead-meta">
          <time datetime="${l.created_at}" title="${new Date(l.created_at).toLocaleString()}">${ago(l.created_at)}</time>
          <select data-status="${l.id}" aria-label="Lead status">${options(ctx.meta.leadStatuses, l.status)}</select>
        </div>
      </li>`)}</ul>`
      : status === 'new'
        ? empty('Inbox zero', 'No new leads. They arrive here the moment someone submits a contractor\'s quote form.')
        : empty('Nothing here', 'No leads with this status.')}
  `);

  const form = ctx.root.querySelector('#lead-search');
  let timer;
  const apply = () => {
    const p = new URLSearchParams({ status });
    if (form.q.value.trim()) p.set('q', form.q.value.trim());
    ctx.navigate(`#/leads?${p}`);
  };
  form.addEventListener('submit', e => { e.preventDefault(); apply(); });
  form.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 350); });
  if (ctx.query.q) requestAnimationFrame(() => { form.q.focus(); form.q.setSelectionRange(form.q.value.length, form.q.value.length); });

  const update = async (id, body, msg) => {
    try {
      await api('PATCH', `/api/leads/${id}`, body);
      toast(msg);
      ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  };
  on(ctx.root, 'change', '[data-status]', (e, el) => update(el.dataset.status, { status: el.value }, `Marked ${el.value}`));
  on(ctx.root, 'change', '[data-assign]', (e, el) => el.value && update(el.dataset.assign, { contractor_id: Number(el.value) }, 'Lead assigned'));
}
