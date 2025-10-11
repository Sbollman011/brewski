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
  rows.forEach(r => { try { if (r && r.slug) map[String(r.slug).toUpperCase()] = r.id; else if (r) map[String(r.id)] = r.id; } catch (e) {} });
  return map;
}

function extractSlugFromTopic(topic) {
  // e.g. tele/RAIL/BREWHOUSE/STATE => RAIL
  const parts = (topic || '').split('/').filter(Boolean);
  return parts.length >= 2 ? String(parts[1]).toUpperCase() : null;
}

// Canonicalize incoming topic strings into SITE/DEVICE/STATE
// - strip leading tele/ or stat/
// - remove any trailing STATE token(s)
// - default site to BREW when omitted
// - uppercase site/device
function canonicalizeTopic(raw) {
  try {
    if (!raw) return raw;
    let s = String(raw).trim();
    s = s.replace(/^(tele|stat)\//i, '');
    const parts = s.split('/').filter(Boolean).map(p => String(p).toUpperCase());
    while (parts.length && parts[parts.length - 1] === 'STATE') parts.pop();
    if (parts.length === 0) return raw;
    let site = 'BREW';
    let device = '';
    if (parts.length === 1) {
      device = parts[0];
    } else {
      site = parts[0] || 'BREW';
      device = parts[1] || '';
    }
    site = String(site).toUpperCase();
    device = String(device).toUpperCase();
    return `${site}/${device}/STATE`;
  } catch (e) { return raw; }
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

function ensurePowerLabelPlaceholder(customerId, topic, powerKey) {
  try {
    const now = Date.now();
    // normalize powerKey casing for storage
    const pk = String(powerKey || '').toUpperCase();
    // Use INSERT OR IGNORE semantics to avoid races/duplicates
    try {
      db.prepare('INSERT INTO power_labels (customer_id, topic, power_key, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(customerId, topic, pk, '', now, now);
    } catch (e) {
      // Some older schemas may not have updated_at/created_at; try a fallback insert
      try { db.prepare('INSERT OR IGNORE INTO power_labels (customer_id, topic, power_key, label) VALUES (?, ?, ?, ?)').run(customerId, topic, pk, ''); } catch (e2) { /* ignore */ }
    }
  } catch (e) { /* ignore errors to avoid blocking ingestion */ }
}

function startPowerStateIngestor() {
  const customerMap = getCustomerSlugMap();
  let customerMapLocal = customerMap;
  const catchAllId = customerMapLocal['BREW'];
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
    // ensure we match slug keys case-insensitively by using uppercase keys
    let customerId = catchAllId;
    try {
      if (slug) {
        // refresh the map if we miss (handles newly-created customers without restart)
        if (!customerMapLocal[slug]) {
          customerMapLocal = getCustomerSlugMap();
        }
        customerId = (slug && customerMapLocal[slug]) ? customerMapLocal[slug] : catchAllId;
      }
    } catch (e) { customerId = catchAllId; }
    Object.keys(raw).forEach(k => {
        if (/^POWER(\d*)$/i.test(k)) {
          const val = raw[k] === 'ON' ? 1 : 0;
          // Use canonical topic as the sensor key/topicKey so we create/look up
          // a consistent sensor row instead of many legacy variants.
          const canonical = canonicalizeTopic(topic);
          const last = getLastPowerValue(customerId, canonical);
          // Always ensure a power_label placeholder exists so the Admin UI
          // will render an editable input for this POWER key even when the
          // reported numeric value hasn't changed.
          try { ensurePowerLabelPlaceholder(customerId, canonical, k); } catch (e) {}
          if (last === undefined || last !== val) {
            upsertPowerState(customerId, canonical, k, val, JSON.stringify(raw));
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
