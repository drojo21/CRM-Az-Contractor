import { html, mount, api, num, compact, usd, money, ago, stagePill, meter, empty } from '../lib.js';

const monthLabel = (ym, opts = { month: 'short' }) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', opts);

/** Last 12 calendar months (UTC, matching how usage is bucketed), zero-filled. */
function lastTwelve(rows) {
  const byMonth = Object.fromEntries(rows.map(r => [r.month, r]));
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
    const key = d.toISOString().slice(0, 7);
    return byMonth[key] || { month: key, tokens: 0, cost_micros: 0, calls: 0 };
  });
}

/** Round up to a clean axis maximum: 1, 2, 2.5 or 5 x 10^n. */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
}

function costChart(months) {
  const max = niceMax(Math.max(...months.map(m => m.cost_micros)) / 1e6);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const current = months[months.length - 1];
  const tickLabel = v => (v === 0 ? '$0' : max < 10
    ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 3 })}` : `$${compact(v)}`);
  return html`
    <figure class="chart" id="cost-chart">
      <figcaption><strong>AI cost by month</strong><span class="muted small">Last 12 months, USD. Hover a bar for tokens and calls.</span></figcaption>
      <div class="plot">
        <div class="yaxis" aria-hidden="true">${ticks.map(v => html`<span style="bottom:${(v / max) * 100}%">${tickLabel(v)}</span>`)}</div>
        <div class="plot-area">
          <div class="gridlines" aria-hidden="true">${ticks.map(() => html`<i></i>`)}</div>
          <div class="bars" role="list">
            ${months.map(m => {
              const pct = (m.cost_micros / 1e6 / max) * 100;
              const label = `${monthLabel(m.month, { month: 'long', year: 'numeric' })}: ${usd(m.cost_micros)} · ${num(m.tokens)} tokens · ${num(m.calls)} calls`;
              return html`
                <div class="bar-slot" role="listitem" tabindex="0" aria-label="${label}" data-tip="${label}">
                  ${m === current && m.cost_micros ? html`<span class="bar-value" style="bottom:calc(${pct.toFixed(2)}% + 4px)">${usd(m.cost_micros)}</span>` : ''}
                  <span class="bar ${m.cost_micros ? '' : 'zero'}" style="height:${pct.toFixed(2)}%"></span>
                </div>`;
            })}
          </div>
          <div class="xaxis" aria-hidden="true">${months.map(m => html`<span>${monthLabel(m.month)}</span>`)}</div>
        </div>
      </div>
      <div class="chart-tip" role="tooltip" hidden></div>
      <details class="table-view"><summary>Show as table</summary>
        <table class="table compact"><thead><tr><th>Month</th><th class="r">Cost</th><th class="r">Tokens</th><th class="r">Calls</th></tr></thead>
        <tbody>${months.map(m => html`<tr><td>${monthLabel(m.month, { month: 'short', year: 'numeric' })}</td>
          <td class="r tnum">${usd(m.cost_micros)}</td><td class="r tnum">${num(m.tokens)}</td><td class="r tnum">${num(m.calls)}</td></tr>`)}</tbody></table>
      </details>
    </figure>`;
}

function wireTooltip(fig) {
  const tip = fig.querySelector('.chart-tip');
  const show = slot => {
    tip.textContent = slot.dataset.tip;
    tip.hidden = false;
    const f = fig.getBoundingClientRect();
    const s = slot.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(s.left + s.width / 2 - f.left, half), f.width - half);
    tip.style.left = `${x}px`;
    tip.style.top = `${s.top - f.top + s.height * 0.15}px`;
  };
  const hide = () => { tip.hidden = true; };
  fig.querySelectorAll('.bar-slot').forEach(slot => {
    slot.addEventListener('mouseenter', () => show(slot));
    slot.addEventListener('focus', () => show(slot));
    slot.addEventListener('mouseleave', hide);
    slot.addEventListener('blur', hide);
  });
}

export async function render(ctx) {
  const u = await api('GET', '/api/usage');
  ctx.root.dataset.title = 'Token usage';
  const months = lastTwelve(u.byMonth);
  const unpriced = u.byModel.filter(m => !m.priced);

  mount(ctx.root, html`
    <header class="page-head">
      <div><p class="eyebrow">Claude API tokens spent building and maintaining client sites</p><h1>Token usage</h1></div>
      <div class="actions"><a class="btn ghost" href="#/settings">Pricing &amp; hookup</a></div>
    </header>

    <section class="tiles four">
      <div class="tile"><span class="tile-label">Tokens this month</span><span class="tile-value">${compact(u.month.tokens)}</span>
        <span class="tile-sub">${compact(u.month.input_tokens)} in · ${compact(u.month.output_tokens)} out</span></div>
      <div class="tile"><span class="tile-label">Cost this month</span><span class="tile-value">${usd(u.month.cost_micros)}</span>
        <span class="tile-sub">${num(u.month.calls)} calls</span></div>
      <div class="tile"><span class="tile-label">Cost all time</span><span class="tile-value">${usd(u.allTime.cost_micros)}</span>
        <span class="tile-sub">${compact(u.allTime.tokens)} tokens</span></div>
      <div class="tile"><span class="tile-label">Average per call</span>
        <span class="tile-value">${u.allTime.calls ? usd(u.allTime.cost_micros / u.allTime.calls) : '$0'}</span>
        <span class="tile-sub">${u.allTime.calls ? `${compact(u.allTime.tokens / u.allTime.calls)} tokens` : 'No calls yet'}</span></div>
    </section>

    ${unpriced.length ? html`<p class="notice">No price on file for ${unpriced.map(m => m.model).join(', ')}, so those calls show $0.
      <a href="#/settings">Add pricing</a> to bill them.</p>` : ''}
    ${u.unattributed.calls ? html`<p class="notice subtle">${num(u.unattributed.calls)} calls (${usd(u.unattributed.cost_micros)}) weren't tied to a contractor.
      Send <code>x-contractor-roc</code> or <code>acp.businessName</code> with each proxied call to attribute them.</p>` : ''}

    <section class="card">${costChart(months)}</section>

    <section class="card">
      <div class="card-head"><h2>By contractor</h2><span class="small muted">AI cost against what the client has paid</span></div>
      ${u.byContractor.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Contractor</th><th>Stage</th><th class="r">Tokens (mo)</th><th>Budget</th><th class="r">Cost (mo)</th>
          <th class="r">Cost (all)</th><th class="r">Paid</th><th class="r">AI % of paid</th></tr></thead>
        <tbody>${u.byContractor.map(r => html`<tr>
          <td><a href="#/contractors/${r.id}">${r.business_name}</a></td>
          <td>${stagePill(r.stage, ctx.meta)}</td>
          <td class="r tnum">${compact(r.tokens_month)}</td>
          <td class="meter-cell">${meter(r.tokens_month, r.token_budget_monthly)}</td>
          <td class="r tnum">${usd(r.cost_month_micros)}</td>
          <td class="r tnum">${usd(r.cost_total_micros)}</td>
          <td class="r tnum">${r.revenue_cents ? money(r.revenue_cents) : html`<span class="muted">—</span>`}</td>
          <td class="r tnum">${r.revenue_cents ? `${((r.cost_total_micros / 1e4 / r.revenue_cents) * 100).toFixed(2)}%` : html`<span class="muted">—</span>`}</td>
        </tr>`)}</tbody></table></div>`
        : empty('No usage yet', 'Point the Site Builder\'s copy generation at the CRM\'s AI proxy, or report usage to /api/integrations/usage. Settings has the snippets.')}
    </section>

    <div class="cols">
      <section class="card col">
        <div class="card-head"><h2>By model</h2></div>
        ${u.byModel.length ? html`<table class="table compact">
          <thead><tr><th>Model</th><th class="r">Calls</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cost</th></tr></thead>
          <tbody>${u.byModel.map(m => html`<tr><td><code>${m.model}</code>${m.priced ? '' : html` <span class="warn-text small">unpriced</span>`}</td>
            <td class="r tnum">${num(m.calls)}</td><td class="r tnum">${compact(m.input_tokens)}</td>
            <td class="r tnum">${compact(m.output_tokens)}</td><td class="r tnum">${usd(m.cost_micros)}</td></tr>`)}</tbody>
        </table>` : html`<p class="muted small">Nothing yet.</p>`}
      </section>
      <section class="card col">
        <div class="card-head"><h2>Recent calls</h2></div>
        ${u.recent.length ? html`<table class="table compact">
          <thead><tr><th>When</th><th>Contractor</th><th>Purpose</th><th class="r">Tokens</th><th class="r">Cost</th></tr></thead>
          <tbody>${u.recent.slice(0, 15).map(r => html`<tr>
            <td class="small">${ago(r.created_at)}</td>
            <td>${r.contractor_id ? html`<a href="#/contractors/${r.contractor_id}">${r.business_name}</a>` : html`<span class="muted">—</span>`}</td>
            <td class="small">${r.purpose}<span class="muted"> · ${r.source}</span></td>
            <td class="r tnum">${compact(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens)}</td>
            <td class="r tnum">${usd(r.cost_micros)}</td></tr>`)}</tbody>
        </table>` : html`<p class="muted small">Nothing yet.</p>`}
      </section>
    </div>`);

  wireTooltip(ctx.root.querySelector('#cost-chart'));
}
