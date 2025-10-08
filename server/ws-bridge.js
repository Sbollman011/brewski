const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Start a WebSocket bridge attached to an existing HTTP(S) server or create
// one if delegatedHttp is not provided. This mirrors the behaviour that used
// to live inline in mttq-connector.js but is now extracted for clarity.
// options:
//  - delegatedHttp: { server, port, host } optional
//  - publishFn(topic, payload, opts, cb) - function used to publish to MQTT
//  - mqttClient: optional mqtt-client module
//  - caches: { latestValue, latestRetain, recentMessages, topics, seenTopics, MAX_RECENT, persistLatest, checkThresholdAndMaybePush, sendExpoPush }
function startWsBridge(opts = {}) {
  const { delegatedHttp, publishFn, mqttClient, caches = {} } = opts;
  const wsPort = Number(process.env.QUICK_MQTT_WS_PORT || 8080);
  const hostBind = process.env.QUICK_MQTT_WS_HOST || '0.0.0.0';

  let server = null;
  // Create or reuse server
  if (delegatedHttp && delegatedHttp.server) {
    server = delegatedHttp.server;
    console.log('ws-bridge: attaching to delegated http-server instance');
  } else {
    const certPath = process.env.QUICK_MQTT_CERT || path.join(__dirname, 'cert.pem');
    const keyPath = process.env.QUICK_MQTT_KEY || path.join(__dirname, 'key.pem');
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      try {
        const options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
        server = https.createServer(options, (req, res) => { res.writeHead(404); res.end(); });
        server._isHttps = true;
        console.log('ws-bridge: created HTTPS server for WebSocket bridge');
      } catch (e) {
        console.error('ws-bridge: failed to create HTTPS server, falling back to HTTP', e && e.message);
        server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        server._isHttps = false;
      }
    } else {
      server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
      server._isHttps = false;
    }
  }

  const wss = new WebSocket.Server({ noServer: true });

  // If an mqttClient instance is provided, attach listeners to broadcast real-time updates
  // to all connected WebSocket clients. This pushes each MQTT message as { type:'mqtt-message', topic, payload, retained }.
  if (mqttClient && mqttClient.on) {
    try {
      mqttClient.on('message', ({ topic, payload, retained, seq }) => {
        try { broadcast({ type: 'mqtt-message', topic, payload, retained: !!retained, seq }); } catch (e) {}
        if (/\/(Target|Sensor)$/i.test(topic)) {
          // Also push a current update so existing dashboard logic listening for 'current' stays compatible
          try { broadcast({ type: 'current', topic, payload, retained: !!retained }); } catch (e) {}
        }
      });
    } catch (e) { console.error('ws-bridge: failed attaching mqttClient message listener', e && e.message ? e.message : e); }
  }

  function effectiveBridgeToken() {
    if (process.env.DISABLE_BRIDGE_TOKEN === '1') return null;
    return process.env.BRIDGE_TOKEN || null;
  }

  const { latestValue, latestRetain, recentMessages, topics, seenTopics, MAX_RECENT, persistLatest, checkThresholdAndMaybePush, sendExpoPush } = caches;

  server.on('error', err => console.error('ws-bridge server error:', err && err.message ? err.message : err));

  server.on('upgrade', (req, socket, head) => {
    // Authentication during upgrade
    (async () => {
      try {
        const BRIDGE_TOKEN = effectiveBridgeToken();
  const SERVER_FQDN = process.env.SERVER_FQDN || 'api.brewingremote.com';
  const urlObj = (() => { try { return new URL(req.url || '/', `http://${req.headers.host || SERVER_FQDN}`); } catch (e) { return { searchParams: new URLSearchParams() }; } })();
        const authHeader = (req.headers['authorization'] || '').toString();
        const parts = authHeader.split(' ');
        const maybeBearer = (parts.length === 2 && /^Bearer$/i.test(parts[0])) ? parts[1] : null;
        const secProto = (req.headers['sec-websocket-protocol'] || '').toString();
        let protoToken = null;
        if (secProto) {
          const sp = secProto.split(',').map(s => s.trim());
          for (const p of sp) { if (/^Bearer\s+/i.test(p)) { protoToken = p.replace(/^Bearer\s+/i, '').trim(); break; } }
          if (!protoToken && sp.length > 0) protoToken = sp[0];
        }
        const qpToken = urlObj.searchParams ? urlObj.searchParams.get('token') : null;
        if (protoToken && /^Bearer$/i.test(protoToken)) protoToken = null;
        const token = maybeBearer || qpToken || protoToken;

        let authed = false;
        let claims = null;
        if (token) {
          try {
            const { verifyToken } = require('./lib/auth');
            claims = verifyToken(token);
            if (claims) authed = true;
          } catch (e) {}
          if (!authed && BRIDGE_TOKEN && token === BRIDGE_TOKEN) {
            authed = true; claims = { sub: 'bridge', username: 'bridge-token', legacy: true };
          }
        }
        if (!authed) {
          try {
            const body = JSON.stringify({ error: 'missing_or_invalid_token' });
            const resHeaders = [
              'HTTP/1.1 401 Unauthorized',
              'Content-Type: application/json; charset=utf-8',
              'Content-Length: ' + Buffer.byteLength(body),
              'WWW-Authenticate: Bearer realm="brewski"',
              '\r\n'
            ].join('\r\n');
            socket.write(resHeaders);
            socket.write(body);
          } catch (e) {}
          try { socket.destroy(); } catch (e) {}
          return;
        }

        req.user = { id: claims.sub, username: claims.username, legacy: !!claims.legacy };

        wss.handleUpgrade(req, socket, head, ws => {
          try { wss.emit('connection', ws, req); } catch (e) { try { ws.close(); } catch (e) {} }
        });
      } catch (e) { try { socket.destroy(); } catch (err) {} }
    })();
  });

  wss.on('error', err => console.error('ws-bridge error:', err && err.message ? err.message : err));

  wss.on('connection', (ws, req) => {
    const user = (req && req.user) ? req.user : { id: 'unknown', username: 'unknown' };
    const LOG_WS = process.env.LOG_WS_MESSAGES === '1';
    try { ws.send(JSON.stringify({ type: 'status', data: { server: 'brewski', user }, ts: Date.now() })); } catch (e) {}

    const configured = Array.isArray(topics) ? topics.slice() : [];
    const seen = Array.from((seenTopics && seenTopics.keys && typeof seenTopics.keys === 'function') ? seenTopics.keys() : []);
    const merged = Array.from(new Set([...configured, ...seen]));
    try { ws.send(JSON.stringify({ type: 'topics', data: merged, ts: Date.now() })); } catch (e) {}
    // Send grouped inventory snapshot if mqttClient offers it (lightweight initial hydration)
    if (mqttClient && typeof mqttClient.getGroupedInventory === 'function') {
      try { ws.send(JSON.stringify({ type: 'grouped-inventory', data: mqttClient.getGroupedInventory({ onlyTerminal: true }), ts: Date.now() })); } catch (e) {}
      try { ws.send(JSON.stringify({ type: 'summary', data: mqttClient.snapshotSummary ? mqttClient.snapshotSummary() : {}, ts: Date.now() })); } catch (e) {}
    }

    try {
      for (const [topic, payload] of (latestValue && latestValue.entries ? latestValue.entries() : [])) {
        if (/\/(Target|Sensor)$/.test(topic)) {
          try { ws.send(JSON.stringify({ type: 'current', topic, payload, cached: true, retained: !!(latestRetain && latestRetain.get && latestRetain.get(topic)), ts: Date.now() })); } catch (e) {}
        }
      }
    } catch (e) {}

    try { ws.send(JSON.stringify({ type: 'recent-messages', data: (recentMessages || []).map(m => ({ ...m, retained: (latestRetain && latestRetain.get && latestRetain.get(m.topic)) || false })), ts: Date.now() })); } catch (e) {}

    ws.on('message', raw => {
      try {
        const obj = JSON.parse(raw);
        if (!obj || !obj.type) return;
        if (obj.type === 'publish') {
          const topic = obj.topic || 'DUMMYtest/Sensor';
          const payload = (typeof obj.payload === 'string' || typeof obj.payload === 'number') ? String(obj.payload) : JSON.stringify(obj.payload || '');
          const retain = /\/(Target)$/.test(topic);
          const pub = typeof publishFn === 'function' ? publishFn : (mqttClient && mqttClient.publish ? mqttClient.publish.bind(mqttClient) : null);
          if (!pub) {
            try { ws.send(JSON.stringify({ type: 'publish-result', success: false, error: 'no_publish_fn', id: obj.id, ts: Date.now() })); } catch (e) {}
            return;
          }
          pub(topic, payload, { qos: 0, retain }, err => {
            if (err) {
              try { ws.send(JSON.stringify({ type: 'publish-result', success: false, error: String(err), id: obj.id, ts: Date.now() })); } catch (e) {}
            } else {
              try { if (latestValue && latestValue.set) latestValue.set(topic, payload); } catch (e) {}
              try { if (latestRetain && latestRetain.set) latestRetain.set(topic, !!retain); } catch (e) {}
              try { if (/\/(Target|Sensor)$/.test(topic) && typeof persistLatest === 'function') persistLatest(); } catch (e) {}
              try { ws.send(JSON.stringify({ type: 'publish-result', success: true, topic, payload, id: obj.id, retained: !!retain, ts: Date.now() })); } catch (e) {}
            }
          });
          return;
        }
        if (obj.type === 'inventory') {
          const inv = {};
          try { if (latestValue && latestValue.entries) for (const [k,v] of latestValue.entries()) { if (/\/(Target|Sensor)$/i.test(k)) inv[k] = v; } } catch (e) {}
          const invMeta = {};
          for (const k of Object.keys(inv)) invMeta[k] = { value: inv[k], retained: !!(latestRetain && latestRetain.get && latestRetain.get(k)) };
          try { ws.send(JSON.stringify({ type: 'inventory', data: invMeta, id: obj.id, ts: Date.now() })); } catch (e) {}
          return;
        }
        if (obj.type === 'get') {
          const topic = obj.topic;
          if (!topic) return;
          let payload = null;
          try { if (latestValue && latestValue.has && latestValue.has(topic)) payload = latestValue.get(topic); } catch (e) {}
          if (payload === null) {
            const found = (recentMessages || []).find(m => m.topic === topic);
            payload = found ? found.payload : null;
          }
          try { ws.send(JSON.stringify({ type: 'current', topic, payload, id: obj.id, retained: !!(latestRetain && latestRetain.get && latestRetain.get(topic)), ts: Date.now() })); } catch (e) {}
          return;
        }
      } catch (e) {}
    });

    try {
      ws.on('close', (code, reason) => { if (LOG_WS) console.log('[ws] closed', code, reason && reason.toString ? reason.toString() : ''); });
      ws.on('error', err => console.error('[ws] connection error', err && err.message ? err.message : err));
      const pingInterval = setInterval(() => { try { if (ws.readyState === WebSocket.OPEN) ws.ping(); } catch (e) {} }, Number(process.env.WS_PING_INTERVAL_MS || 25000));
      ws.on('close', () => { try { clearInterval(pingInterval); } catch (e) {} });
    } catch (e) {}
  });

  const broadcast = obj => {
    const withTs = { ...obj, ts: Date.now() };
    const j = JSON.stringify(withTs);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(j); });
  };

  // Listen if we created the server locally
  if (!delegatedHttp || !delegatedHttp.server) {
    server.listen(wsPort, hostBind, () => console.log('ws-bridge listening on', hostBind + ':' + wsPort, server._isHttps ? '(HTTPS)' : '(HTTP)'));
  }

  return { wss, broadcast, server };
}

module.exports = { startWsBridge };
