import { html, mount, api, on, num, compact, money, usd, ago, date, today, stagePill, telHref, empty } from '../lib.js';
import { newContractorDialog } from './contractors.js';

const KIND_LABEL = {
  created: 'Added', stage: 'Stage', lead: 'Lead', deploy: 'Website', order: 'Payment', note: 'Note',
  call: 'Call', email: 'Email', meeting: 'Meeting', text: 'Text', system: 'System',
};

export function activityItem(a, { showContractor = true } = {}) {
  return html`
    <li class="act act-${a.kind}">
      <span class="act-kind">${KIND_LABEL[a.kind] || a.kind}</span>
      <div class="act-body">
        ${showContractor ? html`<a class="act-who" href="#/contractors/${a.contractor_id}">${a.business_name}</a>` : ''}
        <p>${a.body}</p>
      </div>
      <time datetime="${a.created_at}" title="${new Date(a.created_at).toLocaleString()}">${ago(a.created_at)}${a.user_name ? html` · ${a.user_name}` : ''}</time>
    </li>`;
}

export async function render(ctx) {
  const d = await api('GET', '/api/dashboard');
  const t = d.totals;
  const now = today();
  ctx.root.dataset.title = 'Dashboard';

  mount(ctx.root, html`
    <header class="page-head">
      <div>
        <p class="eyebrow">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1>Dashboard</h1>
      </div>
      <div class="actions"><button class="btn stamp" data-act="new">New contractor</button></div>
    </header>

    <section class="tiles" aria-label="Key numbers">
      <a class="tile" href="#/contractors?stage=live"><span class="tile-label">Clients</span><span class="tile-value">${num(t.clients)}</span><span class="tile-sub">${num(t.contractors)} contractors total</span></a>
      <div class="tile"><span class="tile-label">Live sites</span><span class="tile-value">${num(t.liveSites)}</span><span class="tile-sub">Built and published</span></div>
      <a class="tile ${t.leadsNew ? 'hot' : ''}" href="#/leads"><span class="tile-label">New leads</span><span class="tile-value">${num(t.leadsNew)}</span><span class="tile-sub">Not yet worked</span></a>
      <a class="tile" href="#/leads?status=all"><span class="tile-label">Leads, last 7 days</span><span class="tile-value">${num(t.leads7d)}</span><span class="tile-sub">From contractor sites</span></a>
      <a class="tile" href="#/orders"><span class="tile-label">Revenue, 30 days</span><span class="tile-value">${money(t.revenue30dCents)}</span><span class="tile-sub">${money(t.revenueCents)} all time</span></a>
      <a class="tile" href="#/usage"><span class="tile-label">AI spend this month</span><span class="tile-value">${usd(t.costMonthMicros)}</span><span class="tile-sub">${compact(t.tokensMonth)} tokens</span></a>
    </section>

    <section class="card pipeline-card">
      <div class="card-head"><h2>Pipeline</h2><a class="linky" href="#/contractors">All contractors</a></div>
      <ol class="pipeline">
        ${ctx.meta.stages.map(s => html`
          <li><a href="#/contractors?stage=${s.id}">
            ${stagePill(s.id, ctx.meta)}
            <span class="pipe-n">${num(d.stageCounts[s.id] || 0)}</span>
          </a></li>`)}
      </ol>
    </section>

    <div class="cols">
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Follow-ups</h2><span class="small muted">Due within a week</span></div>
          ${d.followUps.length ? html`<ul class="rows">
            ${d.followUps.map(f => html`
              <li class="row-item">
                <a href="#/contractors/${f.id}"><strong>${f.business_name}</strong></a>
                ${stagePill(f.stage, ctx.meta)}
                <span class="due ${f.next_follow_up < now ? 'late' : f.next_follow_up === now ? 'now' : ''}">
                  ${f.next_follow_up < now ? 'Overdue · ' : f.next_follow_up === now ? 'Today · ' : ''}${date(f.next_follow_up)}
                </span>
                ${f.phone ? html`<a class="small" href="${telHref(f.phone)}">${f.phone}</a>` : ''}
              </li>`)}
          </ul>` : empty('Nothing due', 'Set a follow-up date on any contractor and it shows up here.')}
        </section>

        <section class="card">
          <div class="card-head"><h2>Latest leads</h2><a class="linky" href="#/leads">Inbox</a></div>
          ${d.recentLeads.length ? html`<ul class="rows">
            ${d.recentLeads.map(l => html`
              <li class="row-item">
                <span><strong>${l.name || l.phone}</strong>${l.service ? html` <span class="muted">· ${l.service}</span>` : ''}</span>
                ${l.contractor_id ? html`<a class="small" href="#/contractors/${l.contractor_id}">${l.business_name}</a>` : html`<span class="small muted">Unassigned</span>`}
                <span class="lead-st st-${l.status}">${l.status}</span>
                <time class="small muted">${ago(l.created_at)}</time>
              </li>`)}
          </ul>` : empty('No leads yet', 'Quote forms on contractor sites post here once their lead capture URL is set.')}
        </section>
      </div>

      <section class="card col">
        <div class="card-head"><h2>Activity</h2></div>
        ${d.activity.length ? html`<ul class="timeline">${d.activity.map(a => activityItem(a))}</ul>`
          : empty('Quiet so far', 'Imports, site publishes, leads and payments all land here.')}
      </section>
    </div>`);

  on(ctx.root, 'click', '[data-act=new]', async () => {
    const c = await newContractorDialog(ctx.meta);
    if (c) ctx.navigate(`#/contractors/${c.id}`);
  });
}
