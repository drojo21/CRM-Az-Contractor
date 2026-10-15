# AZ Contractor Pro CRM

The client CRM for contractors whose websites we build. One place to see every contractor,
where they are in the pipeline, the site we published for them, the leads that site sends,
what they've paid, and how many Claude tokens we've spent on them.

It plugs into the two existing pieces:

| Repo | What it does | How the CRM connects |
|---|---|---|
| [`acp-backend-tucson`](https://github.com/drojo21/acp-backend-tucson) | Site Builder (`builder.html`): work order → Claude copy → single-file site → Netlify | Builder syncs each contractor + published site; copy generation goes through the CRM's AI proxy so tokens are billed per contractor |
| [`Az-Contractor-Pro`](https://github.com/drojo21/Az-Contractor-Pro) | Marketing site + `payment-server.js` (Stripe Checkout for the $250 / $120 / $370 packages) | The payment server reports every order; optionally a Stripe webhook goes straight to the CRM too |
| Every generated contractor site | Quote form posts to `sheet` (the builder's "Lead capture URL") | Point it at the contractor's CRM lead URL; leads land in the CRM and get emailed to the contractor |

## What's in it

- **Contractors**: every field from the builder's work order (business, owner, trade, ROC #, license
  class, service area, services, customers, emergency/payment-plan flags) plus pipeline stage, follow-up
  date, notes/calls timeline. Search, filter by stage or trade, CSV export.
- **Pipeline**: Prospect → Demo site → Contacted → Paid → Live (and Lost). Moves forward automatically:
  publishing a site makes a prospect a Demo; a payment makes them Paid; marking a site "claimed" makes them Live.
- **ROC roster import**: drop the same new-licenses CSV the builder's Roster tab uses. New license numbers
  become prospects, existing ones only get blanks filled in. Same fuzzy header mapping and trade inference as the builder.
- **Websites**: Netlify site id, live URL, claim link, deploy count, last publish.
- **Leads**: each contractor gets a private lead capture URL. The quote form on their site posts to it and
  the lead shows up in the inbox, gets emailed to the contractor (BCC you), and can also be forwarded to their
  existing Apps Script sheet. Statuses: new, contacted, won, lost, spam.
- **Orders**: packages and prices from the marketing site; from the payment server, Stripe webhooks (including refunds), or recorded by hand.
- **Token usage**: every Claude call billed to a contractor with model, input/output/cache tokens and cost.
  Monthly chart, per-contractor cost against what they've paid, optional monthly token budget that the
  AI proxy enforces. Model prices are editable in Settings.

## Quick start

Needs Node 22.13+ (uses the built-in `node:sqlite`, so there's no native build step).

```bash
npm install
cp .env.example .env        # set ADMIN_EMAIL and ADMIN_PASSWORD at minimum
npm run seed                # optional: demo contractors, leads, an order and some usage
npm start                   # http://localhost:3100
```

The first start creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. More people can be added in
Settings → Team, or with `npm run create-user -- someone@example.com 'a long password' "Their Name"`.

```bash
npm test                    # 30 tests: unit, admin API, integrations, public hooks
npm run dev                 # restart on file changes
```

## Hooking everything up

Settings in the CRM shows every URL below with your real domain filled in, copy buttons, and the
exact code to paste. In short:

### 1. Lead capture from contractor sites

Each contractor page shows a URL like `https://crm.example.com/hooks/leads/<key>`. Put it in the
builder's **Lead capture URL** field and rebuild/publish. The generated quote form already posts JSON
with `fetch(..., { mode: 'no-cors' })`; the CRM accepts that `text/plain` body as-is (as well as JSON
and form posts). No change to the site template is needed.

- Leads are emailed to the contractor when SMTP is configured (same `SMTP_*` settings as `payment-server.js`).
- "Also forward leads to" re-posts each lead to an existing Apps Script URL in the same shape the site
  sends, so sheets set up before the CRM keep working.
- "Send test lead" runs the real notification path. "New URL" rotates the key if a form gets spammed.
- `POST /hooks/leads` (no key) also works and matches on the `business` field the site sends.

### 2. Site Builder (`builder.html`)

The hookup is built into `builder.html`. Create an API key in Settings, then fill in the builder's
section **6 · CRM** with this CRM's URL and the key (they're remembered in that browser only). From then on:

1. Before each build (single or roster batch) the contractor is created/updated and the quote form is
   pointed at their CRM lead URL. A CRM URL left over from the previous contractor is replaced; a custom
   Apps Script URL is kept.
2. Copy generation calls `POST /api/integrations/ai/messages` instead of `api.anthropic.com`, with
   `acp: { roc, businessName, purpose }`. Same request and response shape as the Messages API, so the
   Claude key stays on the server and every token is attributed.
3. After publishing, the Netlify site id, URL and claim link are recorded, and a **CRM** link appears
   next to the live URL.

Leave the CRM URL blank and the builder works exactly as before.

### 3. Payment server and Stripe

`payment-server.js` takes payment with Stripe Checkout. Set `CRM_URL` and `CRM_KEY` (an API key from
Settings) in its `.env` and it reports each order when checkout starts and again when Stripe confirms
the payment.

Optionally, also add a Stripe webhook endpoint for `https://crm.example.com/hooks/stripe` with
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired` and `charge.refunded`, and put its
signing secret in `STRIPE_WEBHOOK_SECRET`. The CRM verifies the signature, reads the business name and
package from the session metadata the payment server attaches (no Stripe API key needed), and records
refunds. Both paths converge on one order, matched by order id, payment intent or checkout session.
Duplicate and out-of-order events never undo a paid order, and a refund is final.

## API

Integration endpoints take an API key in the `x-builder-key` header (or `x-api-key` / `Authorization: Bearer`).
They allow CORS from any origin since the builder runs in a browser tab; auth is the key, never cookies.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/hooks/leads/:key` | none (key in URL) | Quote form submissions from a contractor site |
| POST | `/hooks/leads` | none | Same, matched by business name |
| POST | `/hooks/stripe` | Stripe signature | Stripe Checkout and refund webhooks |
| GET | `/api/integrations/ping` | API key | Check a key works |
| POST | `/api/integrations/builder/sync` | API key | `{ contractor, site?, usage? }`: upsert contractor, record deploy; returns `leadCaptureUrl` |
| POST | `/api/integrations/ai/messages` | API key | Claude Messages API proxy (non-streaming); attribution via `acp` or `x-contractor-roc` / `x-contractor-id` |
| POST | `/api/integrations/usage` | API key | Report usage for calls made elsewhere: one event or `{ events: [...] }` |
| POST | `/api/integrations/orders` | API key | Order from the payment server (`orderId, businessName, …, packageType, amount, status, checkoutSessionId, paymentId`) |
| GET | `/health` | none | Health check |

Everything under `/api/*` other than these is the CRM UI's own API (session cookie + `X-Requested-With: acp-crm`).

**Contractor matching.** Incoming data is matched by CRM id, then ROC number, then Netlify site id, then
business name, then email. Two records with different ROC numbers are never merged, even with the same DBA name.

## Token usage and cost

Each usage row stores input, output, cache-read and cache-write tokens, and its cost at the price on file
when it was recorded (changing prices later doesn't rewrite history). Prices are USD per million tokens,
which is the same as micro-dollars per token, so costs are exact integers. Cache writes use the 5-minute
rate, or 2x input for 1-hour writes when the API reports them.

The AI proxy:
- only accepts models that have a price on file, so nothing runs unbilled
- caps `max_tokens` at `AI_MAX_TOKENS`
- refuses calls (429) for a contractor who has hit their monthly token budget
- de-duplicates by Claude message id
- needs `ANTHROPIC_API_KEY`; without it, usage reports still work

## Deploying

The CRM is a normal Node server with a SQLite file, so it needs a host with a persistent disk
(the same kind of host `payment-server.js` needs). Netlify Functions won't keep the database.

- **Render / Railway / Fly.io**: deploy the repo (or the Dockerfile), attach a volume, set
  `DATABASE_PATH` to a file on it (e.g. `/data/crm.db`), set `BASE_URL` to the public https URL and
  `NODE_ENV=production`.
- **Docker**: `docker build -t acp-crm . && docker run -p 3100:3100 -v crm-data:/data --env-file .env acp-crm`
- Back up the database file (or the whole volume) on a schedule. SQLite runs in WAL mode; copy
  `crm.db` together with its `-wal` file, or use `sqlite3 crm.db ".backup backup.db"`.

`BASE_URL` matters: lead capture URLs and the Stripe webhook URL are built from it. If you move domains,
republish the sites with the new lead URLs.

## Security notes

- Passwords: scrypt. Sessions: random tokens stored hashed, `HttpOnly` + `SameSite=Lax` cookies
  (`Secure` when `BASE_URL` is https). Writes need a custom header, which blocks cross-site form posts.
- API keys are stored as SHA-256 hashes and shown once.
- Strict CSP on the UI (`script-src 'self'`); all rendering escapes data, since lead fields come from
  public forms. CSV exports neutralize spreadsheet formulas.
- Public lead endpoints are rate limited per IP (20 per 10 minutes) and have a honeypot (`_gotcha`).
  Login is rate limited too. The limiter is in-memory, so it's per instance.
- Stripe webhooks are rejected unless the signing secret is set and the signature matches (stale timestamps too).

## Layout

```
server.js            entry point (loads .env, opens the DB, starts Express)
src/
  app.js             Express app: security headers, routing order, error handling
  db.js              node:sqlite wrapper + schema migrations
  contractors.js     field normalization (builder / order form / ROC shapes), matching, upsert, pipeline
  leads.js           lead parsing (no-cors text/plain) and storage
  usage.js           model pricing, cost calculation, usage summaries
  orders.js          packages, order upsert
  websites.js        deploy recording
  stripe.js          webhook signature check, checkout and refund events
  notify.js          lead emails and forwarding
  auth.js            passwords, sessions, API keys
  csv.js, trades.js  ROC CSV parsing and trade inference (ported from builder.html)
  routes/            hooks (public), integrations (API key), auth, contractors, admin
public/              the UI: plain ES modules, no build step
scripts/             seed data, create-user
test/                node:test suites
```
