MQTT Dashboard (Expo)

This is a minimal Expo React Native app that connects to the WebSocket bridge provided by `quick-mqtt-connect.js` and displays connection info, discovered topics, and recent messages.

Run the bridge (on the machine running the broker):

```bash
# from /home/steven/Documents/Brewski
node quick-mqtt-connect.js INHHOUSE --connect --ws-port 8080
```

Run the Expo app (on the same machine or device on the same network):

```bash
cd mqtt-dashboard
npm install
npx expo start
```

Edit `App.js` to change the WebSocket URL (default `ws://10.0.0.17:8080`) to match the machine running the bridge.
