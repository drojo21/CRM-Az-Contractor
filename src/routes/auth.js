'use strict';

const express = require('express');
const { HttpError } = require('../errors');
const { rateLimit } = require('../ratelimit');
const {
  COOKIE, parseCookies, sessionCookie, createSession, destroySession, sessionUser, verifyPassword,
} = require('../auth');

function authRouter({ db, config }) {
  const router = express.Router();
  const loginLimiter = rateLimit({ windowMs: 15 * 60e3, max: 10, message: 'Too many sign-in attempts. Try again in a few minutes.' });

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    const user = db.get('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
    // Verify against a dummy hash when the user doesn't exist so timing doesn't reveal valid emails
    const ok = await verifyPassword(String(password || ''), user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'Email or password is incorrect');
    const { token, maxAge } = createSession(db, config, user.id);
    res.set('Set-Cookie', sessionCookie(config, token, maxAge));
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  });

  router.post('/logout', (req, res) => {
    destroySession(db, parseCookies(req.headers.cookie)[COOKIE]);
    res.set('Set-Cookie', sessionCookie(config, '', 0));
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const user = sessionUser(db, parseCookies(req.headers.cookie)[COOKIE]);
    if (!user) throw new HttpError(401, 'Sign in required');
    res.json({ user });
  });

  return router;
}

// scrypt hash of a random string; only used to equalize timing for unknown emails
const DUMMY_HASH = 'scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$ZHVtbXlkdW1teWR1bW15ZHVtbXlkdW1teWR1bW15ZHVtbXlkdW1teWR1bW15ZHVtbXlkdW1teWR1bW15ZA==';

module.exports = { authRouter };
