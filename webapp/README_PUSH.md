# Push Notification Setup (Brew Remote)

This guide explains how the new phone push notifications work.

## Overview
The server (`server/mttq-connector.js`) now:
- Accepts device Expo push tokens via `POST /register-push` (JSON: `{ "token": "ExponentPushToken[...]" }`).
- Persists tokens in `.push-tokens.json`.
- Monitors MQTT topics ending in `.../Sensor` and applies built‑in threshold rules:
  * Fermentation: 60–80°F (`/FERM\d+/Sensor`)
  * Mash: 148–162°F (`/MASH.../Sensor`)
  * Boil: 200–220°F (`/BOIL.../Sensor`)
- Sends a push when a value leaves the allowed range (with 30‑minute cooldown per topic) and another when it returns to normal (15‑minute cooldown for restore messages).

## Client (Expo / React Native)
`App.js` registers for notifications on mount (real devices only) and POSTs the Expo token to the bridge at `http://<YOUR_LAN_IP>:8080/register-push`.

Adjust the host in `App.js` if your server runs elsewhere.

## Customizing Thresholds
Edit the `THRESHOLDS` array in `server/mttq-connector.js`:
```js
const THRESHOLDS = [
  { match:/FERM\d+\/Sensor$/i, min:60, max:80, label:'Fermentation' },
  { match:/MASH.*\/Sensor$/i, min:148, max:162, label:'Mash' },
  { match:/BOIL.*\/Sensor$/i, min:200, max:220, label:'Boil' }
];
```
Add or adjust objects. `match` is a RegExp tested against the full topic string.

## Token Management
- Tokens are appended; no pruning yet. Clear by deleting `.push-tokens.json` while server stopped.
- Duplicate tokens are de‑duplicated internally.

## Testing Push
1. Run server: `node mttq-connector.js`
2. Open the mobile app on a physical device (Expo Go).
3. Ensure you see no permission error (allow notifications when prompted).
4. Simulate an out-of-range sensor by publishing:
   `mosquitto_pub -h <broker> -t DUMMYFERM2/Sensor -m 50`
5. You should receive a push: “Fermentation out of range”.
6. Publish an in-range value (e.g., 70) to receive a restore push.

## Cooldowns
- Out-of-range alert per topic: 30 min
- Restore alert per topic: 15 min (half the main cooldown)

## Roadmap Ideas
- Persist last known values to avoid spurious alerts on restart.
- User-editable thresholds via a settings screen.
- Unregister endpoint for tokens.
- Batch multiple simultaneous alerts into a single summary push.

---
Feel free to request automation for any of the roadmap items.
