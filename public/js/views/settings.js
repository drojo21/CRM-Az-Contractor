import { html, mount, api, on, modal, confirmDialog, copy, toast, date, ago } from '../lib.js';

const paymentSnippet = base => `# Az-Contractor-Pro/.env  (payment-server.js reports every order to the CRM)
CRM_URL=${base}
CRM_KEY=<an API key from the list above>`;

const check = (ok, label, hint) => html`
  <li class="${ok ? 'ok' : 'off'}"><span class="mark" aria-hidden="true">${ok ? '✓' : '—'}</span>
    <span><strong>${label}</strong><span class="small muted">${hint}</span></span></li>`;

export async function render(ctx) {
  const s = await api('GET', '/api/settings');
  const i = s.integration;
  ctx.root.dataset.title = 'Settings';
  const models = Object.keys(s.pricing).sort();

  const endpoint = (label, url, note) => html`
    <li><span class="ep-label">${label}</span><div class="copyline"><code>${url}</code>
      <button class="btn ghost sm" data-copy="${url}">Copy</button></div>${note ? html`<span class="small muted">${note}</span>` : ''}</li>`;

  mount(ctx.root, html`
    <header class="page-head"><div><p class="eyebrow">Integrations, keys, pricing and team</p><h1>Settings</h1></div></header>

    <div class="cols">
      <section class="card col">
        <div class="card-head"><h2>Connections</h2></div>
        <ul class="checklist">
          ${check(i.anthropicConfigured, 'Claude API key', i.anthropicConfigured ? `AI proxy is on, max_tokens capped at ${i.aiMaxTokens}` : 'Set ANTHROPIC_API_KEY to turn on the AI proxy')}
          ${check(i.smtpConfigured, 'Email (SMTP)', i.smtpConfigured ? 'Lead notifications are emailed' : 'Set SMTP_HOST / SMTP_USER / SMTP_PASS to email leads')}
          ${check(i.stripeConfigured, 'Stripe webhook (optional)', i.stripeConfigured ? 'Signed Stripe events are recorded, including refunds' : 'Set STRIPE_WEBHOOK_SECRET to also take payments and refunds straight from Stripe')}
          ${check(i.envBuilderKey || s.apiKeys.some(k => !k.revoked_at), 'Integration key', i.envBuilderKey ? 'BUILDER_KEY is set in the environment' : 'Create a key below for the builder and payment server')}
        </ul>
      </section>
      <section class="card col">
        <div class="card-head"><h2>Endpoints</h2></div>
        <ul class="endpoints">
          ${endpoint('Lead capture (per contractor)', i.leadEndpoint, 'Each contractor page shows its own URL')}
          ${endpoint('Builder sync', i.builderSyncUrl)}
          ${endpoint('AI proxy (Messages API)', i.aiProxyUrl)}
          ${endpoint('Usage reports', i.usageUrl)}
          ${endpoint('Orders', i.ordersUrl)}
          ${endpoint('Stripe webhook URL', i.stripeWebhookUrl, 'Stripe → Developers → Webhooks: checkout.session.completed, async_payment_succeeded, async_payment_failed, expired, and charge.refunded')}
        </ul>
      </section>
    </div>

    <section class="card">
      <div class="card-head"><h2>API keys</h2><button class="btn sm" data-act="new-key">New key</button></div>
      <p class="small muted">Sent as the <code>x-builder-key</code> header by the Site Builder and the payment server. A key is shown once, when it's created.</p>
      ${s.apiKeys.length ? html`<table class="table compact">
        <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>${s.apiKeys.map(k => html`<tr class="${k.revoked_at ? 'revoked' : ''}">
          <td>${k.name}</td><td><code>${k.prefix}…</code></td><td>${date(k.created_at)}</td>
          <td>${k.last_used_at ? ago(k.last_used_at) : html`<span class="muted">Never</span>`}</td>
          <td class="r">${k.revoked_at ? html`<span class="muted small">Revoked ${date(k.revoked_at)}</span>` : html`<button class="linky danger" data-revoke="${k.id}">Revoke</button>`}</td>
        </tr>`)}</tbody></table>` : html`<p class="muted small">No keys yet.</p>`}
    </section>

    <section class="card">
      <div class="card-head"><h2>Hook up the Site Builder</h2></div>
      <p class="small muted">In <code>builder.html</code>, section <strong>6 · CRM</strong>, enter this URL and an API key from the list above.
        From then on every build registers the contractor and points the quote form at their lead URL, copy generation is billed
        to them through the AI proxy, and each publish records the site here. Single builds and roster batches both work.</p>
      <div class="copyline"><code>${i.baseUrl}</code><button class="btn ghost sm" data-copy="${i.baseUrl}">Copy</button></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Hook up the payment server</h2><button class="btn ghost sm" data-copy="${paymentSnippet(i.baseUrl)}">Copy</button></div>
      <p class="small muted"><code>payment-server.js</code> takes payment with Stripe Checkout and reports each order here when checkout
        starts and again when Stripe confirms the payment. Give it the CRM's URL and an API key. Adding the CRM's own Stripe webhook
        (above) is optional: it's a backup if the payment server is down, and it records refunds.</p>
      <pre class="code"><code>${paymentSnippet(i.baseUrl)}</code></pre>
    </section>

    <section class="card">
      <div class="card-head"><h2>Model pricing</h2><span class="small muted">USD per million tokens. Used to cost every call when it's recorded.</span></div>
      <form id="pricing">
        <div class="table-wrap"><table class="table compact pricing">
          <thead><tr><th>Model</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cache read</th><th class="r">Cache write (5m)</th><th></th></tr></thead>
          <tbody>${models.map(m => html`<tr data-model="${m}">
            <td><code>${m}</code></td>
            ${['input', 'output', 'cacheRead', 'cacheWrite'].map(f => html`<td class="r"><input name="${m}.${f}" value="${s.pricing[m][f]}" inputmode="decimal" aria-label="${m} ${f}"></td>`)}
            <td class="r"><button type="button" class="linky danger" data-drop-model="${m}">Remove</button></td>
          </tr>`)}</tbody>
        </table></div>
        <div class="form-actions">
          <button class="btn" type="submit">Save pricing</button>
          <button class="btn ghost" type="button" data-act="add-model">Add model</button>
          <button class="linky" type="button" data-act="reset-pricing">Reset to defaults</button>
        </div>
      </form>
      <p class="small muted">The AI proxy only accepts models listed here, so nothing runs unbilled. Changes apply to new calls; recorded costs stay as they were.</p>
    </section>

    <div class="cols">
      <section class="card col">
        <div class="card-head"><h2>Team</h2><button class="btn sm" data-act="add-user">Add person</button></div>
        <ul class="rows">${s.users.map(u => html`<li class="row-item">
          <span><strong>${u.name || u.email}</strong> <span class="muted small">${u.email}</span></span>
          <span class="small muted">since ${date(u.created_at)}</span>
          ${u.id === ctx.user.id ? html`<span class="small muted">You</span>` : html`<button class="linky danger" data-del-user="${u.id}">Remove</button>`}
        </li>`)}</ul>
      </section>
      <section class="card col">
        <div class="card-head"><h2>Your password</h2></div>
        <form id="password" class="stack">
          <label class="f"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
          <label class="f"><span>New password (10+ characters)</span><input type="password" name="next" autocomplete="new-password" minlength="10" required></label>
          <button class="btn" type="submit">Change password</button>
        </form>
      </section>
    </div>`);

  const root = ctx.root;
  const pricingForm = root.querySelector('#pricing');
  const readPricing = () => {
    const out = {};
    for (const [k, v] of new FormData(pricingForm)) {
      const [model, field] = [k.slice(0, k.lastIndexOf('.')), k.slice(k.lastIndexOf('.') + 1)];
      (out[model] ||= {})[field] = v;
    }
    return out;
  };
  const savePricing = async (pricing, msg = 'Pricing saved') => {
    try {
      await api('PUT', '/api/settings/pricing', { pricing });
      toast(msg);
      ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  };

  pricingForm.addEventListener('submit', e => { e.preventDefault(); savePricing(readPricing()); });
  on(root, 'click', '[data-drop-model]', async (e, el) => {
    const pricing = readPricing();
    delete pricing[el.dataset.dropModel];
    savePricing(pricing, 'Model removed');
  });
  on(root, 'click', '[data-copy]', (e, el) => copy(el.dataset.copy));
  on(root, 'click', '[data-revoke]', async (e, el) => {
    if (!(await confirmDialog('Revoke this key? Anything using it stops working immediately.', { confirmLabel: 'Revoke' }))) return;
    await api('DELETE', `/api/settings/api-keys/${el.dataset.revoke}`);
    ctx.refresh();
  });
  on(root, 'click', '[data-del-user]', async (e, el) => {
    if (!(await confirmDialog('Remove this person\'s access?', { confirmLabel: 'Remove' }))) return;
    await api('DELETE', `/api/settings/users/${el.dataset.delUser}`);
    ctx.refresh();
  });
  root.querySelector('#password').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('POST', '/api/settings/password', Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      toast('Password changed');
    } catch (err) { toast(err.message, 'err'); }
  });

  on(root, 'click', '[data-act]', async (e, el) => {
    const act = el.dataset.act;
    if (act === 'new-key') {
      const key = await modal({
        title: 'New API key',
        body: html`<label class="f"><span>What will use it?</span><input name="name" placeholder="Site Builder" required></label>`,
        submitLabel: 'Create key',
        onSubmit: v => api('POST', '/api/settings/api-keys', v),
      });
      if (!key) return;
      await modal({
        title: 'Copy your key now',
        body: html`<p>This is the only time the full key is shown.</p>
          <div class="copyline"><code>${key.key}</code><button type="button" class="btn ghost sm" data-copy="${key.key}">Copy</button></div>`,
        submitLabel: 'Done',
        onSubmit: () => true,
      });
      ctx.refresh();
    } else if (act === 'add-model') {
      const added = await modal({
        title: 'Add model pricing',
        body: html`<label class="f"><span>Model id</span><input name="model" placeholder="claude-…" required></label>
          <div class="grid2">
            <label class="f"><span>Input $/MTok</span><input name="input" inputmode="decimal" required></label>
            <label class="f"><span>Output $/MTok</span><input name="output" inputmode="decimal" required></label>
            <label class="f"><span>Cache read $/MTok</span><input name="cacheRead" inputmode="decimal" value="0"></label>
            <label class="f"><span>Cache write $/MTok</span><input name="cacheWrite" inputmode="decimal" value="0"></label>
          </div>`,
        submitLabel: 'Add',
        onSubmit: async v => {
          const { model, ...p } = v;
          await api('PUT', '/api/settings/pricing', { pricing: { ...readPricing(), [model.trim()]: p } });
          return true;
        },
      });
      if (added) { toast('Model added'); ctx.refresh(); }
    } else if (act === 'reset-pricing') {
      if (!(await confirmDialog('Reset all model prices to the built-in defaults?', { confirmLabel: 'Reset' }))) return;
      await api('POST', '/api/settings/pricing/reset');
      ctx.refresh();
    } else if (act === 'add-user') {
      const user = await modal({
        title: 'Add person',
        body: html`<label class="f"><span>Name</span><input name="name"></label>
          <label class="f"><span>Email</span><input name="email" type="email" required></label>
          <label class="f"><span>Temporary password (10+ characters)</span><input name="password" type="text" minlength="10" required></label>`,
        submitLabel: 'Add',
        onSubmit: v => api('POST', '/api/settings/users', v),
      });
      if (user) { toast('Person added'); ctx.refresh(); }
    }
  });
}
