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
// - require explicit site (do NOT default to BREW)
// - uppercase site/device
function canonicalizeTopic(raw) {
  try {
    if (!raw) return raw;
    let s = String(raw).trim();
    s = s.replace(/^(tele|stat)\//i, '');
    const parts = s.split('/').filter(Boolean).map(p => String(p).toUpperCase());
    while (parts.length && parts[parts.length - 1] === 'STATE') parts.pop();
    // Require explicit site; if only device is present (legacy no-site), return null
    if (parts.length < 2) return null;
    let site = parts[0];
    let device = parts[1] || '';
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
  try {
    // Use a sensor key that omits the trailing /STATE so legacy rows (e.g., "RAIL/BREWHOUSE")
    // are reused instead of creating STATE-suffixed duplicates. Keep canonical topic in topicKey.
    const keyBase = String(topic).replace(/\/STATE$/i, '');
    // If sensors already contain a last_raw JSON blob for this keyBase, merge
    // the incoming raw object into it so we don't clobber other POWERn keys
    // when a single-key stat message arrives (e.g. { POWER2: 'OFF' }).
    let mergedRaw = raw;
    try {
      // fetch existing last_raw for this sensor (if any)
      const row = db.prepare('SELECT last_raw FROM sensors WHERE customer_id = ? AND key = ?').get(customerId, keyBase);
      if (row && row.last_raw) {
        try {
          const existing = (typeof row.last_raw === 'string') ? JSON.parse(row.last_raw) : row.last_raw;
          const incoming = (typeof raw === 'string') ? JSON.parse(raw) : raw;
          if (existing && typeof existing === 'object' && incoming && typeof incoming === 'object') {
            const merged = Object.assign({}, existing, incoming);
            mergedRaw = JSON.stringify(merged);
          }
        } catch (e) {
          // if parsing fails, fall back to using the incoming raw as-is
          mergedRaw = raw;
        }
      }
    } catch (e) {
      mergedRaw = raw;
    }

    ingestNumeric({
      customerId,
      key: keyBase,
      value,
      raw: mergedRaw,
      ts: Date.now(),
      type: key, // Set type to POWER, POWER1, etc.
      unit: null,
      topicKey: topic
    });
    if (process.env.DEBUG_BRIDGE === '1') {
      try {
        const row = db.prepare('SELECT id, key, topic_key, last_value, last_ts FROM sensors WHERE customer_id = ? AND key = ?').get(customerId, keyBase);
        console.debug('power_state_ingestor: post-upsert sensor row', { customerId, keyBase, row });
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.error('power_state_ingestor: upsertPowerState exception', e && e.message ? e.message : e);
  }
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
  // TEMP DEBUG: force debug mode on during active troubleshooting so logs are emitted.
  // Remove or change this after debugging to avoid noisy logs in production.
  try { if (!process.env.DEBUG_BRIDGE) process.env.DEBUG_BRIDGE = '1'; } catch (e) {}
  const customerMap = getCustomerSlugMap();
  let customerMapLocal = customerMap;
  mqttClient.registerMessageHandler(({ topic, payload }) => {
    // Handle both tele/.../STATE JSON messages and per-key stat/.../POWER or stat/.../POWER1 topics
    let raw = null;
    let fromStat = false;
      try {
      if (/\/STATE$/.test(topic)) {
        if (typeof payload === 'string') {
          // Try to parse JSON first; if it fails, attempt to extract POWER keys
          try {
            raw = JSON.parse(payload);
          } catch (e) {
            // payload is not valid JSON — attempt to extract POWER<n> entries like "POWER1:ON" or "POWER1 ON" or "POWER1=ON"
            const obj = {};
            const re = /(POWER\d*)[^A-Z0-9\-\_]*(ON|OFF|1|0|TRUE|FALSE)/ig;
            let m;
            while ((m = re.exec(payload))) {
              try {
                const pk = String(m[1]).toUpperCase();
                const pv = String(m[2]).toUpperCase();
                obj[pk] = (/^(ON|1|TRUE)$/i.test(pv) ? 'ON' : 'OFF');
              } catch (e2) { }
            }
            if (Object.keys(obj).length) {
              raw = obj;
            } else {
              // keep raw as the original string so we can optionally store it, but
              // do not attempt object iteration below
              raw = payload;
            }
          }
        } else {
          raw = payload;
        }
      } else {
        // Check for stat/.../POWER or stat/.../POWERn pattern where payload is ON/OFF/1/0
        const parts = (topic || '').split('/').filter(Boolean);
        if (parts.length >= 3 && parts[0].toLowerCase() === 'stat' && /^POWER\d*$/i.test(parts[parts.length - 1])) {
          const powerKey = parts[parts.length - 1];
          const device = parts.length >= 4 ? parts[2] : parts[1];
          const site = parts.length >= 4 ? parts[1] : null;
          const val = (typeof payload === 'string') ? String(payload).trim().toUpperCase() : (typeof payload === 'number' ? String(payload) : '');
          const isOn = (val === 'ON' || val === '1' || val === 'TRUE') ? 1 : 0;
          // Synthesize a STATE-like raw object so downstream logic can reuse canonical handlers
          raw = {};
          raw[powerKey] = isOn ? 'ON' : 'OFF';
          // Only synthesize a canonical topic if an explicit site is present.
          if (!site) {
            // Legacy no-site stat topic; ignore under new policy
            return;
          }
          // rewrite topic into canonical tele/<site>/<device>/STATE form for ingestion
          const canonicalTopic = `tele/${site}/${device}/STATE`;
          if (process.env.DEBUG_BRIDGE === '1') console.debug('power_state_ingestor: stat->STATE synth', { incoming: topic, canonicalTopic, powerKey, payload, synthesized: raw });
          topic = canonicalTopic;
          fromStat = true;
        } else {
          return; // not a POWER-bearing message we care about
        }
      }
    } catch (e) {
      return;
    }
  const slug = extractSlugFromTopic(topic);
  // Require explicit site (slug) and a matching customer mapping; otherwise ignore
  if (!slug) return;
  let customerId = null;
  try {
    if (!customerMapLocal[slug]) customerMapLocal = getCustomerSlugMap();
    customerId = (slug && customerMapLocal[slug]) ? customerMapLocal[slug] : null;
  } catch (e) { customerId = null; }
  if (!customerId) return;
    Object.keys(raw).forEach(k => {
        if (/^POWER(\d*)$/i.test(k)) {
          const val = raw[k] === 'ON' ? 1 : 0;
          // Use canonical topic as the sensor key/topicKey so we create/look up
          // a consistent sensor row instead of many legacy variants.
          let canonical = canonicalizeTopic(topic);
          if (!canonical) return; // skip legacy no-site variants
          // Use the same sensor key that upsertPowerState/ingestNumeric will write: strip trailing /STATE
          let keyBase = String(canonical).replace(/\/STATE$/i, '');

          // (Removed legacy remapping to BREW/<device> — we now require explicit site and keep site-scoped keys.)
          // Read last_value and last_ts for debugging to decide why we may skip upserts
          let lastRow = null;
          try {
            lastRow = db.prepare('SELECT last_value, last_ts FROM sensors WHERE customer_id = ? AND key = ?').get(customerId, keyBase);
          } catch (e) { lastRow = null; }
          const last = lastRow ? lastRow.last_value : undefined;
          const lastTs = lastRow ? lastRow.last_ts : null;
          // Always ensure a power_label placeholder exists so the Admin UI
          // will render an editable input for this POWER key even when the
          // reported numeric value hasn't changed.
          try { ensurePowerLabelPlaceholder(customerId, canonical, k); } catch (e) {}
          if (process.env.DEBUG_BRIDGE === '1') console.debug('power_state_ingestor: will upsert?', { customerId, canonical, keyBase, powerKey: k, newVal: val, last, lastTs, fromStat });
          // Always upsert when we don't have a last value, the value changed,
          // or the incoming message was a stat/... topic — stat topics are non-mutating
          // probes and we want to refresh last_ts/last_raw even if the numeric
          // value is identical so clients see the fresh timestamp.
          if (last === undefined || last !== val || fromStat) {
            try {
              upsertPowerState(customerId, canonical, k, val, JSON.stringify(raw));
              if (process.env.DEBUG_BRIDGE === '1') console.debug('power_state_ingestor: upserted', { customerId, canonical, powerKey: k, newVal: val });
            } catch (e) {
              console.error('power_state_ingestor: upsert error', e && e.message ? e.message : e);
            }
          } else {
            if (process.env.DEBUG_BRIDGE === '1') console.debug('power_state_ingestor: skipped upsert (no change)', { customerId, canonical, powerKey: k, newVal: val, last });
          }
        }
    });
  });
  // started silently
}

startPowerStateIngestor();
