'use strict';

const { HttpError } = require('./errors');

/** Fixed-window, in-memory limiter. Fine for a single instance; swap for Redis if you scale out. */
function rateLimit({ windowMs, max, key = req => req.ip, message = 'Too many requests, slow down' }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, h] of hits) if (h.reset <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(k, h);
    }
    if (++h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return next(new HttpError(429, message));
    }
    next();
  };
}

module.exports = { rateLimit };
