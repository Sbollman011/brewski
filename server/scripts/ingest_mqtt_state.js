// ingest_mqtt_state.js
// Usage: node ingest_mqtt_state.js
// Connects to MQTT, fetches all retained STATE topics, and upserts POWER keys into the sensors table for the correct customer.

const mqtt = require('mqtt');
const path = require('path');
const { ingestNumeric } = require('../lib/ingest');
const Database = require('better-sqlite3');

const MQTT_HOST = process.env.MQTT_HOST || 'mqtt.brewingremote.com';
const MQTT_PORT = process.env.MQTT_PORT || 8883;
const MQTT_USER = process.env.MQTT_USER || 'brokeradmin';
const MQTT_PASS = process.env.MQTT_PASS || 'Heyyou011!';
const MQTT_URL = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;

const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
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

function main() {
  const customerMap = getCustomerSlugMap();
  const catchAllId = customerMap['BREW'];
  if (!catchAllId) {
    console.error('No BREW customer found for catch-all. Aborting.');
    process.exit(1);
  }
  const client = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    rejectUnauthorized: false
  });
  client.on('connect', () => {
    console.log('Connected to MQTT. Subscribing to +/+/+/STATE ...');
    client.subscribe('+/+/+/STATE', { qos: 0 }, (err) => {
      if (err) { console.error('Subscribe error:', err); process.exit(1); }
    });
  });
  client.on('message', (topic, message) => {
    let raw;
    try { raw = JSON.parse(message.toString()); } catch (e) { return; }
    const slug = extractSlugFromTopic(topic);
    const customerId = (slug && customerMap[slug]) ? customerMap[slug] : catchAllId;
    // For each POWER key, upsert as a sensor
    Object.keys(raw).forEach(k => {
      if (/^POWER(\d*)$/i.test(k)) {
        ingestNumeric({
          customerId,
          key: topic,
          value: raw[k] === 'ON' ? 1 : 0,
          raw: message.toString(),
          ts: Date.now(),
          type: 'power',
          unit: null,
          topicKey: topic
        });
        console.log(`Upserted: customer=${customerId} topic=${topic} key=${k} value=${raw[k]}`);
      }
    });
  });
  // Wait for a few seconds to receive retained messages, then exit
  setTimeout(() => {
    client.end();
    db.close();
    console.log('Done.');
    process.exit(0);
  }, 8000);
}

main();
