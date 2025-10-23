const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Start a WebSocket bridge attached to an existing HTTP(S) server or create
// one if delegatedHttp is not provided. This mirrors the behaviour that used
// to live inline in mqtt-connector.js but is now extracted for clarity.
function startWsBridge(opts = {}) {
  const { delegatedHttp, publishFn, mqttClient, caches = {} } = opts;
  const wsPort = Number(process.env.QUICK_MQTT_WS_PORT || 8080);
  const hostBind = process.env.QUICK_MQTT_WS_HOST || '0.0.0.0';

  let server = null;
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
  const { latestValue, latestRetain, recentMessages, topics, seenTopics, persistLatest } = caches;

  // Broadcast helper
  const broadcast = obj => {
    const withTs = { ...obj, ts: Date.now() };
    const j = JSON.stringify(withTs);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(j); });
  };

  // Attach mqttClient listener if provided
  if (mqttClient && mqttClient.on) {
    try {
      const isTerminalTopic = t => { try { if (!t) return false; const l = String(t).toLowerCase(); return l.endsWith('/sensor') || l.endsWith('sensor') || l.endsWith('/target') || l.endsWith('target'); } catch (e) { return false; } };
      mqttClient.on('message', ({ topic, payload, retained, seq }) => {
        try { broadcast({ type: 'mqtt-message', topic, payload, retained: !!retained, seq }); } catch (e) {}
        if (isTerminalTopic(topic)) {
          try { broadcast({ type: 'current', topic, payload, retained: !!retained }); } catch (e) {}
        }
      });
    } catch (e) { console.error('ws-bridge: failed attaching mqttClient message listener', e && e.message); }
  }

  function effectiveBridgeToken() {
    if (process.env.DISABLE_BRIDGE_TOKEN === '1') return null;
    return process.env.BRIDGE_TOKEN || null;
  }

  server.on('error', err => console.error('ws-bridge server error:', err && err.message ? err.message : err));

  server.on('upgrade', (req, socket, head) => {
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

        let authed = false; let claims = null;
        if (token) {
          try {
            const { verifyToken } = require('./lib/auth');
            claims = verifyToken(token); if (claims) authed = true;
          } catch (e) {}
          if (!authed && BRIDGE_TOKEN && token === BRIDGE_TOKEN) { authed = true; claims = { sub: 'bridge', username: 'bridge-token', legacy: true }; }
        }
        if (!authed) {
          try {
            const body = JSON.stringify({ error: 'missing_or_invalid_token' });
            const resHeaders = [ 'HTTP/1.1 401 Unauthorized', 'Content-Type: application/json; charset=utf-8', 'Content-Length: ' + Buffer.byteLength(body), 'WWW-Authenticate: Bearer realm="brewski"', '\r\n' ].join('\r\n');
            socket.write(resHeaders); socket.write(body);
          } catch (e) {}
          try { socket.destroy(); } catch (e) {}
          return;
        }

        req.user = { id: claims.sub, username: claims.username, legacy: !!claims.legacy };
        wss.handleUpgrade(req, socket, head, ws => { try { wss.emit('connection', ws, req); } catch (e) { try { ws.close(); } catch (e) {} } });
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

    if (mqttClient && typeof mqttClient.getGroupedInventory === 'function') {
      try { ws.send(JSON.stringify({ type: 'grouped-inventory', data: mqttClient.getGroupedInventory({ onlyTerminal: true }), ts: Date.now() })); } catch (e) {}
      try { ws.send(JSON.stringify({ type: 'summary', data: mqttClient.snapshotSummary ? mqttClient.snapshotSummary() : {}, ts: Date.now() })); } catch (e) {}
    }

    // Send cached currents for terminal topics
    try {
      const isTerminalTopic = t => { try { if (!t) return false; const l = String(t).toLowerCase(); return l.endsWith('/sensor') || l.endsWith('sensor') || l.endsWith('/target') || l.endsWith('target'); } catch (e) { return false; } };
      for (const [topic, payload] of (latestValue && latestValue.entries ? latestValue.entries() : [])) {
        if (isTerminalTopic(topic)) {
          try {
            const retainedFlag = !!(latestRetain && latestRetain.get && latestRetain.get(topic));
            if (LOG_WS) console.log('[ws-bridge] send cached current to new client', { topic, retained: retainedFlag, sample: String(payload).slice(0,100) });
            ws.send(JSON.stringify({ type: 'current', topic, payload, cached: true, retained: retainedFlag, ts: Date.now() }));
          } catch (e) {}
        }
      }
    } catch (e) {}

    try { ws.send(JSON.stringify({ type: 'recent-messages', data: (recentMessages || []).map(m => ({ ...m, retained: (latestRetain && latestRetain.get && latestRetain.get(m.topic)) || false })), ts: Date.now() })); } catch (e) {}

    // Proactively request targ/* retained messages for this new client.
    // This subscribes briefly to targ/# so the broker will send retained targ messages
    // even if the bridge cache doesn't yet contain them. We only forward incoming
    // targ current messages to this ws client and populate latestValue/latestRetain.
    try {
      if (mqttClient && mqttClient.client && typeof mqttClient.client.subscribe === 'function') {
        const targTopic = 'targ/#';
        const tmpListener = msg => {
          try {
            const topic = msg && (msg.topic || msg.topic === 0) ? msg.topic : (msg && msg.topic) ;
            const payload = msg && msg.payload !== undefined ? msg.payload : (msg && msg.payload);
            const retained = !!(msg && msg.retained);
            if (!topic || typeof topic !== 'string') return;
            if (!topic.toLowerCase().startsWith('targ/')) return;
            // populate caches
            try { if (latestValue && latestValue.set) latestValue.set(topic, String(payload)); } catch (e) {}
            try { if (latestRetain && latestRetain.set) latestRetain.set(topic, !!retained); } catch (e) {}
            // send only to this ws client
            try { ws.send(JSON.stringify({ type: 'current', topic, payload, cached: false, retained, ts: Date.now() })); } catch (e) {}
          } catch (e) {}
        };
        try { mqttClient.client.subscribe(targTopic, { qos: 0 }, () => {}); } catch (e) {}
        try { mqttClient.on('message', tmpListener); } catch (e) {}
        // remove after short timeout and send an inventory snapshot to populate UI
        const windowMs = Number(process.env.TARG_SUBSCRIBE_WINDOW_MS || 500);
        setTimeout(() => {
          try {
            // build inventory of targ/* from latestValue
            const inv = {};
            try {
              if (latestValue && latestValue.entries) {
                for (const [k, v] of latestValue.entries()) {
                  try {
                    if (typeof k === 'string' && k.toLowerCase().startsWith('targ/')) {
                      inv[k] = { value: v, retained: !!(latestRetain && latestRetain.get && latestRetain.get(k)) };
                    }
                  } catch (e) {}
                }
              }
            } catch (e) {}
            try { ws.send(JSON.stringify({ type: 'inventory', data: inv, id: 'initial-inventory', ts: Date.now() })); } catch (e) {}
          } catch (e) {}
          try { mqttClient.removeListener('message', tmpListener); } catch (e) {}
          try { mqttClient.client.unsubscribe(targTopic, () => {}); } catch (e) {}
        }, windowMs);
      }
    } catch (e) {}

    ws.on('message', raw => {
      try {
        const obj = JSON.parse(raw);
        if (!obj || !obj.type) return;

        if (obj.type === 'publish') {
          const topic = obj.topic;
          const payload = (typeof obj.payload === 'string' || typeof obj.payload === 'number') ? String(obj.payload) : JSON.stringify(obj.payload || '');
          const retain = (obj.retain === true) && String(topic || '').toLowerCase().endsWith('target');
          if (LOG_WS) { try { console.log('[ws-bridge] WS publish request', { user: (req && req.user && req.user.username) || 'unknown', topic, payload, requestedRetain: !!obj.retain, effectiveRetain: !!retain }); } catch (e) {} }
          const pub = typeof publishFn === 'function' ? publishFn : (mqttClient && mqttClient.publish ? mqttClient.publish.bind(mqttClient) : null);
          if (!pub) { try { ws.send(JSON.stringify({ type: 'publish-result', success: false, error: 'no_publish_fn', id: obj.id, ts: Date.now() })); } catch (e) {} return; }
          pub(topic, payload, { qos: 0, retain }, err => {
            if (err) { try { ws.send(JSON.stringify({ type: 'publish-result', success: false, error: String(err), id: obj.id, ts: Date.now() })); } catch (e) {} }
            else {
              try { if (latestValue && latestValue.set) latestValue.set(topic, payload); } catch (e) {}
              try { if (latestRetain && latestRetain.set) latestRetain.set(topic, !!retain); } catch (e) {}
              try { if (typeof persistLatest === 'function') persistLatest(); } catch (e) {}
              try { ws.send(JSON.stringify({ type: 'publish-result', success: true, topic, payload, id: obj.id, retained: !!retain, ts: Date.now() })); } catch (e) {}
            }
          });
          return;
        }

        if (obj.type === 'inventory') {
          const inv = {};
          try { const isTerminalTopic = t => { try { if (!t) return false; const l = String(t).toLowerCase(); return l.endsWith('/sensor') || l.endsWith('sensor') || l.endsWith('/target') || l.endsWith('target'); } catch (e) { return false; } } ; if (latestValue && latestValue.entries) for (const [k,v] of latestValue.entries()) { if (isTerminalTopic(k)) inv[k] = v; } } catch (e) {}
          const invMeta = {};
          for (const k of Object.keys(inv)) invMeta[k] = { value: inv[k], retained: !!(latestRetain && latestRetain.get && latestRetain.get(k)) };
          try { ws.send(JSON.stringify({ type: 'inventory', data: invMeta, id: obj.id, ts: Date.now() })); } catch (e) {}
          return;
        }

        if (obj.type === 'get') {
          const topic = obj.topic;
          if (!topic) return;
          try { console.log('[ws-bridge] received WS GET', { from: (req && req.user && req.user.username) || 'unknown', topic, id: obj.id }); } catch (e) {}

          // Only handle Target requests by resolving to targ/...Target variants.
          const ltopic = String(topic || '');
          const isTargetRequest = /\/target$/i.test(ltopic) || ltopic.toLowerCase().startsWith('targ/');

          if (!isTargetRequest) {
            // Non-target: direct lookup
            let payload = null;
            try { if (latestValue && latestValue.has && latestValue.has(topic)) payload = latestValue.get(topic); } catch (e) {}
            if (payload === null) {
              const found = (recentMessages || []).find(m => m.topic === topic);
              payload = found ? found.payload : null;
            }
            try {
              const retainedFlag = !!(latestRetain && latestRetain.get && latestRetain.get(topic));
              if (LOG_WS) console.log('[ws-bridge] reply GET current (non-target)', { forClient: (req && req.user && req.user.username) || 'unknown', topic, id: obj.id, retained: retainedFlag, sample: String(payload).slice(0,100) });
              ws.send(JSON.stringify({ type: 'current', topic, payload, id: obj.id, retained: retainedFlag, ts: Date.now() }));
            } catch (e) {}
            return;
          }

          // Target request: resolve to targ/...Target only (robust, case-insensitive)
          let resolvedTopic = null; let payload = null; let resolvedRetain = false;
          try {
            const lcRequested = ltopic.toLowerCase();

            // Helper: case-insensitive Map lookup for latestValue
            const findInLatest = want => {
              if (!latestValue) return null;
              if (latestValue.has && latestValue.has(want)) return want;
              const wantLc = String(want || '').toLowerCase();
              for (const k of latestValue.keys()) {
                if (String(k).toLowerCase() === wantLc) return k; // exact match ignoring case
              }
              return null;
            };

            // 1) If client already requested a targ/ topic, try direct (case-insensitive)
            if (lcRequested.startsWith('targ/')) {
              const k = findInLatest(ltopic);
              if (k) { resolvedTopic = k; payload = latestValue.get(k); resolvedRetain = !!(latestRetain && latestRetain.get && latestRetain.get(k)); }
            }

            // 2) If not found, and requested was a canonical /Target, build candidate(s)
            if (!resolvedTopic && /\/target$/i.test(ltopic)) {
              const parts = ltopic.split('/').filter(Boolean);
              if (parts.length >= 2) {
                const deviceName = parts[parts.length - 2];
                const site = parts[0];
                const cand1 = `targ/${site}/${deviceName}Target`;
                const cand2 = `targ/${deviceName}Target`;
                const k1 = findInLatest(cand1);
                const k2 = findInLatest(cand2);
                if (k1) { resolvedTopic = k1; payload = latestValue.get(k1); resolvedRetain = !!(latestRetain && latestRetain.get && latestRetain.get(k1)); }
                else if (k2) { resolvedTopic = k2; payload = latestValue.get(k2); resolvedRetain = !!(latestRetain && latestRetain.get && latestRetain.get(k2)); }
              }
            }

            // 3) If still not found, scan latestValue keys for any targ/* that ends with '<device>Target' (case-insensitive)
            if (!resolvedTopic && latestValue && latestValue.keys) {
              const parts = ltopic.split('/').filter(Boolean);
              const deviceName = parts.length >= 2 ? parts[parts.length - 2] : null;
              const candidates = [];
              for (const k of latestValue.keys()) {
                const kl = String(k).toLowerCase();
                if (!kl.startsWith('targ/')) continue;
                if (deviceName && kl.endsWith((deviceName + 'target').toLowerCase())) {
                  candidates.push(k);
                } else if (/target$/.test(kl)) {
                  candidates.push(k);
                }
              }
              // Prefer candidate with retained flag true
              if (candidates.length) {
                let pick = candidates.find(k => !!(latestRetain && latestRetain.get && latestRetain.get(k)));
                if (!pick) pick = candidates[0];
                resolvedTopic = pick; payload = latestValue.get(pick); resolvedRetain = !!(latestRetain && latestRetain.get && latestRetain.get(pick));
              }
            }

            // 4) Fall back to recentMessages search (most recent first), case-insensitive
            if (!resolvedTopic && Array.isArray(recentMessages) && recentMessages.length) {
              const lcDevice = (() => { const p = ltopic.split('/').filter(Boolean); return p.length >= 2 ? p[p.length - 2].toLowerCase() : null; })();
              const found = recentMessages.find(m => {
                if (!m || !m.topic) return false;
                const mt = String(m.topic).toLowerCase();
                if (!mt.startsWith('targ/')) return false;
                if (lcDevice) return mt.endsWith(lcDevice + 'target');
                return mt.indexOf('target') !== -1;
              });
              if (found) { resolvedTopic = found.topic; payload = found.payload; resolvedRetain = !!found.retained; }
            }

            // 5) If still not found, try to subscribe temporarily to the targ topic(s)
            // This forces the broker to deliver a retained message (if any).
            if (!resolvedTopic && mqttClient && mqttClient.client) {
              try {
                const subs = new Set();
                if (lcRequested.startsWith('targ/')) subs.add(ltopic);
                else if (/\/target$/i.test(ltopic)) {
                  const parts = ltopic.split('/').filter(Boolean);
                  if (parts.length >= 2) {
                    const deviceName = parts[parts.length - 2];
                    const site = parts[0];
                    subs.add(`targ/${site}/${deviceName}Target`);
                    subs.add(`targ/${deviceName}Target`);
                  }
                }
                const subList = Array.from(subs);
                if (subList.length) {
                  let answered = false;
                  const lcSubs = subList.map(s => String(s).toLowerCase());
                  const tmpListener = msg => {
                    try {
                      const mt = String(msg.topic || '').toLowerCase();
                      if (lcSubs.includes(mt)) {
                        if (answered) return;
                        answered = true;
                        resolvedTopic = msg.topic;
                        payload = msg.payload;
                        resolvedRetain = !!msg.retained;
                        try { mqttClient.removeListener('message', tmpListener); } catch (e) {}
                        try { subList.forEach(s => mqttClient.client.unsubscribe(s, () => {})); } catch (e) {}
                        // send reply now
                        const retainedFlag = !!resolvedRetain || !!(latestRetain && latestRetain.get && latestRetain.get(resolvedTopic));
                        if (LOG_WS) console.log('[ws-bridge] reply GET current (targ via subscribe)', { forClient: (req && req.user && req.user.username) || 'unknown', requested: topic, resolved: resolvedTopic, id: obj.id, retained: retainedFlag, sample: String(payload).slice(0,100) });
                        try { ws.send(JSON.stringify({ type: 'current', topic: resolvedTopic, payload, id: obj.id, retained: retainedFlag, ts: Date.now() })); } catch (e) {}
                      }
                    } catch (e) {}
                  };

                  // subscribe to candidates
                  subList.forEach(s => {
                    try { mqttClient.client.subscribe(s, { qos: 0 }, err => {}); } catch (e) {}
                  });
                  // listen for message events from mqttClient (it emits {topic,payload,seq,retained})
                  try { mqttClient.on('message', tmpListener); } catch (e) {}
                  // wait up to 750ms
                  setTimeout(() => {
                    try {
                      if (!answered) {
                        try { mqttClient.removeListener('message', tmpListener); } catch (e) {}
                        try { subList.forEach(s => mqttClient.client.unsubscribe(s, () => {})); } catch (e) {}
                        // no result, fall through to the normal null reply
                      }
                    } catch (e) {}
                  }, 750);
                }
              } catch (e) {}
            }

            // if resolvedTopic found but payload is undefined/null, try reading latestValue again
            if (resolvedTopic && (payload === null || payload === undefined)) {
              try { if (latestValue && latestValue.has && latestValue.has(resolvedTopic)) payload = latestValue.get(resolvedTopic); } catch (e) {}
            }
          } catch (e) {}

          try {
            if (resolvedTopic) {
              const retainedFlag = !!resolvedRetain || !!(latestRetain && latestRetain.get && latestRetain.get(resolvedTopic));
              if (LOG_WS) console.log('[ws-bridge] reply GET current (resolved targ)', { forClient: (req && req.user && req.user.username) || 'unknown', requested: topic, resolved: resolvedTopic, id: obj.id, retained: retainedFlag, sample: String(payload).slice(0,100) });
              ws.send(JSON.stringify({ type: 'current', topic: resolvedTopic, payload, id: obj.id, retained: retainedFlag, ts: Date.now() }));
            } else {
              if (LOG_WS) console.log('[ws-bridge] no targ variant found for target request', { forClient: (req && req.user && req.user.username) || 'unknown', requested: topic, id: obj.id });
              ws.send(JSON.stringify({ type: 'current', topic, payload: null, id: obj.id, retained: false, ts: Date.now() }));
            }
          } catch (e) {}
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

  if (!delegatedHttp || !delegatedHttp.server) {
    server.listen(wsPort, hostBind, () => console.log('ws-bridge listening on', hostBind + ':' + wsPort, server._isHttps ? '(HTTPS)' : '(HTTP)'));
  }

  return { wss, broadcast, server };
}

module.exports = { startWsBridge };
 