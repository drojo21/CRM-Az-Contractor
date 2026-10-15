'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError } = require('./errors');
const { requireUser } = require('./auth');
const { createNotifier } = require('./notify');
const { hooksRouter } = require('./routes/hooks');
const { integrationsRouter } = require('./routes/integrations');
const { authRouter } = require('./routes/auth');
const { contractorsRouter } = require('./routes/contractors');
const { adminRouter } = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/**
 * deps (all optional, for tests): anthropic (Claude client), mailTransport (nodemailer-like),
 * fetchImpl (outbound fetch for lead forwarding), log.
 */
function createApp({ db, config, anthropic, mailTransport, fetchImpl = fetch, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  const notifier = createNotifier({ db, config, transport: mailTransport, fetchImpl, log });
  const deps = { db, config, notifier, anthropic, fetchImpl, log };

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', CSP);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // Public inbound endpoints parse their own bodies (text/plain leads, raw Stripe payloads)
  app.use('/hooks', hooksRouter(deps));

  app.use('/api', express.json({ limit: '5mb' }));
  app.use('/api/integrations', integrationsRouter(deps));
  app.use('/api/auth', authRouter(deps));
  app.use('/api', requireUser(db));
  app.use('/api/contractors', contractorsRouter(deps));
  app.use('/api', adminRouter(deps));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'No such endpoint')));

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: config.production ? '1h' : 0 }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/hooks')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message;
    if (err.type === 'entity.parse.failed') { status = 400; message = 'Request body is not valid JSON'; }
    else if (err.type === 'entity.too.large') { status = 413; message = 'Request body is too large'; }
    else if (/UNIQUE constraint failed/.test(err.message || '')) { status = 409; message = 'That record already exists'; }
    else if (status >= 500) {
      log.error(err);
      message = 'Something went wrong on the server';
    }
    res.status(status).json({ error: message, details: err.details });
  });

  return app;
}

module.exports = { createApp };
