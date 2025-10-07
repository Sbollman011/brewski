# mqtt-client.next.js Production Notes

This document explains how to use the enhanced `mqtt-client.next.js` for a multi-site (Raspberry Pi edge -> cloud broker) topology where each Pi publishes all local sensor topics upstream, and the cloud application needs to:

1. Aggregate all incoming telemetry.
2. Bucket / partition data by the second segment of the topic (configurable) – the "group".
3. Offer latest values and recent history per group.
4. Expose inventory and counts for UI dashboards / manager portals.

## Topic Assumptions
Default parsing uses segment index `1` (second segment) to identify the group. You can change this via:

```
process.env.MQTT_GROUP_SEGMENT_INDEX=1   # or another 0-based integer
```

Example topic: `siteA/fermenter1/Temp/Sensor`
- parts: [siteA, fermenter1, Temp, Sensor]
- group (index 1) = `fermenter1`

If your scheme is `cluster/device/...` keep index=1. If you want the first part (`siteA`) as the grouping, set index=0.

## New Capabilities Added
- Group indexing: `groupLatest`, `groupRecent`, `groupCounters` updated in O(1) on each message.
- Helper APIs:
  - `getGroups()` -> array of group ids
  - `getGroupLatest(group, { onlyTerminal })`
  - `getGroupRecent(group)`
  - `getGroupCounters()` -> { group: count }
  - `getTopicCounters()` -> per-topic message counts
  - `getGroupedInventory({ onlyTerminal })` -> { group: { topics: {...}, messageCount } }
- Event `group-message` emitted with `{ group, topic, payload, retained, seq }`.
- Backwards compatible existing APIs (`publish`, `getLatest`, etc.).

`onlyTerminal` flag filters topics ending with `/Target` or `/Sensor` (case-insensitive) to keep inventories concise.

## Migrating from `mqtt-client.js`
1. Stop importing `./mqtt-client` and instead import `./mqtt-client.next`.
2. Update any code that relied on `CONNECTION_ORDER` dual-broker failover. The next client is single-broker configurable via environment:
   - `MQTT_HOST`, `MQTT_PORT`, `MQTT_PROTOCOL` (`mqtt` or `mqtts`), credentials via `MQTT_USER` / `MQTT_PASS`.
3. If you still need dual failover, implement an external supervisor that retries with alternate env values—simpler to operate under container orchestration.
4. Ensure persistence volume mounts include the server directory if you rely on `.latest-targets.json` across restarts.

## Using with `ws-bridge`
When constructing the WebSocket bridge, pass the same instance. Example:

```js
const mqttClient = require('./mqtt-client.next');
mqttClient.start();

const { startWsBridge } = require('./ws-bridge');
startWsBridge({
  mqttClient,
  caches: {
    latestValue: mqttClient.latestValue,
    latestRetain: mqttClient.latestRetain,
    recentMessages: mqttClient.recentMessages,
    topics: mqttClient.topics,
    seenTopics: mqttClient.seenTopics,
    MAX_RECENT: mqttClient.MAX_RECENT,
    persistLatest: mqttClient.persistLatest.bind(mqttClient)
  }
});
```

Then you can extend your admin API or WS handlers to expose grouped data:

```js
// inside a request handler or WS message handler
const inv = mqttClient.getGroupedInventory();
res.end(JSON.stringify(inv));
```

## Performance & Memory
- Each message touches: global recent list (array splice when >MAX), global maps, and its group list/map.
- Complexity per message is O(1). Memory scales with number of unique topics + groups * MAX_RECENT.
- Tune `MAX_RECENT` via opts when constructing: `require('./mqtt-client.next').MAX_RECENT = 100;` (or adapt constructor if you fork).

## Recommended Hardening (See checklist bottom)
- Enable TLS to cloud broker (set `MQTT_FORCE_TLS=1` or `MQTT_PROTOCOL=mqtts`).
- Provide CA / cert / key if using mutual TLS (env: `MQTT_CA_FILE`, `MQTT_CERT_FILE`, `MQTT_KEY_FILE`).
- Constrain subscription wildcards: replace `['#', '$SYS/#']` with narrower patterns once topic set is stable, e.g. `['+/+/+/Sensor', '+/+/+/Target']`.
- Add rate limiting / alarm thresholds around sudden group explosion (future enhancement: add a max groups env variable and drop excess).

## Quick Example Endpoint
Add to `adminApi` or a new file:

```js
if (url.pathname === '/admin/api/groups/inventory') {
  const data = mqttClient.getGroupedInventory();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return void res.end(JSON.stringify(data));
}
```

Or for a single group:
```js
if (url.pathname.startsWith('/admin/api/group/')) {
  const group = url.pathname.split('/').pop();
  const data = {
    latest: mqttClient.getGroupLatest(group),
    recent: mqttClient.getGroupRecent(group).slice(0, 50)
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return void res.end(JSON.stringify(data));
}
```

## Checklist (Initial)
- [x] Group indexing
- [ ] Narrow subscriptions (post-observation)
- [ ] Central metrics export (Prometheus or simple /metrics json)
- [ ] Persistence strategy for recent/group caches if required after restart
- [ ] Max group safety limit (e.g., `MQTT_MAX_GROUPS`)
- [ ] Token-based auth enforcement on all admin endpoints
- [ ] WebSocket message rate limiting & size caps
- [ ] QoS evaluation (0 now; assess if any topics need QoS1)
- [ ] Backpressure / dropping old messages if processing lags
- [ ] Observability: log connect/disconnect, message rate per group

## Hardening Ideas
1. Add `getStats()` returning: uptime, totalMessages, groups count, avg msg/sec (sliding window).
2. Implement a rolling counter (e.g. per minute array of bucket counts) to expose peak loads.
3. Use a small LRU for groupRecent if groups become very large to bound memory.
4. Provide a pluggable storage adapter (Redis/Postgres) only if required by retention SLAs.

---
Feel free to extend this file as the implementation evolves.
