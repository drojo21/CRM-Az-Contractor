'use strict';

const path = require('node:path');

const bool = (v, dflt = false) => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

function loadConfig(env = process.env) {
  const port = int(env.PORT, 3100);
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const production = env.NODE_ENV === 'production';

  return {
    port,
    baseUrl,
    production,
    databasePath: env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'crm.db'),
    cookieSecure: env.COOKIE_SECURE != null ? bool(env.COOKIE_SECURE) : baseUrl.startsWith('https://'),
    trustProxy: bool(env.TRUST_PROXY, production),
    sessionDays: int(env.SESSION_DAYS, 30),

    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',

    builderKey: env.BUILDER_KEY || '',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    aiMaxTokens: int(env.AI_MAX_TOKENS, 4096),

    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SECURE, int(env.SMTP_PORT, 587) === 465),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.SMTP_FROM || 'leads@azcontractorpro.com',
    },
    adminNotifyEmail: env.ADMIN_NOTIFY_EMAIL || env.ADMIN_EMAIL || '',

    stripe: {
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    },
  };
}

module.exports = { loadConfig };
