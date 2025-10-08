// power_state_ingestor.js
// Hooks into the shared MQTT client and upserts POWER states from STATE messages into the sensors table in real time.

const path = require('path');
const mqttClient = require('./mqtt-client');
const { ingestNumeric } = require('./lib/ingest');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, 'brewski.sqlite3');
const db = new Database(DB_PATH);

// Get all customer slugs and ids
function getCustomerSlugMap() {
  const rows = db.prepare('SELECT id, slug FROM customers').all();
  const map = {};
  rows.forEach(r => { map[r.slug] = r.id; });
  return map;
}

function extractSlugFromTopic(topic) {
  // e.g. tele/RAIL/BREWHOUSE/STATE => RAIL
  const parts = topic.split('/');
  return parts.length >= 2 ? parts[1] : null;
}

// Get last known value for a topic/key from sensors table
function getLastPowerValue(customerId, topic) {
  const row = db.prepare('SELECT last_value FROM sensors WHERE customer_id = ? AND key = ?').get(customerId, topic);
  return row ? row.last_value : undefined;
}

function upsertPowerState(customerId, topic, key, value, raw) {
  ingestNumeric({
    customerId,
    key: topic,
    value,
    raw,
    ts: Date.now(),
    type: key, // Set type to POWER, POWER1, etc.
    unit: null,
    topicKey: topic
  });
}

function startPowerStateIngestor() {
  const customerMap = getCustomerSlugMap();
  const catchAllId = customerMap['BREW'];
  if (!catchAllId) {
    return;
  }
  mqttClient.registerMessageHandler(({ topic, payload }) => {
    if (!/\/STATE$/.test(topic)) {
      return;
    }
    let raw;
    try { raw = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) {
      return;
    }
    const slug = extractSlugFromTopic(topic);
    const customerId = (slug && customerMap[slug]) ? customerMap[slug] : catchAllId;
    Object.keys(raw).forEach(k => {
      if (/^POWER(\d*)$/i.test(k)) {
        const val = raw[k] === 'ON' ? 1 : 0;
        const last = getLastPowerValue(customerId, topic);
        if (last === undefined || last !== val) {
          upsertPowerState(customerId, topic, k, val, JSON.stringify(raw));
          // suppressed log
        } else {
          // suppressed log
        }
      }
    });
  });
  // started silently
}

startPowerStateIngestor();
