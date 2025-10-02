const mqtt = require('mqtt');

// Upstream (your central broker)
const upstream = mqtt.connect('mqtts://mqtt.brewingremote.com:8883', {
  username: 'bridgeuser',
  password: 'bridgepass',
  // If the runtime trusts public CAs, you usually don’t need ca:
  // ca: fs.readFileSync('isrg-root-x1.pem')
});

// Optional: local broker to mirror into (plain localhost)
const local = mqtt.connect('mqtt://127.0.0.1:1883');

upstream.on('connect', () => {
  console.log('Connected to upstream');
  upstream.subscribe('#', err => {
    if (err) console.error('Sub error', err);
    else console.log('Subscribed to all');
  });
});

upstream.on('message', (topic, payload, packet) => {
  // Mirror message into local broker or process it
  local.publish(topic, payload, { retain: packet.retain, qos: packet.qos });
});

// (Optional) Forward local -> upstream too:
local.on('connect', () => {
  local.subscribe('#');
});
local.on('message', (topic, payload, packet) => {
  upstream.publish(topic, payload, { retain: packet.retain, qos: packet.qos });
});