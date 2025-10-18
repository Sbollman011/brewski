const path = require('path');

// CORS whitelist
// Default allowed origins; can be overridden via APP_ORIGINS. Note: localhost
// is only allowed when ALLOW_LOCALHOST_ORIGINS=1 (dev only).
// If SERVER_FQDN is configured prefer that for default origins.
const defaultFqdn = process.env.SERVER_FQDN || 'api.brewingremote.com';
const defaultOrigins = [`https://${defaultFqdn}`, `https://${defaultFqdn.replace(/^api\./, '')}`];
const allowedOrigins = (process.env.APP_ORIGINS || defaultOrigins.join(','))
  .split(',').map(s => s.trim()).filter(Boolean);

// Optional: enable a relaxed CORS mode for debugging. When RELAX_CORS=1 the
// origin will echo the requesting Origin and allow credentials/headers so the
// browser can perform cross-origin requests during troubleshooting. THIS
// SHOULD ONLY BE USED TEMPORARILY IN DEBUG/DEV. It is intentionally opt-in.
const RELAX_CORS = !!(process.env.RELAX_CORS && process.env.RELAX_CORS !== '0');

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

function getAllowedOrigin(req) {
  const origin = req && req.headers && req.headers.origin;
  if (!origin) return null;
  if (RELAX_CORS) return origin;
  try {
    const parsed = new URL(origin);
    const host = (parsed.hostname || '').toLowerCase();
    if (allowedOrigins.includes(origin)) return origin;
    if (host === 'brewingremote.com' || host.endsWith('.brewingremote.com')) return origin;
    const ALLOW_LOCALHOST = process.env.ALLOW_LOCALHOST_ORIGINS === '1';
    if (ALLOW_LOCALHOST && (host === 'localhost' || host === '127.0.0.1')) return origin;
  } catch (e) {
    if (allowedOrigins.includes(origin)) return origin;
  }
  // Not allowed
  if (process.env.DEBUG_CORS === '1') {
    try { console.warn('CORS: origin not allowed', origin); } catch (e) {}
  }
  return null;
}

function setSecurityHeaders(req, res, server) {
  // Defensive: only set headers if res is present and has setHeader
  if (!res || typeof res.setHeader !== 'function') return;
  try {
    const origin = req && req.headers && req.headers.origin;
    if (origin) {
      if (RELAX_CORS) {
        // Opt-in debugging mode: echo origin and allow credentials so browsers
        // can complete preflight checks. Don't enable this in production long-term.
        try {
          if (typeof console !== 'undefined' && console.warn) console.warn('RELAX_CORS enabled: relaxing CORS for origin', origin);
        } catch (e) {}
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      } else {
        const allowed = getAllowedOrigin(req);
        if (allowed) {
          res.setHeader('Access-Control-Allow-Origin', allowed);
          res.setHeader('Vary', 'Origin');
          // Allow cookies / Authorization headers when needed (JWT / legacy tokens)
          res.setHeader('Access-Control-Allow-Credentials', 'true');
          // Allow common headers used by the SPA
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With');
        }
      }
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try { res.setHeader('Permissions-Policy', "geolocation=()"); } catch (e) {}

    // Allow scripts and styles from the origin (self) so the SPA bundle can be
    // loaded. Keep default-src 'none' to minimize other risks but permit
    // script-src and style-src from 'self'. We keep connect-src restricted to
    // secure endpoints and wss for WebSocket usage.
    // Allow the Cloudflare Insights beacon host explicitly so that the analytics
    // script can load while keeping the rest of script-src locked to 'self'.
    const csp = [
      "default-src 'none'",
      "script-src 'self'",
      "script-src-elem 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' wss: https:",
      "img-src 'self' data: https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
    if (server && server._isHttps) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
  } catch (e) {
    try { console.error('setSecurityHeaders error', e && e.message); } catch (e) {}
  }
}

module.exports = { allowedOrigins, checkRateLimit, setSecurityHeaders, getAllowedOrigin };
