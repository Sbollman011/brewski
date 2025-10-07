const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class MqttClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.DEBUG = process.env.DEBUG_BRIDGE === '1';
    this.dlog = (...a) => { if (this.DEBUG) console.log(...a); };
    this.PERSIST_FILE = path.join(__dirname, '.latest-targets.json');
    this.MAX_RECENT = opts.maxRecent || 200;
    this.recentMessages = [];
    this.latestValue = new Map();
    this.latestRetain = new Map();
    this.seenTopics = new Map();
    this.totalMessages = 0;
    this.pushTokens = new Set();

    // connection order and configs copied from original file for parity
    this.CONNECTION_ORDER = ['INHHOUSE', 'VMBEER'];
    this.currentConnIndex = 0;
    this.connectionName = this.CONNECTION_ORDER[this.currentConnIndex];
    this.CONNECT_TIMEOUT_MS = process.env.CONNECT_TIMEOUT_MS ? parseInt(process.env.CONNECT_TIMEOUT_MS, 10) : 3000;

    this.configs = {
      INHHOUSE: {
        host: '10.0.0.17', port: 1883, protocol: 'mqtt',
        username: process.env.MQTT_INHHOUSE_USER || 'billy',
        password: process.env.MQTT_INHHOUSE_PASS || 'Ilov3b33r'
      },
      VMBEER: {
        host: 'mqtt.brewingremote.com', port: 8883, protocol: 'mqtts',
        username: process.env.MQTT_VMBEER_USER || 'bridgebrewremote',
        password: process.env.MQTT_VMBEER_PASS || 'Heyyou011!'
      }
    };

    this.topics = opts.topics || [ '#', '$SYS/#' ];

    this.client = null;
  }

  start() {
    this.tryConnect();
  }

  tryConnect() {
    this.connectionName = this.CONNECTION_ORDER[this.currentConnIndex];
    this.cfg = this.configs[this.connectionName];
    this.brokerUrl = `${this.cfg.protocol}://${this.cfg.host}:${this.cfg.port}`;
    this.dlog('Attempting MQTT connection:', this.connectionName, '->', this.brokerUrl);
    this.client = mqtt.connect(this.brokerUrl, { username: this.cfg.username, password: this.cfg.password, connectTimeout: this.CONNECT_TIMEOUT_MS, reconnectPeriod: 0 });

    this.attachClientHandlers(this.client);

    this.client.on('error', err => {
      console.error(`MQTT connection error for ${this.connectionName}:`, err && err.message ? err.message : err);
      try { this.client.end(true); } catch (e) {}
      this.currentConnIndex += 1;
      if (this.currentConnIndex >= this.CONNECTION_ORDER.length) {
        console.error('All MQTT connection attempts failed. Emitting error and stopping.');
        this.emit('error', new Error('mqtt-all-connections-failed'));
        return;
      }
      console.log('Falling back to next connection:', this.CONNECTION_ORDER[this.currentConnIndex]);
      setTimeout(() => this.tryConnect(), 1000);
    });
  }

  attachClientHandlers(c) {
    c.on('connect', () => {
      this.emit('connect', { connectionName: this.connectionName, brokerUrl: this.brokerUrl });
      // subscribe to discovery topics
      const subscribeList = Array.isArray(this.topics) ? this.topics.slice() : ['#', '$SYS/#'];
      subscribeList.forEach(t => c.subscribe(t, { qos: 0 }, err => { if (err) console.error('Subscription error for', t, err); else this.dlog('Subscribed to', t); }));
    });

    c.on('message', (topic, message, packet) => {
      try {
        this.totalMessages += 1;
        const count = (this.seenTopics.get(topic) || 0) + 1;
        this.seenTopics.set(topic, count);
        const payload = message.toString();
        const isRetained = packet && packet.retain ? true : false;
        this.recentMessages.unshift({ topic, payload, seq: this.totalMessages, ts: Date.now(), retained: isRetained });
        this.latestValue.set(topic, payload);
        this.latestRetain.set(topic, !!isRetained);
        if (this.recentMessages.length > this.MAX_RECENT) this.recentMessages.splice(this.MAX_RECENT);
        if (/\/(Target|Sensor)$/i.test(topic)) this.persistLatest();
        this.emit('message', { topic, payload, seq: this.totalMessages, retained: isRetained });
        if (count === 1) this.emit('new-topic', topic);
      } catch (e) { console.error('mqtt-client message handler error', e && e.stack ? e.stack : e); }
    });
  }

  publish(topic, payload, opts = {}, cb) {
    if (!this.client) return cb ? cb(new Error('not-connected')) : null;
    const retain = !!opts.retain;
    this.client.publish(topic, String(payload), { qos: 0, retain }, err => {
      if (!err) {
        if (/\/(Target)$/.test(topic)) {
          this.latestValue.set(topic, String(payload));
          this.latestRetain.set(topic, !!retain);
          this.persistLatest();
        }
      }
      if (cb) cb(err);
    });
  }

  getLatest(topic) { return this.latestValue.has(topic) ? this.latestValue.get(topic) : null; }
  getRecent() { return Array.from(this.recentMessages); }
  getSeenTopics() { return Array.from(this.seenTopics.keys()); }

  persistLatest() {
    try {
      const toWrite = {};
      for (const [k,v] of this.latestValue.entries()) {
        if (/\/(Target|Sensor)$/i.test(k)) toWrite[k] = v;
      }
      fs.writeFileSync(this.PERSIST_FILE, JSON.stringify(toWrite));
    } catch (e) { /* ignore persist error */ }
  }

  loadPersisted() {
    try {
      if (fs.existsSync(this.PERSIST_FILE)) {
        const raw = fs.readFileSync(this.PERSIST_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          Object.entries(obj).forEach(([k,v]) => { if (typeof v === 'string') this.latestValue.set(k, v); });
          this.dlog('Loaded persisted latest values:', Object.keys(obj).length);
        }
      }
    } catch (e) { this.dlog('Persist load error', e && e.message); }
  }
}

module.exports = new MqttClient();
