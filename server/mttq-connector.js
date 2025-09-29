// quick-mqtt-connect.js
// Usage: node quick-mqtt-connect.js <connectionName> [--dry-run] [--connect]
// connectionName: 'INHHOUSE' or 'VMBEER'
// Notes:
// - Credentials are taken from the screenshots you provided. You can override any value with environment variables:
//   MQTT_INHHOUSE_USER, MQTT_INHHOUSE_PASS, MQTT_VMBEER_USER, MQTT_VMBEER_PASS
// - By default the script does a dry-run (prints config and topics). Use --connect to actually connect.
// - Assumption: the INHHOUSE screenshot didn't show the plaintext password, so the script uses the same
//   password as VMBEER ('Ilov3b33r') unless you provide MQTT_INHHOUSE_PASS in your environment to override.

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

// Global handlers to avoid process exit during development/edits.
process.on('uncaughtException', (err) => {
  try { console.error('uncaughtException:', err && err.stack ? err.stack : String(err)); } catch (e) {}
});
process.on('unhandledRejection', (reason) => {
  try { console.error('unhandledRejection:', reason && reason.stack ? reason.stack : String(reason)); } catch (e) {}
});

// Toggle detailed logging (set env DEBUG_BRIDGE=1 to enable)
const DEBUG = process.env.DEBUG_BRIDGE === '1';
// Safe debug logger (was previously a no-op due to missing console.log call)
const dlog = (...args) => { if (DEBUG) console.log(...args); };

// Connection order to try automatically. If one config fails the bridge will try the next.
const CONNECTION_ORDER = ['INHHOUSE', 'VMBEER'];
let currentConnIndex = 0;
let connectionName = CONNECTION_ORDER[currentConnIndex];
// default to connect immediately (no --dry-run)
const dryRun = false;
// Start the WebSocket bridge by default on 0.0.0.0:8080 unless overridden via env
let wsPort = process.env.QUICK_MQTT_WS_PORT ? parseInt(process.env.QUICK_MQTT_WS_PORT, 10) : 8080;
let wsHost = process.env.QUICK_MQTT_WS_HOST || '0.0.0.0';

// Topics used in the project (list all topics in the code as requested)
// Note: to discover everything available on the broker, we subscribe to '#' and '$SYS/#' below.
const topics = [
  'home/+/temperature',
  'home/+/humidity',
  'sensors/+/state',
  'actuators/+/set'
];

// Default configs taken from screenshots
const configs = {
  INHHOUSE: {
    host: '10.0.0.17',
    port: 1883,
    protocol: 'mqtt',
    username: process.env.MQTT_INHHOUSE_USER || 'billy',
    password: process.env.MQTT_INHHOUSE_PASS || 'Ilov3b33r' // assumption: use same password as VMBEER when not provided
  },
  VMBEER: {
    host: '65.76.132.84',
    port: 1883,
    protocol: 'mqtt',
    username: process.env.MQTT_VMBEER_USER || 'billy',
    password: process.env.MQTT_VMBEER_PASS || 'Ilov3b33r'
  }
};

let cfg = configs[connectionName];
let brokerUrl = `${cfg.protocol}://${cfg.host}:${cfg.port}`;

console.log('Selected connection:', connectionName, '->', brokerUrl);
if (DEBUG) {
  console.log('Username:', cfg.username);
  console.log('Topics in code:');
  topics.forEach(t => console.log(' -', t));
}

if (dryRun) {
  console.log('\nDry run mode - not connecting. Use --connect to actually connect.');
  process.exit(0);
}
// MQTT client will be created by tryConnect(); allow re-creating on fallback
let client = null;
// How long (ms) to wait for CONNACK before treating a connect attempt as failed
const CONNECT_TIMEOUT_MS = process.env.CONNECT_TIMEOUT_MS ? parseInt(process.env.CONNECT_TIMEOUT_MS, 10) : 3000;

function tryConnect() {
  connectionName = CONNECTION_ORDER[currentConnIndex];
  cfg = configs[connectionName];
  brokerUrl = `${cfg.protocol}://${cfg.host}:${cfg.port}`;
  console.log('Attempting MQTT connection:', connectionName, '->', brokerUrl);
  client = mqtt.connect(brokerUrl, { username: cfg.username, password: cfg.password, connectTimeout: CONNECT_TIMEOUT_MS, reconnectPeriod: 0 });

  // attach error handler to trigger fallback if needed
  // attach the regular handlers for connect/message to this client
  attachClientHandlers(client);

  client.on('error', err => {
    console.error(`MQTT connection error for ${connectionName}:`, err && err.message ? err.message : err);
    try { client.end(true); } catch (e) {}
    currentConnIndex += 1;
    if (currentConnIndex >= CONNECTION_ORDER.length) {
      console.error('All MQTT connection attempts failed. Exiting.');
      process.exit(1);
    }
    console.log('Falling back to next connection:', CONNECTION_ORDER[currentConnIndex]);
    // small delay before retrying to avoid tight loop
    setTimeout(() => tryConnect(), 1000);
  });
}

// Start initial MQTT connect attempt
tryConnect();

// We'll track seen topics and message counts
const seenTopics = new Map();
let totalMessages = 0;
// recent messages buffer + simple latest-value cache keyed by topic
const recentMessages = [];
const latestValue = new Map();
const latestRetain = new Map();
const PERSIST_FILE = path.join(__dirname, '.latest-targets.json');
// helper to persist current Target/Sensor latest values (used on normal message + synthetic seeding)
function persistLatest() {
  try {
    const toWrite = {};
    for (const [k,v] of latestValue.entries()) {
      if (/\/(Target|Sensor)$/i.test(k)) toWrite[k] = v;
    }
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(toWrite));
  } catch (e) { /* ignore persist error */ }
}

// Load persisted targets (and sensors) at startup
try {
  if (fs.existsSync(PERSIST_FILE)) {
    const raw = fs.readFileSync(PERSIST_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([k,v]) => { if (typeof v === 'string') latestValue.set(k, v); });
      dlog('Loaded persisted latest values:', Object.keys(obj).length);
    }
  }
} catch (e) { console.log('Persist load error', e.message); }
const MAX_RECENT = 200;

// WebSocket bridge (lazy require)
let wss = null;
let broadcast = () => {};
if (wsPort) {
    try {
    const WebSocket = require('ws');
    const http = require('http');
    const https = require('https');
    const hostBind = wsHost || '0.0.0.0';
    // security helpers (CORS, headers, rate-limiter)
    const { checkRateLimit, setSecurityHeaders } = require('./lib/security');

    // Helper: honor DISABLE_BRIDGE_TOKEN=1 to temporarily bypass all token gating
    function effectiveBridgeToken() {
      if (process.env.DISABLE_BRIDGE_TOKEN === '1') return null;
      return process.env.BRIDGE_TOKEN || null;
    }

    const requestHandler = (req, res) => {
      try {
        // Debug: log incoming requests for connectivity troubleshooting
        try {
          const remote = req && req.socket ? (req.socket.remoteAddress + ':' + (req.socket.remotePort||'')) : 'unknown';
          const ua = (req.headers && (req.headers['user-agent'] || '-'));
          const origin = (req.headers && (req.headers['origin'] || '-'));
          console.log('[http] incoming', req.method, req.url, 'from', remote, 'origin=', origin, 'ua=', ua);
        } catch (e) {}
        const url = new URL(req.url, `http://${(req && req.headers && req.headers.host) || 'localhost'}`);
  // Global HTTP auth enforcement: require a valid JWT (BREWSKI_JWT_SECRET)
        // or the legacy BRIDGE_TOKEN for any HTTP endpoint except:
        // - the websocket public upgrade path (handled by ws server) '/_ws'
        // - OPTIONS preflight requests
        // - the admin login endpoint '/admin/api/login' (so clients can obtain JWT)
        // If you want to permit registration, remove the restriction for '/admin/api/register'.
        try {
          const pathIsWsPublic = url.pathname === '/_ws' || url.pathname === '/ws';
          const allowLogin = url.pathname === '/admin/api/login' && req.method === 'POST';
          const allowRegister = url.pathname === '/admin/api/register' && req.method === 'POST';
          // Only enforce this global token gate for admin API routes. Keep
          // public pages (/, static assets, /portal) reachable without auth.
          if (url.pathname.startsWith('/admin/api/') && req.method !== 'OPTIONS' && !allowLogin && !allowRegister) {
            const BRIDGE_TOKEN = effectiveBridgeToken();
            const authHeader = (req.headers['authorization'] || '').toString();
            const parts = authHeader.split(' ');
            const maybeBearer = (parts.length === 2 && /^Bearer$/i.test(parts[0])) ? parts[1] : null;
            const token = maybeBearer || url.searchParams.get('token');
            if (!token) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'missing_token' }));
              return;
            }
            if (BRIDGE_TOKEN && token === BRIDGE_TOKEN) {
              req.user = { id: 'bridge', username: 'bridge-token' };
            } else {
              const { verifyToken } = require('./lib/auth');
              const claims = verifyToken(token);
              if (!claims) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_token' }));
                return;
              }
              req.user = { id: claims.sub, username: claims.username };
            }
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_error' }));
          return;
        }
        // ...existing request handling...
        const setSecurityHeadersLocal = () => setSecurityHeaders(req, res, server);

      // Quick debug endpoint to inspect request headers and remote info. This
      // is useful when testing from phones or external clients to confirm
      // whether the request reached the origin and what Cloudflare/edge sent.
      if (url.pathname === '/debug/headers') {
        try {
          const remote = req && req.socket ? { ip: req.socket.remoteAddress, port: req.socket.remotePort } : null;
          setSecurityHeadersLocal();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, remote, tls: !!(req.socket && req.socket.encrypted) }));
          return;
        } catch (e) {
          // fall through to error handling below
        }
      }

      // Proxy /portal requests to local dev server (Expo) on 8081 if present,
      // so we can expose the portal via the main HTTPS server without needing
      // a static build. This is best-effort: if the dev server is not up the
      // proxy will fail and we'll fall through to static-serving or 404.
      if (url.pathname.startsWith('/portal')) {
          // If this is an exact request for the portal index (/portal or /portal/)
          // prefer serving a static build (if present) rather than proxying to
          // the dev server. For all other /portal/* paths (assets, bundles) we
          // proxy to the local dev server.
          const proxiedPath = url.pathname.replace(/^\/portal/, '') || '/';
          if (proxiedPath === '/' || proxiedPath === '') {
            // fall through to static-serving code later in the handler
          } else {
          const httpProxy = require('http');
          const proxyOpts = {
            hostname: '127.0.0.1',
            port: 8081,
            path: proxiedPath + (url.search || ''),
            method: req.method,
            headers: Object.assign({}, req.headers, { host: '127.0.0.1:8081' }),
            timeout: 5000
          };

          const proxyReq = httpProxy.request(proxyOpts, proxyRes => {
            // forward response headers/status
            try {
              // Remove hop-by-hop headers that should not be proxied
              const headers = Object.assign({}, proxyRes.headers);
              ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade'].forEach(h => delete headers[h]);
              res.writeHead(proxyRes.statusCode || 502, headers);
            } catch (e) {}
            proxyRes.pipe(res, { end: true });
          });

          proxyReq.on('timeout', () => {
            console.error('[portal proxy] timeout contacting dev server');
            try { proxyReq.abort(); } catch (e) {}
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Bad Gateway: dev server did not respond');
            }
          });

          proxyReq.on('error', err => {
            console.error('[portal proxy] error contacting dev server:', err && err.message ? err.message : err);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Bad Gateway: cannot reach dev server');
            }
          });

          // Pipe request body to proxied server
          req.pipe(proxyReq);
          return;
          }
        }

      // Static web files handler (serves built web app from webapp/web-build)
      try {
        const webBuildDir = path.join(__dirname, '..', 'webapp', 'web-build');
        // Serve static assets located in webapp/assets under /assets/
        if (url.pathname.startsWith('/assets/')) {
          const rel = decodeURIComponent(url.pathname.replace(/^\/assets\//, ''));
          const filePath = path.join(path.join(__dirname, '..', 'webapp', 'assets'), rel);
          const resolved = path.resolve(filePath);
          if (!resolved.startsWith(path.resolve(path.join(__dirname, '..', 'webapp', 'assets')))) {
            res.writeHead(403); res.end('forbidden'); return true;
          }
          if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            setSecurityHeadersLocal();
            const ext = path.extname(resolved).toLowerCase();
            const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
            res.setHeader('Content-Type', mime);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            fs.createReadStream(resolved).pipe(res);
            return true;
          }
        }
        // support both legacy /web route and the requested /portal route
        // Serve web-build at root as the canonical SPA location. This allows
        // the portal to be accessible at `/` (no /portal prefix).
        const serveWebBuildRoot = () => {
          const indexPath = path.join(webBuildDir, 'index.html');
          // Serve index for exact root
          if (url.pathname === '/' || url.pathname === '/index.html') {
            if (fs.existsSync(indexPath)) {
              setSecurityHeadersLocal();
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(indexPath).pipe(res);
              return true;
            }
          }
          // Try to serve a static file from web-build matching the request path
          if (url.pathname && url.pathname !== '/') {
            const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
            const filePath = path.join(webBuildDir, rel);
            const resolved = path.resolve(filePath);
            if (resolved.startsWith(path.resolve(webBuildDir)) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
              setSecurityHeadersLocal();
              const ext = path.extname(resolved).toLowerCase();
              const mime = ext === '.html' ? 'text/html; charset=utf-8' :
                ext === '.js' ? 'application/javascript; charset=utf-8' :
                ext === '.css' ? 'text/css; charset=utf-8' :
                ext === '.json' ? 'application/json; charset=utf-8' :
                ext === '.svg' ? 'image/svg+xml' :
                ext === '.png' ? 'image/png' :
                ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                ext === '.ico' ? 'image/x-icon' : 'application/octet-stream';
              res.setHeader('Content-Type', mime);
              res.setHeader('Cache-Control', 'public, max-age=3600');
              fs.createReadStream(resolved).pipe(res);
              return true;
            }
            // Do not fallback to index.html for server/API routes. This
            // prevents the SPA from swallowing endpoints like /admin/api,
            // /publish, /get, /push, /thresholds, etc. Return false so the
            // request can be handled by server-side handlers below.
            const serverPrefixes = ['/admin', '/admin/api', '/publish', '/get', '/push', '/thresholds', '/register-push', '/health', '/info'];
            if (serverPrefixes.some(p => url.pathname.startsWith(p))) {
              // allow later handlers to process these paths
              return false;
            }
            // fallback to index.html for SPA routing (non-server paths)
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
        // Continue to support dev proxy for /portal/* paths (keeps dev workflow intact)
        if (url.pathname.startsWith('/portal')) {
          // existing dev proxy logic falls through above
        }
      } catch (e) { /* ignore static serving errors and fall through to other handlers */ }

      // Redirect root requests to the Portal SPA so the Portal is the canonical
      // entry point. This avoids maintaining two different landing pages.
      if (url.pathname === '/' || url.pathname === '/index.html') {
        try {
          setSecurityHeadersLocal();
          // 302 redirect to the portal; the client will then load the SPA.
          res.writeHead(302, { Location: '/portal/#/login' });
          res.end();
          return;
        } catch (e) { /* if anything goes wrong, fall through */ }
      }

      // Apply rate limiting for writey or sensitive endpoints
      const sensitivePaths = ['/publish', '/push/direct', '/thresholds/update', '/register-push', '/push/test'];
      if (sensitivePaths.includes(url.pathname)) {
        const rl = checkRateLimit(req);
        if (!rl.ok) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil(rl.retryAfterMs/1000) });
          res.end(JSON.stringify({ error: 'rate_limited', retry_after_ms: rl.retryAfterMs }));
          return;
        }
        res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
      }

      // Enforce authentication for sensitive endpoints: require a valid JWT
      // (signed with BREWSKI_JWT_SECRET) or allow the legacy BRIDGE_TOKEN env var.
      if (sensitivePaths.includes(url.pathname)) {
        try {
          const BRIDGE_TOKEN = effectiveBridgeToken();
          const header = (req.headers['authorization'] || '').toString();
          const parts = header.split(' ');
          const maybeBearer = (parts.length === 2 && /^Bearer$/i.test(parts[0])) ? parts[1] : null;
          const token = maybeBearer || url.searchParams.get('token');
          if (!token) {
            // Respond with bare 401 and no JSON body so browser shows a standard 401
            res.writeHead(401);
            res.end();
            return;
          }
          // Accept BRIDGE_TOKEN as a legacy privilege token
          if (BRIDGE_TOKEN && token === BRIDGE_TOKEN) {
            req.user = { id: 'bridge', username: 'bridge-token' };
          } else {
            const { verifyToken } = require('./lib/auth');
            const claims = verifyToken(token);
            if (!claims) {
              // invalid token -> bare 401
              res.writeHead(401);
              res.end();
              return;
            }
            req.user = { id: claims.sub, username: claims.username };
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_error' }));
          return;
        }
      }

      // Allow preflight CORS requests
      if (req.method === 'OPTIONS') {
        setSecurityHeadersLocal();
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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
        // Do not expose internal broker connection details to unauthenticated callers.
        // Only reveal sensitive fields when a BRIDGE_TOKEN is configured and provided by the caller.
    const BRIDGE_TOKEN = effectiveBridgeToken();
        const auth = (req.headers['authorization'] || '').split(' ')[1] || url.searchParams.get('token');
        setSecurityHeadersLocal();
        if (BRIDGE_TOKEN && auth === BRIDGE_TOKEN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ connectionName, brokerUrl, username: cfg.username }));
        } else {
          // Minimal non-sensitive info for public callers
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ server: 'brewski', ok: true }));
        }
        return;
      }
        // Delegate admin API to a smaller module
        if (url.pathname.startsWith('/admin/api')) {
          const { handleAdminApi } = require('./lib/adminApi');
          const handled = handleAdminApi(req, res, url);
          if (handled) return;
        }
      // list current threshold overrides (dynamic) and static patterns
      if (url.pathname === '/thresholds' && req.method === 'GET') {
        setSecurityHeadersLocal();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ overrides: thresholdOverrides, static: STATIC_THRESHOLDS.map(r => ({ regex: r.match.source, min: r.min, max: r.max, label: r.label })) }));
        return;
      }
      // update (create/replace) a threshold override for a base. POST { base, min, max, label? }
      if (url.pathname === '/thresholds/update' && req.method === 'POST') {
        let body='';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const obj = JSON.parse(body||'{}');
            const base = (obj.base||'').trim();
            const min = Number(obj.min); const max = Number(obj.max);
            if (!base || Number.isNaN(min) || Number.isNaN(max)) { res.writeHead(400); res.end('base,min,max required'); return; }
            thresholdOverrides[base] = { min, max, label: obj.label || base };
            saveThresholdOverrides();
            setSecurityHeadersLocal();
            res.writeHead(200, { 'Content-Type':'application/json' });
            res.end(JSON.stringify({ ok:true, base, min, max }));
          } catch(e){ res.writeHead(400); res.end('bad json'); }
        });
        return;
      }
      // manual test: POST { topic, value } to trigger threshold evaluation without publishing MQTT
      if (url.pathname === '/push/test' && req.method === 'POST') {
        let body='';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const obj = JSON.parse(body||'{}');
            const topic = obj.topic; const value = Number(obj.value);
            if (!topic || Number.isNaN(value)) { res.writeHead(400); res.end('topic,value required'); return; }
            checkThresholdAndMaybePush(topic, value);
            setSecurityHeadersLocal();
            res.writeHead(200,{ 'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true }));
          } catch(e){ res.writeHead(400); res.end('bad json'); }
        });
        return;
      }
      // direct push: POST { title, body }
      if (url.pathname === '/push/direct' && req.method === 'POST') {
        let body='';
        req.on('data', c=> body += c);
        req.on('end', () => {
          try {
            const obj = JSON.parse(body||'{}');
            if (!obj.title || !obj.body) { res.writeHead(400); res.end('title,body required'); return; }
            sendExpoPush({ title: obj.title, body: obj.body, data: obj.data||{} });
            setSecurityHeadersLocal();
            res.writeHead(200,{ 'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true }));
          } catch(e){ res.writeHead(400); res.end('bad json'); }
        });
        return;
      }
      // Simple HTTP publish endpoint (POST /publish)
      if (url.pathname === '/publish' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const obj = JSON.parse(body || '{}');
            const topic = obj.topic;
            const payload = (typeof obj.payload === 'string' || typeof obj.payload === 'number') ? String(obj.payload) : JSON.stringify(obj.payload || '');
            const retain = !!obj.retain;
            if (!topic) return res.writeHead(400) && res.end('topic required');
            // optional token auth for HTTP publish
            const BRIDGE_TOKEN = effectiveBridgeToken();
            // If a global JWT already authenticated the request (req.user), allow it.
            if (BRIDGE_TOKEN && !req.user) {
              const auth = (req.headers['authorization'] || '').split(' ')[1] || url.searchParams.get('token');
              if (auth !== BRIDGE_TOKEN) { res.writeHead(401); res.end('unauthorized'); return; }
            }
            client.publish(topic, payload, { qos: 0, retain }, err => {
              if (err) { res.writeHead(500); res.end(String(err)); }
              else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, topic, payload, retain })); }
            });
          } catch (e) { res.writeHead(400); res.end('invalid json'); }
        });
        return;
      }
      // Simple HTTP get endpoint: /get?topic=...
      if (url.pathname === '/get' && req.method === 'GET') {
        const topic = url.searchParams.get('topic');
        if (!topic) { res.writeHead(400); res.end('topic required'); return; }
        // optional token auth for HTTP get
        const BRIDGE_TOKEN = effectiveBridgeToken();
        // Allow JWT-authenticated requests (req.user) even when BRIDGE_TOKEN is set.
        if (BRIDGE_TOKEN && !req.user) {
          const auth = (req.headers['authorization'] || '').split(' ')[1] || url.searchParams.get('token');
          if (auth !== BRIDGE_TOKEN) { res.writeHead(401); res.end('unauthorized'); return; }
        }
        let payload = null;
        if (latestValue.has(topic)) payload = latestValue.get(topic);
        else {
          const found = recentMessages.find(m => m.topic === topic);
          payload = found ? found.payload : null;
        }
        const retained = latestRetain.get(topic) || false;
        setSecurityHeadersLocal();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ topic, payload, retained }));
        return;
      }
      // add push token registration endpoint
      if (url.pathname === '/register-push' && req.method === 'POST') {
        let body='';
        req.on('data', c=> body += c);
        req.on('end', () => {
          try {
            const obj = JSON.parse(body||'{}');
            const tok = obj.token;
            if (typeof tok === 'string' && tok.startsWith('ExponentPushToken[')) {
              pushTokens.add(tok);
              savePushTokens();
              console.log('[push] registered token', tok, 'total=', pushTokens.size);
              setSecurityHeadersLocal();
              res.writeHead(200,{ 'Content-Type':'application/json'});
              res.end(JSON.stringify({ ok:true, tokens: pushTokens.size }));
            } else { res.writeHead(400); res.end('invalid token'); }
          } catch(e){ res.writeHead(400); res.end('bad json'); }
        });
        return;
      }
      // 404 fallback
      setSecurityHeaders(req, res, server);
      res.writeHead(404);
      res.end();
      } catch (err) {
        try { console.error('requestHandler error', err && err.stack ? err.stack : err); } catch (e) {}
        try { if (res && !res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('server error'); } } catch (e) {}
      }
    };

    // Decide between HTTP and HTTPS based on availability of cert/key files or env vars
    const certPath = process.env.QUICK_MQTT_CERT || path.join(__dirname, 'cert.pem');
    const keyPath = process.env.QUICK_MQTT_KEY || path.join(__dirname, 'key.pem');
    let server;
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      try {
        const options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
        server = https.createServer(options, requestHandler);
        server._isHttps = true;
        console.log('Starting HTTPS WebSocket bridge using cert/key:', certPath, keyPath);
      } catch (e) {
        console.error('Failed to start HTTPS server, falling back to HTTP:', e.message);
        server = http.createServer(requestHandler);
        server._isHttps = false;
      }
    } else {
      server = http.createServer(requestHandler);
      server._isHttps = false;
    }
    // make WS auth timeout configurable (ms)
    const AUTH_TIMEOUT_MS = Number(process.env.WS_AUTH_TIMEOUT_MS || 10000);
    wss = new WebSocket.Server({ server });
    // surface server errors instead of letting them crash the process
    server.on('error', err => {
      console.error('HTTP(S) server error:', err && err.message ? err.message : err);
    });
    // Log upgrade requests for WS troubleshooting
    server.on('upgrade', (req, socket, head) => {
      try {
        const remote = req && req.socket ? (req.socket.remoteAddress + ':' + (req.socket.remotePort||'')) : 'unknown';
        console.log('[http-upgrade] upgrade path=', req.url, 'from=', remote, 'sec-proto=', req.headers['sec-websocket-protocol'], 'auth=', req.headers['authorization']);
      } catch (e) {}
    });
    wss.on('error', err => {
      console.error('WebSocket server error:', err && err.message ? err.message : err);
    });

    server.listen(wsPort, hostBind, () => console.log('WebSocket bridge listening on', hostBind + ':' + wsPort, server._isHttps ? '(HTTPS)' : '(HTTP)'));
    // Accept the optional `req` parameter to inspect the upgrade request (query params / headers)
    wss.on('connection', (ws, req) => {
      // optional simple token auth for WebSocket
  const BRIDGE_TOKEN = effectiveBridgeToken();
  const urlObjForWs = (() => { try { return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); } catch (e) { return { pathname: '/' }; } })();
  const isPublicWsPath = urlObjForWs.pathname === '/_ws' || urlObjForWs.pathname === '/ws';
  // If public path or no token configured, treat as authed
  let authed = isPublicWsPath || !BRIDGE_TOKEN;

      // If a BRIDGE_TOKEN is configured, try several implicit auth methods from the upgrade request
      if (BRIDGE_TOKEN) {
        try {
          const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
          const urlToken = urlObj.searchParams.get('token');
          if (urlToken === BRIDGE_TOKEN) {
            authed = true;
            console.log('[ws] auth via url param', (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : 'unknown');
          }
          // Sec-WebSocket-Protocol (some clients/proxies can use this)
          if (!authed && req.headers['sec-websocket-protocol']) {
            const proto = String(req.headers['sec-websocket-protocol']).split(',')[0].trim();
            if (proto === BRIDGE_TOKEN) {
              authed = true;
              console.log('[ws] auth via sec-websocket-protocol', (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : 'unknown');
            }
          }
          // Authorization header during upgrade
          if (!authed && req.headers['authorization']) {
            const header = String(req.headers['authorization'] || '');
            const parts = header.split(' ');
            if (parts.length === 2 && /^Bearer$/i.test(parts[0]) && parts[1] === BRIDGE_TOKEN) {
              authed = true;
              console.log('[ws] auth via Authorization header', (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : 'unknown');
            }
          }
        } catch (e) { /* ignore parse errors */ }
      }

      // If not authed yet, expect a first-message auth payload within AUTH_TIMEOUT_MS
      if (BRIDGE_TOKEN && !authed) {
        // Don't close unauthenticated clients — keep connections open but with limited info.
        // Start a non-fatal warning timer for diagnostics so we can log clients that never auth.
        const warnTimer = setTimeout(() => { if (!authed) console.log('[ws] auth not received within', AUTH_TIMEOUT_MS, 'ms from', (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : 'unknown'); }, AUTH_TIMEOUT_MS);
        const authHandler = raw => {
          try {
            const obj = JSON.parse(raw);
            if (obj && obj.type === 'auth' && obj.token === BRIDGE_TOKEN) {
              authed = true;
              clearTimeout(warnTimer);
              ws.removeListener('message', authHandler);
              try { ws.send(JSON.stringify({ type: 'status', data: { connectionName, brokerUrl, username: cfg.username }, ts: Date.now() })); } catch (e) {}
            }
          } catch (e) { /* ignore */ }
        };
        ws.on('message', authHandler);
      } else if (authed) {
        // send privileged status immediately when already authed
        try { ws.send(JSON.stringify({ type: 'status', data: { connectionName, brokerUrl, username: cfg.username }, ts: Date.now() })); } catch (e) {}
      }

      // send minimal initial state to all clients (do not leak brokerUrl/username to unauthenticated)
      try { ws.send(JSON.stringify({ type: 'status', data: { server: 'brewski', connectionName }, ts: Date.now() })); } catch (e) {}

      // send topics as array of strings: merge configured topics and seen topics
      const configured = Array.isArray(topics) ? topics.slice() : [];
      const seen = Array.from(seenTopics.keys());
      const merged = Array.from(new Set([...configured, ...seen]));
      try { ws.send(JSON.stringify({ type: 'topics', data: merged, ts: Date.now() })); } catch (e) {}

      // broadcast cached latest Target/Sensor values first so clients receive any persisted state
      try {
        for (const [topic, payload] of latestValue.entries()) {
          if (/\/(Target|Sensor)$/.test(topic)) {
            try { ws.send(JSON.stringify({ type: 'current', topic, payload, cached: true, retained: !!latestRetain.get(topic), ts: Date.now() })); } catch (e) {}
          }
        }
      } catch (e) {}

      // send recent messages buffer
      try { ws.send(JSON.stringify({ type: 'recent-messages', data: recentMessages.map(m => ({ ...m, retained: latestRetain.get(m.topic) || false })), ts: Date.now() })); } catch (e) {}

      // listen for commands from clients (publish and get)
      ws.on('message', raw => {
        try {
          const obj = JSON.parse(raw);
          if (!obj || !obj.type) return;
          if (obj.type === 'publish') {
            const topic = obj.topic || 'DUMMYtest/Sensor';
            const payload = (typeof obj.payload === 'string' || typeof obj.payload === 'number') ? String(obj.payload) : JSON.stringify(obj.payload || '');
            const retain = /\/(Target)$/.test(topic);
            client.publish(topic, payload, { qos: 0, retain }, err => {
              if (err) {
                try { ws.send(JSON.stringify({ type: 'publish-result', success: false, error: String(err), id: obj.id, ts: Date.now() })); } catch (e) {}
              } else {
                latestValue.set(topic, payload);
                latestRetain.set(topic, !!retain);
                try { ws.send(JSON.stringify({ type: 'publish-result', success: true, topic, payload, id: obj.id, retained: !!retain, ts: Date.now() })); } catch (e) {}
              }
            });
            return;
          }
          if (obj.type === 'inventory') {
            const inv = {};
            for (const [k, v] of latestValue.entries()) {
              if (/\/(Target|Sensor)$/i.test(k)) inv[k] = v;
            }
            const invMeta = {};
            for (const k of Object.keys(inv)) invMeta[k] = { value: inv[k], retained: !!latestRetain.get(k) };
            try { ws.send(JSON.stringify({ type: 'inventory', data: invMeta, id: obj.id, ts: Date.now() })); } catch (e) {}
            return;
          }
          if (obj.type === 'get') {
            const topic = obj.topic;
            if (!topic) return;
            let payload = null;
            if (latestValue.has(topic)) payload = latestValue.get(topic);
            else {
              const found = recentMessages.find(m => m.topic === topic);
              payload = found ? found.payload : null;
            }
            if (payload === null) dlog('[GET MISS]', topic, 'no cached value'); else dlog('[GET HIT]', topic, '->', payload);
            try { ws.send(JSON.stringify({ type: 'current', topic, payload, id: obj.id, retained: !!latestRetain.get(topic), ts: Date.now() })); } catch (e) {}
            return;
          }
        } catch (e) { /* ignore invalid messages */ }
      });

      // log close and error events and keepalive pings
      try {
        ws.on('close', (code, reason) => {
          const addr = (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : 'unknown';
          let r = '';
          try { r = reason && reason.length ? reason.toString() : ''; } catch (e) {}
          console.log('[ws] connection closed', { addr, code, reason: r });
        });
        ws.on('error', err => { console.error('[ws] connection error', err && err.message ? err.message : err); });
        const pingInterval = setInterval(() => { try { if (ws.readyState === WebSocket.OPEN) ws.ping(); } catch (e) {} }, Number(process.env.WS_PING_INTERVAL_MS || 25000));
        ws.on('close', () => { try { clearInterval(pingInterval); } catch (e) {} });
      } catch (e) { /* best-effort logging */ }
    });
    broadcast = obj => {
      // attach debug timestamp to all broadcasted messages so ordering can be verified client-side
      const withTs = { ...obj, ts: Date.now() };
      const j = JSON.stringify(withTs);
      wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(j); });
    };
  } catch (e) {
    console.error('Failed to start WebSocket server. Install `ws` package to enable --ws-port.');
    wsPort = null;
  }
}

// Attach handlers to a newly created client so fallbacks work correctly
function attachClientHandlers(c) {
  c.on('connect', () => {
    console.log(`Connected to ${connectionName} at ${brokerUrl}`);

    // Subscribe to everything to discover all topics
    const subscribeList = ['#', '$SYS/#'];
    subscribeList.forEach(t => {
      c.subscribe(t, { qos: 0 }, err => {
        if (err) console.error('Subscription error for', t, err);
        else dlog('Subscribed to', t);
      });
    });

    // Also subscribe to our known topics (helps with more specific QoS if needed)
    topics.forEach(t => c.subscribe(t, { qos: 0 }));
  });

  c.on('message', (topic, message, packet) => {
    totalMessages += 1;
    const count = (seenTopics.get(topic) || 0) + 1;
    seenTopics.set(topic, count);

    // Report new topic when first seen
    if (count === 1) {
      dlog(`[NEW TOPIC] ${topic}`);
      broadcast && broadcast({ type: 'new-topic', data: topic });
    }

    // Print message (short) and occasional summary
    const payload = message.toString();
    const isRetained = packet && packet.retain ? true : false;
    const retained = isRetained ? ' (retained)' : '';
    dlog(`[MSG ${totalMessages}]${retained} ${topic}: ${payload.slice(0, 200)}`);
    // push to recent buffer & update latest value cache
    recentMessages.unshift({ topic, payload, seq: totalMessages, ts: Date.now(), retained: isRetained });
    latestValue.set(topic, payload);
    latestRetain.set(topic, !!isRetained);
    // Persist only Target/Sensor topics to keep file small
    if (/\/(Target|Sensor)$/i.test(topic)) {
      persistLatest();
    }

    if (recentMessages.length > MAX_RECENT) recentMessages.splice(MAX_RECENT);
    broadcast && broadcast({ type: 'message', data: { topic, payload, seq: totalMessages, retained: !!isRetained } });
    // After caching, attempt threshold push
    const lower = topic.toLowerCase();
    if (/(sensor)$/i.test(topic)) {
      const numeric = Number(payload);
      if (!Number.isNaN(numeric)) {
        checkThresholdAndMaybePush(topic, numeric);
      }
    }
  });
}

// Periodic summary every 30 seconds
const summaryInterval = setInterval(() => {
  if (DEBUG) {
    console.log('\n--- MQTT Summary ---');
    console.log('Total messages:', totalMessages);
    console.log('Known topics:', seenTopics.size);
    // show top 10 topics by count
    const top = Array.from(seenTopics.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    top.forEach(([t, c]) => console.log(` - ${t}: ${c}`));
    console.log('--- end summary ---\n');
  }
  const top = Array.from(seenTopics.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  broadcast && broadcast({ type: 'summary', data: { totalMessages, knownTopics: seenTopics.size, top } });
}, 30_000);

function shutdown() {
  console.log('Shutting down, unsubscribing and closing connection...');
  clearInterval(summaryInterval);
  try { client.unsubscribe('#'); client.unsubscribe('$SYS/#'); } catch (e) {}
  client.end(true, () => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// push notification support (Expo)
// - stores push tokens per device/browser in .push-tokens.json
// - sends threshold-based alerts for temperature/humidity changes
const PUSH_TOKEN_FILE = path.join(__dirname, '.push-tokens.json');
let pushTokens = new Set();
try { if (fs.existsSync(PUSH_TOKEN_FILE)) { const raw = JSON.parse(fs.readFileSync(PUSH_TOKEN_FILE,'utf8')); if (Array.isArray(raw)) raw.forEach(t=>pushTokens.add(t)); } } catch(e){}
function savePushTokens(){ try { fs.writeFileSync(PUSH_TOKEN_FILE, JSON.stringify(Array.from(pushTokens))); } catch(e){} }

// simple per-topic last state to detect transitions for push alerts
const topicState = new Map();
// Static (regex based) thresholds kept as a fallback when no per-device override exists
const STATIC_THRESHOLDS = [
  { match:/FERM\d+\/Sensor$/i, min:60, max:80, label:'Fermentation' },
  { match:/MASH.*\/Sensor$/i, min:148, max:162, label:'Mash' },
  { match:/BOIL.*\/Sensor$/i, min:200, max:220, label:'Boil' }
];

// Dynamic per-base overrides (base = topic without /Sensor or /Target)
const THRESHOLD_FILE = path.join(__dirname, '.thresholds.json');
let thresholdOverrides = {}; // { [base]: { min, max, label? } }
try {
  if (fs.existsSync(THRESHOLD_FILE)) {
    const raw = JSON.parse(fs.readFileSync(THRESHOLD_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) thresholdOverrides = raw;
  }
} catch(e) { dlog('threshold load error', e.message); }
function saveThresholdOverrides(){
  try { fs.writeFileSync(THRESHOLD_FILE, JSON.stringify(thresholdOverrides, null, 2)); } catch(e) { dlog('threshold persist error', e.message); }
}

function getOverrideForTopic(topic){
  if (!topic) return null;
  const base = topic.replace(/\/(Sensor|Target)$/i, '');
  const ov = thresholdOverrides[base];
  if (!ov) return null;
  if (typeof ov.min !== 'number' || typeof ov.max !== 'number') return null;
  return { base, min: ov.min, max: ov.max, label: ov.label || base };
}

function getRuleForTopic(topic){
  // Prefer explicit override
  const override = getOverrideForTopic(topic);
  if (override) return override;
  // Fallback to static regex rules
  const staticRule = STATIC_THRESHOLDS.find(r => r.match.test(topic));
  return staticRule || null;
}
const PUSH_COOLDOWN_MS = 30*60*1000; // 30 minutes per topic
const lastPushTime = new Map();
async function sendExpoPush(body){
  if (!pushTokens.size) return;
  const messages = Array.from(pushTokens).map(token => ({ to: token, sound: 'default', title: body.title, body: body.body, data: body.data||{} }));
  try {
    const resp = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
      body: JSON.stringify(messages)
    });
    try { const txt = await resp.text(); console.log('[push] sent', messages.length, 'status', resp.status, txt.slice(0,200)); } catch(e){}
  } catch(e) { dlog('Push send error', e.message); }
}
function checkThresholdAndMaybePush(topic, value){
  const rule = getRuleForTopic(topic);
  if (!rule) return;
  if (typeof value !== 'number' || Number.isNaN(value)) return;
  const prev = topicState.get(topic) || { inRange: true };
  const inRange = value >= rule.min && value <= rule.max;
  topicState.set(topic,{ inRange, value, ts:Date.now() });
  if (prev.inRange && !inRange){
    const last = lastPushTime.get(topic) || 0;
    const now = Date.now();
    if (now - last < PUSH_COOLDOWN_MS) return;
    lastPushTime.set(topic, now);
    console.log('[push] out-of-range', topic, value, 'rule', rule.min, rule.max);
    sendExpoPush({
      title: `${rule.label} out of range`,
      body: `${topic.split('/')[0]}: ${value.toFixed(1)}° (allowed ${rule.min}-${rule.max})`,
      data: { topic, value, min:rule.min, max:rule.max }
    });
  } else if (!prev.inRange && inRange) {
    const last = lastPushTime.get(topic+'-restore') || 0;
    const now = Date.now();
    if (now - last < PUSH_COOLDOWN_MS/2) return;
    lastPushTime.set(topic+'-restore', now);
    console.log('[push] restore in-range', topic, value);
    sendExpoPush({
      title: `${rule.label} back in range`,
      body: `${topic.split('/')[0]}: ${value.toFixed(1)}° now within ${rule.min}-${rule.max}`,
      data: { topic, value, restored:true }
    });
  }
}