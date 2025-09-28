const path = require('path');

// CORS whitelist
const allowedOrigins = (process.env.APP_ORIGINS || 'https://appli.railbrewouse.com,https://localhost:19006')
  .split(',').map(s => s.trim()).filter(Boolean);

// Rate limiter config
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const buckets = new Map(); // key -> { count, resetAt }

function rateLimitKey(req) {
  const ip = req.socket && (req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown');
  return `${ip}:${req.method}:${req.url.split('?')[0]}`;
}

function checkRateLimit(req) {
  const key = rateLimitKey(req);
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  if (entry.count >= RATE_LIMIT_MAX) return { ok: false, retryAfterMs: entry.resetAt - now };
  entry.count += 1;
  return { ok: true, remaining: RATE_LIMIT_MAX - entry.count };
}

function setSecurityHeaders(req, res, server) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try { res.setHeader('Permissions-Policy', "geolocation=()"); } catch (e) {}
  res.setHeader('Content-Security-Policy', "default-src 'none'; connect-src 'self' wss: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self';");
  if (server && server._isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
}

module.exports = { allowedOrigins, checkRateLimit, setSecurityHeaders };
