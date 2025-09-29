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