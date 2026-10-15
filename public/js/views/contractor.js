import {
  html, mount, api, on, modal, confirmDialog, options, meter, num, compact, money, usd,
  date, dateTime, ago, addDays, today, telHref, host, copy, toast, empty, raw,
} from '../lib.js';
import { activityItem } from './dashboard.js';

const NOTE_KINDS = [['note', 'Note'], ['call', 'Call'], ['email', 'Email'], ['text', 'Text'], ['meeting', 'Meeting']];

function profileForm(c, meta) {
  const field = (name, label, value, attrs = '') =>
    html`<label class="f"><span>${label}</span><input name="${name}" value="${value ?? ''}" ${raw(attrs)}></label>`;
  return html`
    <form id="profile" class="profile" autocomplete="off">
      <fieldset>
        <legend>Business</legend>
        ${field('business_name', 'Business name', c.business_name, 'required')}
        <div class="grid2">
          ${field('owner_name', 'Owner / qualifying party', c.owner_name)}
          ${field('contact_name', 'Primary contact', c.contact_name)}
          <label class="f"><span>Trade</span><select name="trade">${options(meta.trades, c.trade)}</select></label>
          ${field('years_in_business', 'Years in business', c.years_in_business, 'inputmode="numeric"')}
          ${field('license_class', 'License class', c.license_class, 'placeholder="KB-2"')}
          ${field('roc_number', 'ROC number', c.roc_number, 'inputmode="numeric"')}
        </div>
      </fieldset>
      <fieldset>
        <legend>Contact &amp; territory</legend>
        <div class="grid2">
          ${field('phone', 'Phone', c.phone, 'inputmode="tel"')}
          ${field('email', 'Email', c.email, 'type="email"')}
          ${field('city', 'Home city', c.city)}
          ${field('zip', 'ZIP', c.zip, 'inputmode="numeric"')}
        </div>
        ${field('service_area', 'Service area (comma separated)', c.service_area.join(', '))}
      </fieldset>
      <fieldset>
        <legend>The work</legend>
        <label class="f"><span>Services offered (comma separated)</span><textarea name="services" rows="2">${c.services.join(', ')}</textarea></label>
        <div class="grid2">
          <label class="f"><span>Customers</span><select name="customer_type">${options(meta.customerTypes, c.customer_type)}</select></label>
          ${field('previous_website', 'Their own website (before us)', c.previous_website)}
        </div>
        <div class="checks">
          <label class="chk"><input type="checkbox" name="emergency_service" ${c.emergency_service ? raw('checked') : ''}> Emergency service</label>
          <label class="chk"><input type="checkbox" name="payment_plans" ${c.payment_plans ? raw('checked') : ''}> Payment plans</label>
        </div>
      </fieldset>
      <div class="form-actions"><button class="btn" type="submit">Save profile</button>
        <span class="small muted">Source: ${c.source.replace('_', ' ')} · added ${date(c.created_at)}${c.license_issued ? html` · license issued ${c.license_issued}` : ''}</span></div>
    </form>`;
}

function websitesCard(sites, meta) {
  return html`
    <section class="card">
      <div class="card-head"><h2>Website</h2><button class="linky" data-act="add-site">Add</button></div>
      ${sites.length ? html`<ul class="sites">${sites.map(w => html`
        <li>
          <div class="site-top">
            ${w.url ? html`<a href="${w.url}" target="_blank" rel="noopener" class="site-url">${host(w.url)}<span class="ext"> ↗</span></a>` : html`<span class="muted">No URL</span>`}
            <select data-site-status="${w.id}" aria-label="Site status">${options(meta.websiteStatuses, w.status)}</select>
          </div>
          <div class="small muted">
            ${w.deploy_count ? `${w.deploy_count} deploy${w.deploy_count === 1 ? '' : 's'}` : 'Added by hand'}${w.last_deployed_at ? html` · last ${ago(w.last_deployed_at)}` : ''}
            ${w.netlify_site_id ? html` · <span title="Netlify site id">${w.netlify_site_id}</span>` : ''}
          </div>
          ${w.claim_url && w.status !== 'claimed' ? html`<div class="small">Claim link: <a href="${w.claim_url}" target="_blank" rel="noopener">${host(w.claim_url).slice(0, 40)}</a>
            <button class="linky" data-copy="${w.claim_url}">Copy</button></div>` : ''}
          <button class="linky danger" data-del-site="${w.id}">Remove</button>
        </li>`)}</ul>`
        : html`<p class="muted small">No site yet. Publish one from the Site Builder (it reports here automatically once connected) or add the URL by hand.</p>`}
    </section>`;
}

function leadCaptureCard(c, url) {
  return html`
    <section class="card">
      <div class="card-head"><h2>Lead capture</h2></div>
      <p class="small muted">Paste into the Site Builder's <em>Lead capture URL</em> field, then rebuild and publish. Every quote form on the site lands in this CRM.</p>
      <div class="copyline"><code>${url}</code><button class="btn ghost sm" data-copy="${url}">Copy</button></div>
      <label class="chk"><input type="checkbox" data-field="notify_leads" ${c.notify_leads ? raw('checked') : ''}>
        Email each lead to ${c.email || html`<em>the contractor (add their email in Profile)</em>`}</label>
      <form class="inline-form" data-form="forward">
        <label class="f"><span>Also forward leads to (optional)</span>
          <input name="lead_forward_url" value="${c.lead_forward_url}" placeholder="https://script.google.com/macros/s/…/exec"></label>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
      <div class="btnrow">
        <button class="btn ghost sm" data-act="test-lead">Send test lead</button>
        <button class="linky" data-act="rotate">New URL (stops spam)</button>
      </div>
    </section>`;
}

function usageCard(c, u, revenueCents) {
  const margin = revenueCents ? (u.allTime.cost_micros / 1e4) / revenueCents : null; // AI $ as share of revenue $
  return html`
    <section class="card">
      <div class="card-head"><h2>AI token usage</h2><a class="linky" href="#/usage">All usage</a></div>
      <div class="kv">
        <div><span>This month</span><strong>${compact(u.month.tokens)}</strong><em>${usd(u.month.cost_micros)} · ${num(u.month.calls)} calls</em></div>
        <div><span>All time</span><strong>${usd(u.allTime.cost_micros)}</strong><em>${compact(u.allTime.tokens)} tokens</em></div>
      </div>
      <div class="budget">
        <span class="small">Monthly budget</span>
        ${meter(u.month.tokens, c.token_budget_monthly)}
      </div>
      <form class="inline-form" data-form="budget">
        <label class="f"><span>Token budget per month (blank = none)</span>
          <input name="token_budget_monthly" inputmode="numeric" value="${c.token_budget_monthly ?? ''}" placeholder="e.g. 50000"></label>
        <button class="btn ghost sm" type="submit">Save</button>
      </form>
      ${margin !== null ? html`<p class="small muted">AI cost is ${(margin * 100).toFixed(2)}% of the ${money(revenueCents)} this client has paid.</p>` : ''}
      ${u.recent.length ? html`<ul class="mini">${u.recent.slice(0, 6).map(r => html`
        <li><span>${r.purpose || 'call'}</span><span class="muted">${r.model.replace('claude-', '')}</span>
          <span class="tnum">${compact(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens)}</span>
          <span class="tnum">${r.priced ? usd(r.cost_micros) : '—'}</span></li>`)}</ul>`
        : html`<p class="small muted">No AI calls billed to this contractor yet.</p>`}
    </section>`;
}

function ordersCard(orders) {
  return html`
    <section class="card">
      <div class="card-head"><h2>Orders</h2><button class="linky" data-act="add-order">Record payment</button></div>
      ${orders.length ? html`<ul class="mini orders">${orders.map(o => html`
        <li><span>${o.description}</span><span class="tnum">${money(o.amount_cents)}</span>
          <span class="ord-st st-${o.status}">${o.status}</span><span class="muted small">${date(o.paid_at || o.created_at)}</span></li>`)}</ul>`
        : html`<p class="small muted">No orders yet.</p>`}
    </section>`;
}

function leadsTable(leads, meta) {
  if (!leads.length) return empty('No leads yet', 'Once the site uses this contractor\'s lead capture URL, every quote request shows up here.');
  return html`
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Received</th><th>Who</th><th>Wants</th><th>Status</th></tr></thead>
      <tbody>${leads.map(l => html`
        <tr>
          <td class="small"><span title="${new Date(l.created_at).toLocaleString()}">${dateTime(l.created_at)}</span></td>
          <td><strong>${l.name}</strong>
            <div class="small">${l.phone ? html`<a href="${telHref(l.phone)}">${l.phone}</a>` : ''}${l.phone && l.email ? ' · ' : ''}${l.email ? html`<a href="mailto:${l.email}">${l.email}</a>` : ''}</div></td>
          <td>${l.service}${l.timeline ? html` <span class="muted small">· ${l.timeline}</span>` : ''}
            ${l.message ? html`<div class="small muted clamp">${l.message}</div>` : ''}</td>
          <td><select data-lead-status="${l.id}" aria-label="Lead status">${options(meta.leadStatuses, l.status)}</select></td>
        </tr>`)}</tbody>
    </table></div>`;
}

export async function render(ctx) {
  const d = await api('GET', `/api/contractors/${ctx.params.id}`);
  const c = d.contractor;
  const meta = ctx.meta;
  const revenueCents = d.orders.filter(o => o.status === 'paid').reduce((s, o) => s + o.amount_cents, 0);
  ctx.root.dataset.title = c.business_name;
  const now = today();

  mount(ctx.root, html`
    <nav class="crumbs"><a href="#/contractors">Contractors</a> / <span>${c.business_name}</span></nav>
    <header class="page-head record-head">
      <div>
        <h1>${c.business_name}</h1>
        <p class="sub">
          <span class="tag">${c.trade}</span>
          ${c.roc_number ? html`<span>ROC #${c.roc_number}${c.license_class ? ` · ${c.license_class}` : ''}
            <a href="https://roc.az.gov/" target="_blank" rel="noopener" class="small">verify ↗</a></span>` : html`<span class="muted">No ROC number</span>`}
          ${c.city ? html`<span>${c.city}, AZ</span>` : ''}
          ${c.phone ? html`<a href="${telHref(c.phone)}">${c.phone}</a>` : ''}
          ${c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : ''}
        </p>
      </div>
      <div class="actions">
        <label class="stage-select stage-${c.stage}"><i aria-hidden="true"></i>
          <select data-field="stage" aria-label="Pipeline stage">${options(meta.stages, c.stage, { value: s => s.id, label: s => s.label })}</select>
        </label>
        <button class="btn ghost danger" data-act="delete">Delete</button>
      </div>
    </header>

    <div class="record">
      <div class="record-main">
        <section class="card">
          <details ${c.stage === 'prospect' || !c.phone ? raw('open') : ''}>
            <summary class="card-head"><h2>Profile</h2><span class="small muted">Same fields as the builder's work order</span></summary>
            ${profileForm(c, meta)}
          </details>
        </section>

        <section class="card">
          <div class="card-head"><h2>Activity</h2></div>
          <form class="composer" data-form="note">
            <select name="kind" aria-label="Type">${options(NOTE_KINDS, 'note', { value: k => k[0], label: k => k[1] })}</select>
            <textarea name="body" rows="2" placeholder="Log a call, a note, what was promised…" required></textarea>
            <button class="btn" type="submit">Add</button>
          </form>
          <ul class="timeline">${d.activities.map(a => activityItem(a, { showContractor: false }))}</ul>
        </section>

        <section class="card">
          <div class="card-head"><h2>Leads <span class="muted">${d.leads.length}</span></h2></div>
          ${leadsTable(d.leads, meta)}
        </section>
      </div>

      <aside class="record-side">
        <section class="card">
          <div class="card-head"><h2>Next follow-up</h2></div>
          <div class="followup">
            <input type="date" data-field="next_follow_up" value="${c.next_follow_up || ''}" aria-label="Follow-up date">
            ${c.next_follow_up ? html`<span class="due ${c.next_follow_up < now ? 'late' : c.next_follow_up === now ? 'now' : ''}">
              ${c.next_follow_up < now ? 'Overdue' : c.next_follow_up === now ? 'Today' : ''}</span>` : ''}
          </div>
          <div class="btnrow">
            <button class="chip" data-follow="1">Tomorrow</button><button class="chip" data-follow="3">3 days</button>
            <button class="chip" data-follow="7">1 week</button><button class="chip" data-follow="30">1 month</button>
            ${c.next_follow_up ? html`<button class="linky" data-follow="">Clear</button>` : ''}
          </div>
        </section>
        ${websitesCard(d.websites, meta)}
        ${leadCaptureCard(c, d.leadCaptureUrl)}
        ${usageCard(c, d.usage, revenueCents)}
        ${ordersCard(d.orders)}
      </aside>
    </div>`);

  const patch = async (fields, message = 'Saved') => {
    try {
      await api('PATCH', `/api/contractors/${c.id}`, fields);
      toast(message);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  const root = ctx.root;

  root.querySelector('#profile').addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target;
    const values = Object.fromEntries(new FormData(form));
    values.emergency_service = form.emergency_service.checked;
    values.payment_plans = form.payment_plans.checked;
    patch(values, 'Profile saved');
  });

  on(root, 'change', '[data-field]', (e, el) => {
    const value = el.type === 'checkbox' ? el.checked : el.value;
    patch({ [el.dataset.field]: value });
  });
  on(root, 'click', '[data-follow]', (e, el) => {
    patch({ next_follow_up: el.dataset.follow === '' ? null : addDays(Number(el.dataset.follow)) }, 'Follow-up set');
  });
  on(root, 'submit', 'form[data-form=forward]', (e, form) => {
    e.preventDefault();
    patch({ lead_forward_url: form.lead_forward_url.value.trim() }, 'Forwarding saved');
  });
  on(root, 'submit', 'form[data-form=budget]', (e, form) => {
    e.preventDefault();
    patch({ token_budget_monthly: form.token_budget_monthly.value.replace(/[^0-9]/g, '') || null }, 'Budget saved');
  });
  on(root, 'submit', 'form[data-form=note]', async (e, form) => {
    e.preventDefault();
    try {
      await api('POST', `/api/contractors/${c.id}/activities`, { kind: form.kind.value, body: form.body.value });
      ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  on(root, 'click', '[data-copy]', (e, el) => copy(el.dataset.copy));

  on(root, 'change', '[data-lead-status]', async (e, el) => {
    try {
      await api('PATCH', `/api/leads/${el.dataset.leadStatus}`, { status: el.value });
      toast(`Lead marked ${el.value}`);
      ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  on(root, 'change', '[data-site-status]', async (e, el) => {
    try {
      await api('PATCH', `/api/websites/${el.dataset.siteStatus}`, { status: el.value });
      toast('Website updated');
      ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  on(root, 'click', '[data-del-site]', async (e, el) => {
    if (!(await confirmDialog('Remove this website from the CRM? The live site is not touched.', { confirmLabel: 'Remove' }))) return;
    await api('DELETE', `/api/websites/${el.dataset.delSite}`);
    ctx.refresh();
  });

  on(root, 'click', '[data-act]', async (e, el) => {
    const act = el.dataset.act;
    if (act === 'delete') {
      if (!(await confirmDialog(`Delete ${c.business_name}? Their activity history goes too. Leads and orders are kept but unassigned.`))) return;
      await api('DELETE', `/api/contractors/${c.id}`);
      toast('Contractor deleted');
      ctx.navigate('#/contractors');
    } else if (act === 'test-lead') {
      try {
        const r = await api('POST', `/api/contractors/${c.id}/test-lead`);
        toast(r.emailed ? 'Test lead created and emailed' : 'Test lead created (SMTP is not configured, so no email)');
        ctx.refresh();
      } catch (err) { toast(err.message, 'err'); }
    } else if (act === 'rotate') {
      if (!(await confirmDialog('Make a new lead capture URL? The old one stops working right away, so the site must be republished with the new URL.', { confirmLabel: 'Make new URL' }))) return;
      const r = await api('POST', `/api/contractors/${c.id}/lead-key`);
      copy(r.leadCaptureUrl, 'New URL copied');
      ctx.refresh();
    } else if (act === 'add-site') {
      const site = await modal({
        title: 'Add website',
        body: html`
          <label class="f"><span>Site URL</span><input name="url" type="url" placeholder="https://…" required></label>
          <label class="f"><span>Claim URL (optional)</span><input name="claim_url" type="url"></label>
          <label class="f"><span>Netlify site id (optional)</span><input name="netlify_site_id"></label>`,
        submitLabel: 'Add',
        onSubmit: v => api('POST', `/api/contractors/${c.id}/websites`, v),
      });
      if (site) ctx.refresh();
    } else if (act === 'add-order') {
      const pkgs = Object.entries(meta.packages);
      const pending = modal({
        title: 'Record payment',
        body: html`
          <label class="f"><span>Package</span><select name="package_type" id="pkg">
            ${pkgs.map(([id, p]) => html`<option value="${id}" data-price="${p.price ?? ''}">${p.label}${p.price ? ` · $${p.price}` : ''}</option>`)}
          </select></label>
          <div class="grid2">
            <label class="f"><span>Amount ($)</span><input name="amount" id="amt" inputmode="decimal" value="${pkgs[0][1].price}"></label>
            <label class="f"><span>Status</span><select name="status">${options(meta.orderStatuses, 'paid')}</select></label>
          </div>
          <label class="f"><span>Description (optional)</span><input name="description" placeholder="Defaults to the package name"></label>`,
        submitLabel: 'Record',
        onSubmit: v => api('POST', `/api/contractors/${c.id}/orders`, v),
      });
      // Keep the amount in step with the chosen package
      document.getElementById('pkg').addEventListener('change', e => {
        const price = e.target.selectedOptions[0].dataset.price;
        if (price) document.getElementById('amt').value = price;
      });
      if (await pending) { toast('Payment recorded'); ctx.refresh(); }
    }
  });
}
