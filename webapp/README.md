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

## Android Emulator (Default AVD: `brewski33`)

We provide a helper script and npm script to launch a stable emulator configuration (API 33 Google APIs x86_64, software GPU) and optionally install the latest built APK.

Launch headless emulator and install the existing APK (placed at `builds/brew-remote-preview.apk`):

```bash
npm run android:emu
```

Script details (`scripts/run-emulator.sh`):

- Uses AVD name `brewski33`
- Forces software GPU for stability (`-gpu swiftshader_indirect`)
- Waits for full boot (sys.boot_completed)
- Installs the APK if present

Custom usage:

```bash
bash ./scripts/run-emulator.sh --kill-existing --install
```

Flags:

- `--kill-existing` – terminates any running emulator first
- `--install` – installs `builds/brew-remote-preview.apk` after boot
- `--window` – show the emulator UI window (default run is headless)

If you rebuild a new APK, ensure you copy it (or download from EAS) to `webapp/builds/` with the same name or override `APK_PATH` env var:

```bash
APK_PATH=/path/to/other.apk npm run android:emu
```

To see the emulator window instead of headless mode:

```bash
bash ./scripts/run-emulator.sh --window --install
```

If you still need a Play Store AVD, create a separate one (API 36) — the Pixel 8 Play Store image was unstable on this host, so we default to API 33 for reliability.
