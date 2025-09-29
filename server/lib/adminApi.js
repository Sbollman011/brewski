const fs = require('fs');
const { createUser, findUserByUsername, verifyPassword, signToken, verifyToken } = require('./auth');

function parseBodyJson(req, res, cb) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try { cb(null, JSON.parse(body || '{}')); } catch (e) { res.writeHead(400); res.end('bad json'); }
  });
  req.on('error', err => cb(err));
}

function effectiveBridgeToken() {
  if (process.env.DISABLE_BRIDGE_TOKEN === '1') return null;
  return process.env.BRIDGE_TOKEN || null;
}

function extractBearerToken(req, url) {
  const authHeader = (req.headers && (req.headers['authorization'] || '')) || '';
  const parts = authHeader.split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1];
  // fallback to query param
  try { return url.searchParams && url.searchParams.get('token'); } catch(e) { return null; }
}

function handleAdminApi(req, res, url) {
  // url is a URL instance
  try {
    if (url.pathname === '/admin/api/register' && req.method === 'POST') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(500); res.end('server error'); return; }
        if (!obj.username || !obj.password) { res.writeHead(400); res.end('username,password required'); return; }
        const existing = findUserByUsername(obj.username);
        if (existing) { res.writeHead(409); res.end('username exists'); return; }
        const u = createUser(obj.username, obj.password);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: { id: u.id, username: u.username } }));
      });
      return true;
    }

    if (url.pathname === '/admin/api/login' && req.method === 'POST') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(500); res.end('server error'); return; }
        if (!obj.username || !obj.password) { res.writeHead(400); res.end('username,password required'); return; }
        const user = findUserByUsername(obj.username);
        if (!user || !verifyPassword(user, obj.password)) { res.writeHead(401); res.end('invalid'); return; }
        const token = signToken({ sub: user.id, username: user.username });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token }));
      });
      return true;
    }

    // Forgot password: POST { email }
    if (url.pathname === '/admin/api/forgot' && req.method === 'POST') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(400); res.end('bad json'); return; }
        const email = (obj && obj.email) ? String(obj.email).trim() : '';
        if (!email) { res.writeHead(400); res.end('email required'); return; }
        const { findUserByEmail, signToken } = require('./auth');
        const user = findUserByEmail(email);
        // For privacy, always return 200 even if email not found. If found,
        // issue a short-lived reset token (15m) and log it (replace with
        // email delivery in production).
        if (user) {
          const token = signToken({ sub: user.id, username: user.username, purpose: 'reset' }, { expiresIn: '15m' });
          // Attempt to send email; in environments without sendmail this will
          // log the token to the server logs for operators to copy to the user.
          try {
            const { sendResetEmail } = require('./mailer');
            const ok = sendResetEmail(user.email || email, token);
            if (!ok) console.log('[password-reset] token for', email, '->', token);
          } catch (e) {
            console.log('[password-reset] token for', email, '->', token);
          }

          // Also append the token to a local debug log so operators can reliably
          // retrieve issued tokens even if stdout/stderr aren't captured.
          try {
            const logPath = process.env.RESET_LOG_PATH || '/tmp/brewski-reset.log';
            const line = `${new Date().toISOString()} ${String(email)} ${String(token)}\n`;
            fs.appendFileSync(logPath, line, { encoding: 'utf8' });
            console.log('[password-reset] appended token to', logPath);
          } catch (e) {
            console.error('[password-reset] failed to write token log', e && e.stack ? e.stack : e);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return true;
    }

    // Reset password: POST { token, newPassword }
    if (url.pathname === '/admin/api/reset' && req.method === 'POST') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(400); res.end('bad json'); return; }
        const token = (obj && obj.token) ? String(obj.token) : '';
        const newPassword = (obj && obj.newPassword) ? String(obj.newPassword) : '';
        if (!token || !newPassword) { res.writeHead(400); res.end('token and newPassword required'); return; }
        const { verifyToken, updateUserPasswordById } = require('./auth');
        const claims = verifyToken(token);
        if (!claims || claims.purpose !== 'reset') { res.writeHead(400); res.end('invalid or expired token'); return; }
        const ok = updateUserPasswordById(claims.sub, newPassword);
        if (!ok) { res.writeHead(500); res.end('could not update password'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      });
      return true;
    }

    // For other /admin/api/* endpoints, enforce JWT auth for sensitive operations.
    // Register and login endpoints above remain public.
    const sensitivePaths = ['/admin/api/thresholds/update', '/admin/api/push/direct', '/admin/api/publish', '/admin/api/register-push', '/admin/api/push/test'];
    // If request matches one of the sensitive paths or any other admin API, require a valid JWT.
    const needsAuth = url.pathname.startsWith('/admin/api/') && url.pathname !== '/admin/api/register' && url.pathname !== '/admin/api/login';
    if (needsAuth) {
      const token = extractBearerToken(req, url);
      // allow legacy BRIDGE_TOKEN for compatibility (treat it as equivalent to a JWT)
      if (!token) {
        // no token provided
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_token' }));
        return true;
      }
      // If token equals the BRIDGE_TOKEN env var, accept it as privileged
      const BRIDGE = effectiveBridgeToken();
      if (BRIDGE && token === BRIDGE) {
        req.user = { id: 'bridge', username: 'bridge-token' };
        return false; // allow handling to continue in main server
      }
      const claims = verifyToken(token);
      if (!claims) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return true;
      }
      req.user = { id: claims.sub, username: claims.username };
    }

    return false; // not handled here
  } catch (e) {
    res.writeHead(500); res.end('server error'); return true;
  }
}

module.exports = { handleAdminApi };