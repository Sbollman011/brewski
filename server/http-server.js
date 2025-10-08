const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const { checkRateLimit, setSecurityHeaders, allowedOrigins } = require('./lib/security');

// Exported function: startHttpServer(opts)
// opts:
//  - port, host (optional)
//  - mqttClient (optional) - a module exposing publish/getLatest APIs used by some handlers
function startHttpServer(opts = {}) {
  const wsPort = Number(process.env.QUICK_MQTT_WS_PORT || 8080);
  const hostBind = process.env.QUICK_MQTT_WS_HOST || '0.0.0.0';
  const port = opts.port || wsPort;
  const host = opts.host || hostBind;

  // we'll reuse much of the existing requestHandler logic from mttq-connector
  const requestHandler = (req, res) => {
    try {
      let url;
  // Prefer an explicit SERVER_FQDN when constructing a base URL for parsing.
  const SERVER_FQDN = process.env.SERVER_FQDN || 'api.brewingremote.com';
  try { url = new URL(req.url, `http://${(req && req.headers && req.headers.host) || SERVER_FQDN}`); } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_url', detail: String(err && err.message) }));
        return;
      }

      // Diagnostic: log incoming admin/public power-labels requests so we can
      // correlate browser 502s with server-side activity when tailing cloudflared.
      try {
        const originHeader = (req.headers && (req.headers.origin || req.headers['x-forwarded-host'] || req.headers.host)) || '-';
        if (url.pathname && (url.pathname.includes('/api/power-labels') || url.pathname.startsWith('/admin/api'))) {
          try { console.log(`[http] ${new Date().toISOString()} ${req.method} ${url.pathname} Origin:${originHeader} CL:${req.headers['content-length'] || 0}`); } catch (e) {}
        }
      } catch (e) {}

      const setSecurityHeadersLocal = () => setSecurityHeaders(req, res, server);

      // Quick health and info endpoints
          if (req.method === 'OPTIONS') {
            // Ensure preflight allows the methods the admin SPA will use (PUT/DELETE)
            // and returns Access-Control-Allow-Origin when the origin is permitted.
            setSecurityHeadersLocal();
            // If getAllowedOrigin helper exists, call it to allow echoing origin
            try {
              const { getAllowedOrigin } = require('./lib/security');
              const allowed = getAllowedOrigin(req);
              if (allowed) {
                res.setHeader('Access-Control-Allow-Origin', allowed);
                res.setHeader('Vary', 'Origin');
                res.setHeader('Access-Control-Allow-Credentials', 'true');
              }
            } catch (e) {}
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
            // Allow common headers used by the SPA (JSON body + Authorization header)
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
            res.setHeader('Access-Control-Max-Age', '600');
            res.writeHead(204);
            res.end();
            return;
          }

      if (url.pathname === '/health') {
        setSecurityHeadersLocal();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === '/api/latest' && req.method === 'GET') {
        setSecurityHeadersLocal();
        try {
          // Auth: Bearer JWT or bridge token
          const authHeader = (req.headers['authorization'] || '').toString();
          const parts = authHeader.split(' ');
          let token = null;
            if (parts.length === 2 && /^Bearer$/i.test(parts[0])) token = parts[1];
          if (!token) token = url.searchParams.get('token');
          const BRIDGE_TOKEN = process.env.DISABLE_BRIDGE_TOKEN === '1' ? null : (process.env.BRIDGE_TOKEN || null);
          let user = null;
          if (token) {
            if (BRIDGE_TOKEN && token === BRIDGE_TOKEN) {
              user = { id: 'bridge', customer_id: 1, is_admin: 1 };
            } else {
              try {
                const { verifyToken, findUserById } = require('./lib/auth');
                const claims = verifyToken(token);
                if (claims) {
                  const u = findUserById(claims.sub);
                  if (u) user = u;
                }
              } catch (e) {}
            }
          }
          if (!user) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
            return;
          }
          const customerId = Number(user.customer_id || 1);
          const Database = require('better-sqlite3');
          const dbPath = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, 'brewski.sqlite3');
          const db = new Database(dbPath);
          // Sensors may or may not have topic_key; we expose key plus last_value/last_ts/last_raw
          const rows = db.prepare('SELECT id, key, topic_key, type, unit, last_value, last_ts, last_raw FROM sensors WHERE customer_id = ? AND last_ts IS NOT NULL ORDER BY last_ts DESC LIMIT 1000').all(customerId);
          // Include customer context for frontend filtering
          const customerInfo = db.prepare('SELECT slug, name FROM customers WHERE id = ?').get(customerId);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ 
            ok: true, 
            sensors: rows,
            customer: customerInfo || { slug: 'default', name: 'Default Customer' }
          }));
          try { db.close(); } catch (e) {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'server_error', detail: e && e.message }));
        }
        return;
      }

      if (url.pathname === '/api/power-labels' && req.method === 'GET') {
        setSecurityHeadersLocal();
        try {
          // Auth: Bearer JWT or bridge token
          const authHeader = (req.headers['authorization'] || '').toString();
          const parts = authHeader.split(' ');
          let token = null;
          if (parts.length === 2 && /^Bearer$/i.test(parts[0])) token = parts[1];
          if (!token) token = url.searchParams.get('token');
          const BRIDGE_TOKEN = process.env.DISABLE_BRIDGE_TOKEN === '1' ? null : (process.env.BRIDGE_TOKEN || null);
          let user = null;
          if (token) {
            if (BRIDGE_TOKEN && token === BRIDGE_TOKEN) {
              user = { id: 'bridge', customer_id: 1, is_admin: 1 };
            } else {
              try {
                const { verifyToken, findUserById } = require('./lib/auth');
                const claims = verifyToken(token);
                if (claims) {
                  const u = findUserById(claims.sub);
                  if (u) user = u;
                }
              } catch (e) {}
            }
          }
          if (!user) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
            return;
          }
          const customerId = Number(user.customer_id || 1);
          const Database = require('better-sqlite3');
          const dbPath = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, 'brewski.sqlite3');
          const db = new Database(dbPath);
          const topic = url.searchParams.get('topic');
          let rows;
          if (topic) {
            rows = db.prepare('SELECT id, topic, power_key, label FROM power_labels WHERE customer_id = ? AND topic = ? ORDER BY topic, power_key').all(customerId, topic);
          } else {
            rows = db.prepare('SELECT id, topic, power_key, label FROM power_labels WHERE customer_id = ? ORDER BY topic, power_key').all(customerId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ 
            ok: true, 
            labels: rows
          }));
          try { db.close(); } catch (e) {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'server_error', detail: e && e.message }));
        }
        return;
      }

      if (url.pathname === '/info') {
        const BRIDGE_TOKEN = process.env.DISABLE_BRIDGE_TOKEN === '1' ? null : process.env.BRIDGE_TOKEN || null;
        const auth = (req.headers['authorization'] || '').split(' ')[1] || url.searchParams.get('token');
        setSecurityHeadersLocal();
        if (BRIDGE_TOKEN && auth === BRIDGE_TOKEN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ server: 'brewski', ok: true, debug: true }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ server: 'brewski', ok: true }));
        }
        return;
      }

      // Delegate admin API if present (ensure CORS/security headers first)
      if (url.pathname.startsWith('/admin/api')) {
        setSecurityHeadersLocal();
        try {
          const { handleAdminApi } = require('./lib/adminApi');
          const handled = handleAdminApi(req, res, url);
          if (handled) return; // handler already responded
        } catch (e) { /* fallthrough to static/404 */ }
      }

      // Simple static serving for built webapp
      try {
        // Resolve which web build directory to use (production export preferred)
        // Priority order:
        //  1. server/public (populated by deploy-web.sh)
        //  2. webapp/web-build (local dev export)
        //  3. fallback legacy (handled below by web-admin pages)
        const resolveWebBuildDir = () => {
          const prodDir = path.join(__dirname, 'public');
          if (fs.existsSync(path.join(prodDir, 'index.html'))) return prodDir;
          const devDir = path.join(__dirname, '..', 'webapp', 'web-build');
          if (fs.existsSync(path.join(devDir, 'index.html'))) return devDir;
          return null;
        };
        const resolvedWebBuildDir = resolveWebBuildDir();

        // admin UI: prefer serving the SPA web-build index if present so the
        // React app can handle the /admin route. If no web build exists,
        // fall back to the small server-side admin page in server/web-admin.
        if (url.pathname === '/admin' || url.pathname === '/admin/') {
          const webBuildDir = resolvedWebBuildDir || path.join(__dirname, '..', 'webapp', 'web-build');
          const indexPath = path.join(webBuildDir, 'index.html');
          // If a built SPA exists, require a valid token to serve the admin UI.
          // This prevents unauthenticated users from loading the admin SPA; instead
          // we return a 401 HTML page so the browser shows an unauthorized response.
          if (fs.existsSync(indexPath)) {
            try {
              // Look for Bearer token in Authorization header or ?token= query param
              const authHeader = (req.headers && (req.headers['authorization'] || '')) || '';
              const parts = authHeader.split(' ');
              let token = null;
              if (parts.length === 2 && /^Bearer$/i.test(parts[0])) token = parts[1];
              if (!token) token = url.searchParams && url.searchParams.get('token');

              // Allow a legacy bridge token via env
              const BRIDGE = process.env.DISABLE_BRIDGE_TOKEN === '1' ? null : (process.env.BRIDGE_TOKEN || null);
              let ok = false;
              if (BRIDGE && token === BRIDGE) ok = true;
              if (!ok && token) {
                try {
                  const { verifyToken } = require('./lib/auth');
                  const claims = verifyToken(token);
                  if (claims) ok = true;
                } catch (e) { /* invalid token */ }
              }

              if (!ok) {
                setSecurityHeadersLocal();
                res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
                res.end('<!doctype html><html><head><meta charset="utf-8"><title>401 Unauthorized</title></head><body><h1>401 Unauthorized</h1><p>Authentication required to access this resource.</p></body></html>');
                return;
              }

              // token valid — serve the SPA index
              // Further ensure the token corresponds to an admin user in the DB.
              try {
                const { findUserById } = require('./lib/auth');
                const claims = require('./lib/auth').verifyToken(token);
                let uid = claims && claims.sub;
                const u = uid ? findUserById(uid) : null;
                if (!u || Number(u.is_admin) !== 1) {
                  setSecurityHeadersLocal();
                  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
                  res.end('<!doctype html><html><head><meta charset="utf-8"><title>401 Unauthorized</title></head><body><h1>401 Unauthorized</h1><p>Admin access required.</p></body></html>');
                  return;
                }
              } catch (e) {
                setSecurityHeadersLocal();
                res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<!doctype html><html><head><meta charset="utf-8"><title>401 Unauthorized</title></head><body><h1>401 Unauthorized</h1></body></html>');
                return;
              }

              setSecurityHeadersLocal();
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache');
              const useNonce = process.env.CSP_ENABLE_NONCE === '1';
              if (useNonce) {
                try {
                  let html = fs.readFileSync(indexPath, 'utf8');
                  const nonce = (res.locals && res.locals.cspNonce) || '';
                  if (nonce) {
                    // Inject nonce into any inline <style id="expo-reset"> and placeholder <script nonce-slot>
                    html = html.replace('<style id="expo-reset"', `<style id=\"expo-reset\" nonce=\"${nonce}\"`);
                  }
                  res.end(html);
                  return;
                } catch (e) {
                  // Fallback to raw stream
                }
              }
              fs.createReadStream(indexPath).pipe(res);
              return;
            } catch (e) {
              // if anything goes wrong, fail closed with 401
              setSecurityHeadersLocal();
              res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<!doctype html><html><head><meta charset="utf-8"><title>401 Unauthorized</title></head><body><h1>401 Unauthorized</h1></body></html>');
              return;
            }
          }
          const adminPath = path.join(__dirname, 'web-admin', 'index.html');
          if (fs.existsSync(adminPath)) {
            setSecurityHeadersLocal();
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(adminPath).pipe(res);
            return;
          }
        }
        // Manager UI: similar to /admin but for manager users. Serve /manage
        if (url.pathname === '/manage' || url.pathname === '/manage/') {
          const webBuildDir = resolvedWebBuildDir || path.join(__dirname, '..', 'webapp', 'web-build');
          const indexPath = path.join(webBuildDir, 'index.html');
          if (fs.existsSync(indexPath)) {
            // For production we now allow the full SPA to handle /manage; token gating happens client-side.
            // (We keep legacy small page fallback below if no build exists.)
          }
          const managePath = path.join(__dirname, 'web-admin', 'manage.html');
          if (!fs.existsSync(indexPath) && fs.existsSync(managePath)) {
            // Require a valid token and that it maps to a manager or admin
            const authHeader = (req.headers && (req.headers['authorization'] || '')) || '';
            const parts = authHeader.split(' ');
            let token = null;
            if (parts.length === 2 && /^Bearer$/i.test(parts[0])) token = parts[1];
            if (!token) token = url.searchParams && url.searchParams.get('token');
            const BRIDGE = process.env.DISABLE_BRIDGE_TOKEN === '1' ? null : (process.env.BRIDGE_TOKEN || null);
            let ok = false;
            if (BRIDGE && token === BRIDGE) {
              // legacy bridge token — allow (bridge considered privileged)
              ok = true;
            }
            if (!ok && token) {
              try {
                const { verifyToken, findUserById } = require('./lib/auth');
                const claims = verifyToken(token);
                if (claims) {
                  const u = findUserById(claims.sub);
                  if (u && (Number(u.is_admin) === 1 || u.role === 'manager')) ok = true;
                }
              } catch (e) { /* invalid token */ }
            }
            if (!ok) {
              setSecurityHeadersLocal();
              res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
              res.end('<!doctype html><html><head><meta charset="utf-8"><title>401 Unauthorized</title></head><body><h1>401 Unauthorized</h1><p>Manager access required.</p></body></html>');
              return;
            }
            setSecurityHeadersLocal();
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            const useNonce = process.env.CSP_ENABLE_NONCE === '1';
            if (useNonce) {
              try {
                let html = fs.readFileSync(managePath, 'utf8');
                const nonce = (res.locals && res.locals.cspNonce) || '';
                if (nonce) html = html.replace('<style id="expo-reset"', `<style id=\"expo-reset\" nonce=\"${nonce}\"`);
                res.end(html);
                return;
              } catch (e) {}
            }
            fs.createReadStream(managePath).pipe(res);
            return;
          }
        }
        const webBuildDir = resolvedWebBuildDir || path.join(__dirname, '..', 'webapp', 'web-build');
        // assets
        if (url.pathname.startsWith('/assets/')) {
          const rel = decodeURIComponent(url.pathname.replace(/^\/assets\//, ''));
          // Assets directory inside chosen build dir
          const assetsRoot = path.join(webBuildDir, 'assets');
          const filePath = path.join(assetsRoot, rel);
          const resolved = path.resolve(filePath);
          if (!resolved.startsWith(path.resolve(assetsRoot))) { res.writeHead(403); res.end('forbidden'); return; }
          if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            setSecurityHeadersLocal();
            const ext = path.extname(resolved).toLowerCase();
            const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
            res.setHeader('Content-Type', mime);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            fs.createReadStream(resolved).pipe(res);
            return;
          }
        }

        const serveWebBuildRoot = () => {
          const indexPath = path.join(webBuildDir, 'index.html');
          if (url.pathname === '/' || url.pathname === '/index.html') {
            if (fs.existsSync(indexPath)) {
              setSecurityHeadersLocal();
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache');
              const useNonce = process.env.CSP_ENABLE_NONCE === '1';
              if (useNonce) {
                try {
                  let html = fs.readFileSync(indexPath, 'utf8');
                  const nonce = (res.locals && res.locals.cspNonce) || '';
                  if (nonce) html = html.replace('<style id="expo-reset"', `<style id=\"expo-reset\" nonce=\"${nonce}\"`);
                  res.end(html);
                  return true;
                } catch (e) {}
              }
              fs.createReadStream(indexPath).pipe(res);
              return true;
            }
          }
          if (url.pathname && url.pathname !== '/') {
            const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
            const filePath = path.join(webBuildDir, rel);
            const resolved = path.resolve(filePath);
            if (resolved.startsWith(path.resolve(webBuildDir)) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
              setSecurityHeadersLocal();
              const ext = path.extname(resolved).toLowerCase();
              const mime = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
              res.setHeader('Content-Type', mime);
              res.setHeader('Cache-Control', 'public, max-age=3600');
              fs.createReadStream(resolved).pipe(res);
              return true;
            }
            const serverPrefixes = ['/admin', '/admin/api', '/publish', '/get', '/push', '/thresholds', '/register-push', '/health', '/info'];
            if (serverPrefixes.some(p => url.pathname.startsWith(p))) return false;
            if (fs.existsSync(indexPath)) {
              setSecurityHeadersLocal();
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache');
              const useNonce = process.env.CSP_ENABLE_NONCE === '1';
              if (useNonce) {
                try {
                  let html = fs.readFileSync(indexPath, 'utf8');
                  const nonce = (res.locals && res.locals.cspNonce) || '';
                  if (nonce) html = html.replace('<style id="expo-reset"', `<style id=\"expo-reset\" nonce=\"${nonce}\"`);
                  res.end(html);
                  return true;
                } catch (e) {}
              }
              fs.createReadStream(indexPath).pipe(res);
              return true;
            }
          }
          return false;
        };
        if (serveWebBuildRoot()) return;
      } catch (e) { /* ignore static serving errors */ }

      // 404 fallback
      setSecurityHeadersLocal();
      res.writeHead(404);
      res.end();
    } catch (err) {
      try { console.error('http-server requestHandler error', err && err.stack ? err.stack : err); } catch (e) {}
      try { if (res && !res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('server error'); } } catch (e) {}
    }
  };

  // Create HTTP or HTTPS server depending on availability of cert/key files or env vars
  const certPath = process.env.QUICK_MQTT_CERT || path.join(__dirname, 'cert.pem');
  const keyPath = process.env.QUICK_MQTT_KEY || path.join(__dirname, 'key.pem');
  let server;
  const wantHttps = certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath);
  if (wantHttps) {
    try {
      const certData = fs.readFileSync(certPath);
      const keyData = fs.readFileSync(keyPath);
      if (!certData.length || !keyData.length) throw new Error('empty cert or key file');
      server = https.createServer({ cert: certData, key: keyData }, requestHandler);
      server._isHttps = true;
      console.log('http-server: starting HTTPS server using cert/key');
    } catch (e) {
      console.error('http-server: failed to start HTTPS server (will fallback to HTTP):', e && e.message ? e.message : e);
      server = http.createServer(requestHandler);
      server._isHttps = false;
    }
  } else {
    if (!wantHttps) console.log('http-server: cert/key not found, using plain HTTP');
    server = http.createServer(requestHandler);
    server._isHttps = false;
  }

  server.on('error', err => console.error('http-server error:', err && err.message ? err.message : err));

  // Increase keep-alive and headers timeouts to be more forgiving for reverse proxies
  try {
    // Increase defaults to be more forgiving for reverse proxies (cloudflared)
    // 120s keep-alive, headers timeout slightly larger than keepAlive
    server.keepAliveTimeout = Number(process.env.SERVER_KEEPALIVE_MS || 120 * 1000);
    server.headersTimeout = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || 125 * 1000);
  } catch (e) { console.warn('Unable to set server timeouts', e && e.message); }

  server.listen(port, host, () => console.log('http-server listening on', host + ':' + port, server._isHttps ? '(HTTPS)' : '(HTTP)', 'SERVER_FQDN=' + (process.env.SERVER_FQDN || 'api.brewingremote.com')));

  return { server, port, host };
}

module.exports = { startHttpServer };
