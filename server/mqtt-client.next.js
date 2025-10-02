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

class NextMqttClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.DEBUG = process.env.DEBUG_BRIDGE === '1';
    this.dlog = (...a) => { if (this.DEBUG) console.log('[mqtt.next]', ...a); };
    this.PERSIST_FILE = path.join(__dirname, '.latest-targets.json');
    this.MAX_RECENT = opts.maxRecent || 200;
    this.recentMessages = [];
    this.latestValue = new Map();
    this.latestRetain = new Map();
    this.seenTopics = new Map();
    this.totalMessages = 0;

    const protoEnv = (process.env.MQTT_PROTOCOL || '').toLowerCase();
    const forceTls = process.env.MQTT_FORCE_TLS === '1' || protoEnv === 'mqtts';
    this.protocol = forceTls ? 'mqtts' : (protoEnv || 'mqtt');
    this.host = process.env.MQTT_HOST || process.env.MQTT_BROKER_HOST || '127.0.0.1';
    this.port = parseInt(process.env.MQTT_PORT || process.env.MQTT_BROKER_PORT || (forceTls ? '8883' : '1883'), 10);
    this.username = process.env.MQTT_USER || process.env.MQTT_BROKER_USER || process.env.MQTT_INHHOUSE_USER || 'billy';
    this.password = process.env.MQTT_PASS || process.env.MQTT_BROKER_PASS || process.env.MQTT_INHHOUSE_PASS || 'Ilov3b33r';

    this.CONNECT_TIMEOUT_MS = process.env.CONNECT_TIMEOUT_MS ? parseInt(process.env.CONNECT_TIMEOUT_MS, 10) : 5000;
    this.RECONNECT_MIN_MS = 750;
    this.RECONNECT_MAX_MS = 15000;
    this._reconnectAttempts = 0;

    this.tls = {};
    if (this.protocol === 'mqtts') {
      const caPath = process.env.MQTT_CA_FILE;
      const certPath = process.env.MQTT_CERT_FILE;
      const keyPath = process.env.MQTT_KEY_FILE;
      try { if (caPath && fs.existsSync(caPath)) this.tls.ca = fs.readFileSync(caPath); } catch (e) {}
      try { if (certPath && fs.existsSync(certPath)) this.tls.cert = fs.readFileSync(certPath); } catch (e) {}
      try { if (keyPath && fs.existsSync(keyPath)) this.tls.key = fs.readFileSync(keyPath); } catch (e) {}
      this.tls.rejectUnauthorized = process.env.MQTT_TLS_INSECURE === '1' ? false : true;
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
