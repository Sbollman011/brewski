#!/usr/bin/env node
// Composed brewski server bootstrap
// Starts MQTT client, HTTP(S) server, and WebSocket bridge.

const path = require('path');
const mqttClient = require('../server/mqtt-client');
const { startHttpServer } = require('../server/http-server');
const { startWsBridge } = require('../server/ws-bridge');

function main() {
  // Load persisted MQTT latest values if available
  try { mqttClient.loadPersisted && mqttClient.loadPersisted(); } catch (e) {}


  mqttClient.on('connect', info => {
    console.log('[mqtt] connected via', info.connectionName, info.brokerUrl);
  });
  mqttClient.on('message', () => { /* broadcast handled by ws-bridge via shared caches */ });
  mqttClient.on('error', err => {
    console.error('[mqtt] fatal error', err && err.message ? err.message : err);
  });
  mqttClient.start();

  // Start power state ingestion after mqttClient is ready (no circular dependency)
  try { require('../server/power_state_ingestor'); } catch (e) { console.error('[server.js] Failed to start power_state_ingestor:', e && e.message); }

  // Start HTTP server first (so WS upgrades can attach)
  const http = startHttpServer({});

  // Shared caches for ws-bridge broadcast (read from mqtt-client instance)
  const caches = {
    latestValue: mqttClient.latestValue,
    latestRetain: mqttClient.latestRetain,
    recentMessages: mqttClient.recentMessages,
    topics: mqttClient.topics,
    seenTopics: mqttClient.seenTopics,
    MAX_RECENT: mqttClient.MAX_RECENT,
    persistLatest: () => mqttClient.persistLatest && mqttClient.persistLatest(),
  };

  const ws = startWsBridge({
    delegatedHttp: http,
    publishFn: (topic, payload, opts, cb) => mqttClient.publish(topic, payload, opts, cb),
    mqttClient,
   // caches,
  });

  // Periodic persistence of latest metrics
  setInterval(() => { try { mqttClient.persistLatest(); } catch (e) {} }, 30_000);

  // Graceful shutdown
  function shutdown(sig) {
    console.log('Received', sig, 'shutting down...');
    try { mqttClient.persistLatest(); } catch(e){}
    try { ws.wss && ws.wss.clients && ws.wss.clients.forEach(c => { try { c.close(); } catch(e){} }); } catch(e){}
    try { http.server && http.server.close(()=> process.exit(0)); } catch(e) { process.exit(0); }
    setTimeout(()=>process.exit(0), 3000);
  }
  ['SIGINT','SIGTERM'].forEach(s => process.on(s, () => shutdown(s)));
}

if (require.main === module) {
  main();
}

module.exports = { main };
