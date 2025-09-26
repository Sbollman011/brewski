# Development Build Setup for Push Notifications

Expo Go no longer supports remote push notifications from `expo-notifications` (SDK 53+). You need a Dev Client (custom development build) to receive real pushes while developing.

## 1. Prerequisites
- Expo account (run `npx expo login` if not logged in)
- Android: Android Studio / device with USB debugging
- iOS: macOS + Xcode (for physical device build) or use EAS Build cloud service

## 2. Install EAS CLI
```bash
npm i -g eas-cli
```

## 3. Configure Project for EAS
If you do not yet have an `eas.json`, initialize:
```bash
eas init --id brewski-dev
```
Accept defaults. An `eas.json` file will be created.

Minimal example (if you need to create manually):
```json
{
  "cli": { "version": ">= 3.18.0" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": {}
  },
  "submit": { "production": {} }
}
```

## 4. Android Dev Build
```bash
eas build -p android --profile development
```
After completion, download the `.apk` (or `.aab`) and install on your device. Launch the dev client; it behaves like Expo Go but with native modules (push enabled).

## 5. iOS Dev Build
```bash
eas build -p ios --profile development
```
Follow credential prompts. After build finishes, install on device via:
- `eas build:install` (iOS device connected), or
- TestFlight (if using internal distribution)

## 6. Running Your App
Once the dev client is installed:
```bash
npx expo start --tunnel
```
Open the QR code with the dev client (NOT Expo Go). Your `App.js` registration code will now obtain a real push token.

## 7. Verifying Push
1. Open the app in the dev client.
2. Observe server logs: should show `[push] registered token ExponentPushToken[...]`.
3. Trigger a direct push:
```bash
curl -X POST http://<SERVER_LAN_IP>:8080/push/direct \
  -H 'Content-Type: application/json' \
  -d '{"title":"Dev Build Test","body":"Push working"}'
```
4. Device should display notification immediately (foreground: maybe banner, background: tray).

## 8. Common Issues
- Token not logging: Confirm you're not still in Expo Go (look for warning banner added in UI).
- No notification when foregrounded on Android: Some OEMs (e.g. Xiaomi) require whitelisting; also consider setting a channel.
- No pushes on iOS: Ensure you accepted permission prompt; Settings -> Notifications -> App -> Allow.

## 9. Optional: Android Notification Channel
Add once at startup (before requesting token):
```js
Notifications.setNotificationChannelAsync('default', {
  name: 'default',
  importance: Notifications.AndroidImportance.HIGH,
});
```
Then add `sound: 'default'` or channelId in push payload if customizing.

## 10. Cleaning Tokens
Delete `server/.push-tokens.json` while server stopped to reset.

---
Need help automating build or adding channel config? Let me know.
