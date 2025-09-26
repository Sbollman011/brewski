# Brew Remote Build & Install Guide (iPhone + Android)

This guide shows how to go from the current repository to a Dev Client (for push + native modules) and a TestFlight/Production build — from Linux, using Expo's cloud.

## 1. Prerequisites
- Node & npm installed.
- Expo CLI (implicit via npx) and EAS CLI: `npm i -g eas-cli`
- Apple Developer Account (for iOS builds + push) & team membership.
- Physical iPhone (Expo Go no longer supports remote push for SDK 53+).
- (Optional) Android device for faster iteration.

## 2. Project Config Files Added
- `app.json` (base Expo config)
- `eas.json` (build profiles: development, preview, production)

## 3. Profiles Overview
| Profile | Use | Notes |
|---------|-----|-------|
| development | Dev Client | Hot reload + native modules; install by direct link / QR; great for debugging. |
| preview | Internal / TestFlight | For testers; closer to production; can be submitted or promoted. |
| production | App Store release | Final build with production settings. |

## 4. First Login / Init
```bash
cd webapp
npx expo whoami          # optional, shows current login
npx expo login           # if not logged in
EAS_NO_VCS=1 eas build:configure  # if prompted to configure
```

## 5. Development (Dev Client) Build (iOS)
```bash
eas build -p ios --profile development
```
When prompted, supply Apple ID & 2FA. EAS will manage credentials (or reuse existing). After build completes, open the build page URL. Install options:
- Scan QR code with device camera (will install via Expo's install service if allowed) **OR**
- Use TestFlight (instead run a preview build below and submit).

## 6. Preview (TestFlight-style) Build (iOS)
```bash
eas build -p ios --profile preview
```
Submit to TestFlight (if not auto-submitted):
```bash
eas submit -p ios --latest
```
Apple may take a few minutes (sometimes up to an hour) to process before it appears in TestFlight.

## 7. Android (Optional)
Dev client:
```bash
eas build -p android --profile development
```
Preview:
```bash
eas build -p android --profile preview
```
Install the resulting APK (dev) or AAB (preview) on device, or distribute internally.

## 8. Running the App with Dev Client
After installing the dev client on the device:
```bash
cd webapp
npm install  # ensure deps
npx expo start --tunnel
```
Open the QR code with the **Dev Client** (not Expo Go). You should see the banner disappear (we show a warning only inside Expo Go). Token registration logs should appear on the server:
```
[push] registered token ExponentPushToken[...]
```

## 9. Testing Push
Direct push:
```bash
curl -X POST http://<SERVER_IP>:8080/push/direct \
  -H 'Content-Type: application/json' \
  -d '{"title":"Test","body":"Hello from server"}'
```
Threshold simulation:
```bash
curl -X POST http://<SERVER_IP>:8080/push/test \
  -H 'Content-Type: application/json' \
  -d '{"topic":"DUMMYFERM2/Sensor","value":50}'
```
Then restore:
```bash
curl -X POST http://<SERVER_IP>:8080/push/test \
  -H 'Content-Type: application/json' \
  -d '{"topic":"DUMMYFERM2/Sensor","value":70}'
```

## 10. Environment / Secrets (Optional)
For production you may eventually add:
- `extra` section in `app.json` or use `app.config.js` with `process.env`.
- EAS secrets: `eas secret:create --name API_URL --value https://example.com` and read via `process.env.EXPO_PUBLIC_API_URL`.

## 11. Updating App Version
Modify `version` in `app.json` and bump native build numbers:
```bash
eas build:version:set --platform ios --auto
```

## 12. Troubleshooting
| Issue | Fix |
|-------|-----|
| No push token log | Ensure dev client not Expo Go; check network IP; accept notification permission. |
| curl direct push 200 but no alert | Foreground? iOS Focus mode? Check server log for `[push] sent` response. |
| Build fails (credentials) | Run `eas credentials` to inspect; clear and regenerate. |
| Stuck processing in App Store Connect | Wait; verify icons/screenshots optional for TestFlight dev builds. |

## 13. Cleaning / Reset
- Clear push tokens: delete `server/.push-tokens.json` while server is stopped.
- Reset thresholds: delete `server/.thresholds.json`.
- Reinstall dev client if native module versions change.

## 14. Promotion Path
1. Dev test with `development` build.
2. Wider internal test with `preview` + TestFlight.
3. Finalize metadata and produce `production` build.
4. Submit with `eas submit -p ios --latest`.

---
Need CI scripts or environment-based config next? Ask and we’ll scaffold them.
