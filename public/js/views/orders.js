import { html, mount, api, on, options, num, money, date, toast, empty } from '../lib.js';

export async function render(ctx) {
  const { orders, totals } = await api('GET', '/api/orders');
  ctx.root.dataset.title = 'Orders';
  const pkg = id => ctx.meta.packages[id]?.label || id;

  mount(ctx.root, html`
    <header class="page-head">
      <div><p class="eyebrow">Website, social and complete packages</p><h1>Orders</h1></div>
    </header>
    <section class="tiles three">
      <div class="tile"><span class="tile-label">Paid</span><span class="tile-value">${money(totals.paid_cents)}</span></div>
      <div class="tile"><span class="tile-label">Pending checkout</span><span class="tile-value">${money(totals.pending_cents)}</span></div>
      <div class="tile"><span class="tile-label">Orders</span><span class="tile-value">${num(totals.count)}</span></div>
    </section>
    ${orders.length ? html`
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Contractor</th><th>Package</th><th class="r">Amount</th><th>Status</th><th>Reference</th></tr></thead>
      <tbody>${orders.map(o => html`
        <tr>
          <td class="tnum">${date(o.paid_at || o.created_at)}</td>
          <td>${o.contractor_id ? html`<a href="#/contractors/${o.contractor_id}">${o.business_name}</a>` : html`<span class="muted">Unknown buyer</span>`}</td>
          <td>${o.description || pkg(o.package_type)}</td>
          <td class="r tnum">${money(o.amount_cents)}</td>
          <td><select data-order="${o.id}" aria-label="Order status">${options(ctx.meta.orderStatuses, o.status)}</select></td>
          <td class="small muted">${o.reference || ''}${o.square_payment_id ? html`<div title="Square payment id">${o.square_payment_id}</div>` : ''}</td>
        </tr>`)}</tbody>
    </table></div>`
      : empty('No orders yet', 'Orders arrive from the order form (payment server), straight from Square webhooks, or when you record a payment on a contractor.')}
  `);

  on(ctx.root, 'change', '[data-order]', async (e, el) => {
    try {
      await api('PATCH', `/api/orders/${el.dataset.order}`, { status: el.value });
      toast(`Order ${el.value}`);
      ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}
