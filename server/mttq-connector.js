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
    const hostBind = wsHost || '0.0.0.0';
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connectionName, brokerUrl, username: cfg.username }));
        return;
      }
      // list current threshold overrides (dynamic) and static patterns
      if (url.pathname === '/thresholds' && req.method === 'GET') {
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
            const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
            if (BRIDGE_TOKEN) {
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
        const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
        if (BRIDGE_TOKEN) {
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
              res.writeHead(200,{ 'Content-Type':'application/json'});
              res.end(JSON.stringify({ ok:true, tokens: pushTokens.size }));
            } else { res.writeHead(400); res.end('invalid token'); }
          } catch(e){ res.writeHead(400); res.end('bad json'); }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    wss = new WebSocket.Server({ server });
  server.listen(wsPort, hostBind, () => console.log('WebSocket bridge listening on', hostBind + ':' + wsPort));
    wss.on('connection', ws => {
      // optional simple token auth for WebSocket
      const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
      if (BRIDGE_TOKEN) {
        // expect a first message { type: 'auth', token: '...' } within 3s
        let authed = false;
        const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'auth required'); }, 3000);
        const authHandler = raw => {
          try {
            const obj = JSON.parse(raw);
            if (obj && obj.type === 'auth' && obj.token === BRIDGE_TOKEN) {
              authed = true;
              clearTimeout(authTimer);
              ws.removeListener('message', authHandler);
              // proceed to normal handlers by emitting a synthetic 'connected' message
            }
          } catch (e) { /* ignore */ }
        };
        ws.on('message', authHandler);
      }
      // send initial state
        ws.send(JSON.stringify({ type: 'status', data: { connectionName, brokerUrl, username: cfg.username }, ts: Date.now() }));
      // send topics as array of strings: merge configured topics and seen topics
      const configured = Array.isArray(topics) ? topics.slice() : [];
      const seen = Array.from(seenTopics.keys());
      const merged = Array.from(new Set([...configured, ...seen]));
        ws.send(JSON.stringify({ type: 'topics', data: merged, ts: Date.now() }));
      // broadcast cached latest Target/Sensor values first so clients receive any persisted state
      // before the recent-messages history. This prevents older cached values from overwriting
      // fresher recent messages that clients may render after connecting.
      try {
        for (const [topic, payload] of latestValue.entries()) {
          if (/\/(Target|Sensor)$/.test(topic)) {
              ws.send(JSON.stringify({ type: 'current', topic, payload, cached: true, retained: !!latestRetain.get(topic), ts: Date.now() }));
          }
        }
      } catch (e) {}
      // send recent messages buffer (include retained=false by default for history entries)
        ws.send(JSON.stringify({ type: 'recent-messages', data: recentMessages.map(m => ({ ...m, retained: latestRetain.get(m.topic) || false })), ts: Date.now() }));
        // listen for commands from clients (publish and get)
        ws.on('message', raw => {
          try {
            const obj = JSON.parse(raw);
            if (!obj || !obj.type) return;
              if (obj.type === 'publish') {
              const topic = obj.topic || 'DUMMYtest/Sensor';
              const payload = (typeof obj.payload === 'string' || typeof obj.payload === 'number') ? String(obj.payload) : JSON.stringify(obj.payload || '');
              // Retain Target values so future subscribers receive immediate state
              const retain = /\/(Target)$/.test(topic);
              client.publish(topic, payload, { qos: 0, retain }, err => {
                if (err) {
                  ws.send(JSON.stringify({ type: 'publish-result', success: false, error: String(err), id: obj.id, ts: Date.now() }));
                } else {
                  // update local caches on successful publish
                  latestValue.set(topic, payload);
                  latestRetain.set(topic, !!retain);
                  ws.send(JSON.stringify({ type: 'publish-result', success: true, topic, payload, id: obj.id, retained: !!retain, ts: Date.now() }));
                }
              });
              return;
            }
            if (obj.type === 'inventory') {
              const inv = {};
              for (const [k,v] of latestValue.entries()) {
                if (/\/(Target|Sensor)$/i.test(k)) inv[k] = v;
              }
              // include retained flags per-topic
              const invMeta = {};
              for (const k of Object.keys(inv)) invMeta[k] = { value: inv[k], retained: !!latestRetain.get(k) };
              ws.send(JSON.stringify({ type: 'inventory', data: invMeta, id: obj.id, ts: Date.now() }));
              return;
            }
            if (obj.type === 'get') {
              const topic = obj.topic;
              if (!topic) return; // ignore invalid
              // Prefer O(1) latestValue cache fallback to recentMessages search
              let payload = null;
              if (latestValue.has(topic)) payload = latestValue.get(topic);
              else {
                const found = recentMessages.find(m => m.topic === topic);
                payload = found ? found.payload : null;
              }
              if (payload === null) {
                dlog('[GET MISS]', topic, 'no cached value');
              } else {
                dlog('[GET HIT]', topic, '->', payload);
              }
              ws.send(JSON.stringify({ type: 'current', topic, payload, id: obj.id, retained: !!latestRetain.get(topic), ts: Date.now() }));
              return;
            }
          } catch (e) { /* ignore invalid messages */ }
        });
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