// Future version of mqtt-client: snapshot for upcoming multi-device / refined topic strategy.
// This file is NOT loaded in production yet. Keep original mqtt-client.js unchanged.
// Differences you can stage here later:
//  - Ability to switch subscription set dynamically (setTopics)
//  - Optional narrowing from '#' to devices/+/Sensor and devices/+/Target
//  - Hook points for threshold evaluation and push notifications
//  - Metrics (messages per topic) export function

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// Centralized configuration constants with env fallbacks. Use these instead of
// sprinkling process.env throughout business logic so future refactors or
// validation can happen in one place. (If you copy this file to become the
// production mqtt-client.js, this block gives you one obvious surface to audit.)
const CONFIG = {
  DEBUG: process.env.DEBUG_BRIDGE === '1',
  GROUP_SEGMENT_INDEX: parseInt(process.env.MQTT_GROUP_SEGMENT_INDEX || '1', 10),
  PROTOCOL_RAW: (process.env.MQTT_PROTOCOL || '').toLowerCase(),
  FORCE_TLS: process.env.MQTT_FORCE_TLS === '1',
  HOST: process.env.MQTT_HOST || process.env.MQTT_BROKER_HOST || '127.0.0.1',
  PORT_OVERRIDE: process.env.MQTT_PORT || process.env.MQTT_BROKER_PORT,
  USER: process.env.MQTT_USER || process.env.MQTT_BROKER_USER || process.env.MQTT_INHHOUSE_USER || 'brokeradmin',
  PASS: process.env.MQTT_PASS || process.env.MQTT_BROKER_PASS || process.env.MQTT_INHHOUSE_PASS || 'Heyyou011!',
  CONNECT_TIMEOUT_MS: parseInt(process.env.CONNECT_TIMEOUT_MS || '5000', 10),
  RECONNECT_MIN_MS: 750,
  RECONNECT_MAX_MS: 15000,
  TLS: {
    CA_FILE: process.env.MQTT_CA_FILE,
    CERT_FILE: process.env.MQTT_CERT_FILE,
    KEY_FILE: process.env.MQTT_KEY_FILE,
    INSECURE: process.env.MQTT_TLS_INSECURE === '1'
  },
  MAX_RECENT: parseInt(process.env.MQTT_MAX_RECENT || '200', 10)
};

class NextMqttClient extends EventEmitter {
  constructor(opts = {}) {
    super();
  this.DEBUG = CONFIG.DEBUG;
    this.dlog = (...a) => { if (this.DEBUG) console.log('[mqtt.next]', ...a); };
    this.PERSIST_FILE = path.join(__dirname, '.latest-targets.json');
  this.MAX_RECENT = opts.maxRecent || CONFIG.MAX_RECENT;
    this.recentMessages = [];
    this.latestValue = new Map();
    this.latestRetain = new Map();
    this.seenTopics = new Map();
    this.totalMessages = 0;
    // Group (2nd segment) indexing: group => { latest(Map topic->payload), recent(array), counts }
    // Configure which segment constitutes the logical group. Default 1 (second path piece) so a topic
    // like site123/device7/Temp/Sensor has group=device7 if index=1.
    // Override via opts.groupSegmentIndex or env MQTT_GROUP_SEGMENT_INDEX.
    this.groupSegmentIndex = (typeof opts.groupSegmentIndex === 'number')
      ? opts.groupSegmentIndex
      : CONFIG.GROUP_SEGMENT_INDEX;
    this.groupLatest = new Map();      // group => Map(topic => payload)
    this.groupRecent = new Map();      // group => Array<{topic,payload,ts,seq,retained}>
    this.groupCounters = new Map();    // group => total message count for that group

  const protoEnv = CONFIG.PROTOCOL_RAW;
  const forceTls = CONFIG.FORCE_TLS || protoEnv === 'mqtts';
  this.protocol = forceTls ? 'mqtts' : (protoEnv || 'mqtt');
  this.host = CONFIG.HOST;
  this.port = parseInt(CONFIG.PORT_OVERRIDE || (forceTls ? '8883' : '1883'), 10);
  this.username = CONFIG.USER;
  this.password = CONFIG.PASS;

  this.CONNECT_TIMEOUT_MS = CONFIG.CONNECT_TIMEOUT_MS;
  this.RECONNECT_MIN_MS = CONFIG.RECONNECT_MIN_MS;
  this.RECONNECT_MAX_MS = CONFIG.RECONNECT_MAX_MS;
    this._reconnectAttempts = 0;

    this.tls = {};
    if (this.protocol === 'mqtts') {
  const caPath = CONFIG.TLS.CA_FILE;
  const certPath = CONFIG.TLS.CERT_FILE;
  const keyPath = CONFIG.TLS.KEY_FILE;
      try { if (caPath && fs.existsSync(caPath)) this.tls.ca = fs.readFileSync(caPath); } catch (e) {}
      try { if (certPath && fs.existsSync(certPath)) this.tls.cert = fs.readFileSync(certPath); } catch (e) {}
      try { if (keyPath && fs.existsSync(keyPath)) this.tls.key = fs.readFileSync(keyPath); } catch (e) {}
  this.tls.rejectUnauthorized = CONFIG.TLS.INSECURE ? false : true;
      if (this.DEBUG) this.dlog('TLS config:', { ca: !!this.tls.ca, cert: !!this.tls.cert, key: !!this.tls.key, rejectUnauthorized: this.tls.rejectUnauthorized });
    }

    // Start wide, allow narrowing later.
    this.topics = opts.topics || ['#', '$SYS/#'];
    this.client = null;
  }

  start() { this.loadPersisted(); this._connect(); }

  _connect() {
    const url = `${this.protocol}://${this.host}:${this.port}`;
    const baseOpts = {
      username: this.username,
      password: this.password,
      connectTimeout: this.CONNECT_TIMEOUT_MS,
      reconnectPeriod: 0,
      protocolVersion: 4
    };
    if (this.protocol === 'mqtts') Object.assign(baseOpts, this.tls);
    this.dlog('Connecting (next) to broker', url);
    this.client = mqtt.connect(url, baseOpts);
    this.attachClientHandlers(this.client);
    this.client.on('error', err => { console.error('MQTT(next) error:', err && err.message ? err.message : err); this._scheduleReconnect(); });
    this.client.on('close', () => { this.dlog('MQTT(next) closed'); this._scheduleReconnect(); });
  }

  _scheduleReconnect() {
    if (!this.client || this.client.connected) return;
    try { this.client.end(true); } catch (e) {}
    const attempt = ++this._reconnectAttempts;
    const delay = Math.min(this.RECONNECT_MAX_MS, this.RECONNECT_MIN_MS * Math.pow(2, attempt - 1));
    this.dlog(`Reconnect (next) attempt ${attempt} in ${delay}ms`);
    setTimeout(() => this._connect(), delay);
  }

  attachClientHandlers(c) {
    c.on('connect', () => {
      this._reconnectAttempts = 0;
      const brokerUrl = `${this.protocol}://${this.host}:${this.port}`;
      this.emit('connect', { brokerUrl });
      const subs = Array.isArray(this.topics) ? this.topics.slice() : ['#'];
      subs.forEach(t => c.subscribe(t, { qos: 0 }, err => { if (err) console.error('[next] subscribe error', t, err); else this.dlog('[next] subscribed', t); }));
    });

    c.on('message', (topic, message, packet) => {
      try {
        this.totalMessages += 1;
        this.seenTopics.set(topic, (this.seenTopics.get(topic) || 0) + 1);
        const payload = message.toString();
        const retained = !!(packet && packet.retain);
        this.recentMessages.unshift({ topic, payload, seq: this.totalMessages, ts: Date.now(), retained });
        this.latestValue.set(topic, payload);
        this.latestRetain.set(topic, retained);
        if (this.recentMessages.length > this.MAX_RECENT) this.recentMessages.splice(this.MAX_RECENT);
        if (/\/(Target|Sensor)$/i.test(topic)) this.persistLatest();
        // Group indexing
        const group = this._extractGroup(topic);
        if (group) {
          if (!this.groupLatest.has(group)) this.groupLatest.set(group, new Map());
          if (!this.groupRecent.has(group)) this.groupRecent.set(group, []);
          const gLatest = this.groupLatest.get(group);
          gLatest.set(topic, payload);
          const gRecent = this.groupRecent.get(group);
          gRecent.unshift({ topic, payload, seq: this.totalMessages, ts: Date.now(), retained });
          if (gRecent.length > this.MAX_RECENT) gRecent.splice(this.MAX_RECENT);
          this.groupCounters.set(group, (this.groupCounters.get(group) || 0) + 1);
          this.emit('group-message', { group, topic, payload, retained, seq: this.totalMessages });
        }
        this.emit('message', { topic, payload, seq: this.totalMessages, retained });
      } catch (e) { console.error('next mqtt message error', e && e.stack ? e.stack : e); }
    });
  }

  setTopics(list) {
    if (!Array.isArray(list) || !list.length) return;
    this.topics = list.slice();
    if (this.client && this.client.connected) {
      list.forEach(t => this.client.subscribe(t, { qos: 0 }, err => { if (err) console.error('[next] subscribe error', t, err); }));
    }
  }

  publish(topic, payload, opts = {}, cb) {
    if (!this.client) return cb && cb(new Error('not-connected'));
    const retain = !!opts.retain;
    this.client.publish(topic, String(payload), { qos: 0, retain }, err => {
      if (!err && /\/(Target)$/.test(topic)) {
        this.latestValue.set(topic, String(payload));
        this.latestRetain.set(topic, retain);
        this.persistLatest();
      }
      if (cb) cb(err);
    });
  }

  getLatest(topic) { return this.latestValue.has(topic) ? this.latestValue.get(topic) : null; }
  getRecent() { return Array.from(this.recentMessages); }
  getSeenTopics() { return Array.from(this.seenTopics.keys()); }

  // Group / segmentation helpers
  _extractGroup(topic) {
    if (!topic || typeof topic !== 'string') return null;
    // Fast path: avoid split for very short topics
    const idx = this.groupSegmentIndex;
    if (idx < 0) return null;
    const parts = topic.split('/');
    if (parts.length <= idx) return null;
    const seg = parts[idx];
    if (!seg) return null;
    // Ignore MQTT $SYS topics
    if (seg.startsWith('$SYS')) return null;
    return seg;
  }

  getGroups() { return Array.from(this.groupLatest.keys()); }

  getGroupLatest(group, { onlyTerminal = true } = {}) {
    const g = this.groupLatest.get(group);
    if (!g) return {};
    const out = {};
    for (const [t, v] of g.entries()) {
      if (!onlyTerminal || /\/(Target|Sensor)$/i.test(t)) out[t] = v;
    }
    return out;
  }

  getGroupRecent(group) { return this.groupRecent.has(group) ? Array.from(this.groupRecent.get(group)) : []; }

  getGroupCounters() {
    const out = {};
    for (const [g,c] of this.groupCounters.entries()) out[g] = c;
    return out;
  }

  getTopicCounters() {
    const out = {};
    for (const [t,c] of this.seenTopics.entries()) out[t] = c;
    return out;
  }

  // Aggregated inventory keyed by group => { topics: {...}, messageCount }
  getGroupedInventory({ onlyTerminal = true } = {}) {
    const inv = {};
    for (const g of this.getGroups()) {
      inv[g] = {
        topics: this.getGroupLatest(g, { onlyTerminal }),
        messageCount: this.groupCounters.get(g) || 0
      };
    }
    return inv;
  }

  // Lightweight snapshot for WebSocket bridge or REST: returns { totalMessages, groups, topics }
  // without dumping entire recent arrays (to keep payload small). Caller can request
  // deeper detail per group with getGroupLatest/getGroupRecent.
  snapshotSummary() {
    return {
      ts: Date.now(),
      totalMessages: this.totalMessages,
      groupCount: this.groupLatest.size,
      groups: this.getGroups(),
      topicCount: this.seenTopics.size
    };
  }

  persistLatest() {
    try {
      const out = {};
      for (const [k,v] of this.latestValue.entries()) {
        if (/\/(Target|Sensor)$/i.test(k)) out[k] = v;
      }
      fs.writeFileSync(this.PERSIST_FILE, JSON.stringify(out));
    } catch (e) {}
  }

  loadPersisted() {
    try {
      if (fs.existsSync(this.PERSIST_FILE)) {
        const raw = fs.readFileSync(this.PERSIST_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') Object.entries(obj).forEach(([k,v]) => { if (typeof v === 'string') this.latestValue.set(k, v); });
        this.dlog('[next] loaded persisted keys', this.latestValue.size);
      }
    } catch (e) { this.dlog('[next] persist load error', e && e.message); }
  }
}

module.exports = new NextMqttClient();
