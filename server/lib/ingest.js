// ingest.js
// Centralized MQTT -> DB ingestion logic for sensors & telemetry latest snapshot caching.
// SQLite (better-sqlite3) based implementation.
// Responsibilities:
//  - Resolve sensor (customer_id + key) creating if necessary
//  - Apply write throttling (interval + delta) before inserting telemetry row
//  - Always update cached last_value/last_ts/last_raw if newer
//  - Return structured info for callers (sensorId, insertedTelemetry:boolean)

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');

// Lazy singleton DB (better-sqlite3 is synchronous & safe in single process usage context)
let dbInstance = null;
function db() { if (!dbInstance) dbInstance = new Database(DB_PATH); return dbInstance; }

// Simple prepared statements cache
const stmts = {};
function prep(key, sql) { if (!stmts[key]) stmts[key] = db().prepare(sql); return stmts[key]; }

// Throttling configuration
const MIN_INTERVAL_MS = Number(process.env.TELEMETRY_MIN_INTERVAL_MS || 5000); // 5s default
const MIN_DELTA = Number(process.env.TELEMETRY_MIN_DELTA || 0.05); // 0.05 units default

// In-memory last written (for throttling) keyed by sensor_id
const lastWrite = new Map(); // sensor_id -> { ts, value }

function ensureSensor(customerId, key, opts = {}) {
  const now = Date.now();
  const { type = null, unit = null, topicKey = null } = opts;
  // Attempt fetch
  // First try exact match
  let row = prep('selSensor', 'SELECT id, last_ts, last_value FROM sensors WHERE customer_id=? AND key=?').get(customerId, key);
  if (row) return row;
  // Try case-insensitive match on key
  try {
    row = prep('selSensor_ci', 'SELECT id, last_ts, last_value FROM sensors WHERE customer_id=? AND UPPER(key)=?').get(customerId, String(key).toUpperCase());
    if (row) return row;
  } catch (e) { /* ignore if UPPER(key) not supported or column missing */ }
  // Try matching on topic_key if provided (newer schema)
  if (topicKey) {
    try {
      row = prep('selSensor_by_topic', 'SELECT id, last_ts, last_value FROM sensors WHERE customer_id=? AND topic_key = ?').get(customerId, topicKey);
      if (row) return row;
    } catch (e) { /* ignore if topic_key not present */ }
    try {
      row = prep('selSensor_by_topic_ci', 'SELECT id, last_ts, last_value FROM sensors WHERE customer_id=? AND UPPER(topic_key) = ?').get(customerId, String(topicKey).toUpperCase());
      if (row) return row;
    } catch (e) { /* ignore */ }
  }
  // Create (ignore errors if conflict due to race)
  try {
    prep('insSensor', 'INSERT INTO sensors (customer_id, key, topic_key, type, unit, created_at) VALUES (?,?,?,?,?,?)')
      .run(customerId, key, topicKey, type, unit, now);
  } catch (e) { /* ignore */ }
  row = prep('selSensor2', 'SELECT id, last_ts, last_value FROM sensors WHERE customer_id=? AND key=?').get(customerId, key);
  return row;
}

function shouldInsertTelemetry(sensorId, value, ts) {
  if (MIN_INTERVAL_MS <= 0 && MIN_DELTA <= 0) return true;
  const prev = lastWrite.get(sensorId);
  if (!prev) return true;
  if (ts - prev.ts < MIN_INTERVAL_MS) {
    if (Math.abs(Number(value) - Number(prev.value)) < MIN_DELTA) return false;
  }
  return true;
}

function recordWrite(sensorId, value, ts) { lastWrite.set(sensorId, { value: Number(value), ts }); }

function ingestNumeric({ customerId, key, value, raw, ts = Date.now(), type = null, unit = null, topicKey = null }) {
  // Allow disabling telemetry writes entirely via env var for dev/testing
  if (process.env.DISABLE_TELEMETRY === '1') {
    // Still ensure sensor exists but do not insert telemetry rows or update latest
    try {
      const sensor = ensureSensor(customerId, key, { type, unit, topicKey });
      return { ok: true, sensorId: sensor ? sensor.id : null, inserted: false, disabled: true };
    } catch (e) {
      return { ok: false, reason: 'disabled_error', sensorId: null, inserted: false };
    }
  }
  if (value === null || value === undefined || isNaN(Number(value))) {
    return { ok: false, reason: 'non_numeric', sensorId: null, inserted: false };
  }
  const v = Number(value);
  const sensor = ensureSensor(customerId, key, { type, unit, topicKey });
  if (!sensor || !sensor.id) return { ok: false, reason: 'no_sensor', sensorId: null, inserted: false };
  const sensorId = sensor.id;
  const doInsert = shouldInsertTelemetry(sensorId, v, ts);
  if (doInsert) {
    try {
      prep('insTele', 'INSERT INTO telemetry (sensor_id, ts, value, raw, created_at) VALUES (?,?,?,?,?)')
        .run(sensorId, ts, v, raw || null, Date.now());
      recordWrite(sensorId, v, ts);
    } catch (e) { /* swallow insert errors */ }
  }
  // Update cached latest if newer
  try {
    prep('updLatest', 'UPDATE sensors SET last_value=?, last_ts=?, last_raw=? WHERE id=? AND (last_ts IS NULL OR ? > last_ts)')
      .run(v, ts, raw || null, sensorId, ts);
  } catch (e) {}
  return { ok: true, sensorId, inserted: doInsert };
}

module.exports = { ingestNumeric };
