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
      try { url = new URL(req.url, `http://${(req && req.headers && req.headers.host) || 'localhost'}`); } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_url', detail: String(err && err.message) }));
        return;
      }

      const setSecurityHeadersLocal = () => setSecurityHeaders(req, res, server);

      // Quick health and info endpoints
      if (req.method === 'OPTIONS') {
        setSecurityHeadersLocal();
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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
        const webBuildDir = path.join(__dirname, '..', 'webapp', 'web-build');
        // assets
        if (url.pathname.startsWith('/assets/')) {
          const rel = decodeURIComponent(url.pathname.replace(/^\/assets\//, ''));
          const filePath = path.join(path.join(__dirname, '..', 'webapp', 'assets'), rel);
          const resolved = path.resolve(filePath);
          if (!resolved.startsWith(path.resolve(path.join(__dirname, '..', 'webapp', 'assets')))) { res.writeHead(403); res.end('forbidden'); return; }
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

  server.listen(port, host, () => console.log('http-server listening on', host + ':' + port, server._isHttps ? '(HTTPS)' : '(HTTP)'));

  return { server, port, host };
}

module.exports = { startHttpServer };
