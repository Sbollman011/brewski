Internal notes — brewski server
=================================================

This file documents runtime env vars, deployment notes, security defaults, and common App Store/Play Store review items.

1) Key environment variables
- APP_ORIGINS: comma-separated list of allowed CORS origins. Default: https://appli.railbrewouse.com,https://localhost:19006
- BRIDGE_TOKEN: optional shared secret for admin-level HTTP and WebSocket actions. When set, `/info` and privileged WS state are only returned to callers presenting this token (Authorization: Bearer <token> or ?token=).
- QUICK_MQTT_CERT / QUICK_MQTT_KEY: override paths to TLS cert/key for the origin HTTPS server (defaults to `server/cert.pem` and `server/key.pem`).
- QUICK_MQTT_WS_PORT / QUICK_MQTT_WS_HOST: listen port and host (defaults: 8080, 0.0.0.0).
- RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX: in-memory rate-limiter tuning (default 15000 ms window, 30 requests).

2) WebSocket auth flow
- If `BRIDGE_TOKEN` is set, clients must send a JSON auth message immediately after establishing the WS connection: { "type": "auth", "token": "<BRIDGE_TOKEN>" }.
- Until a client authenticates, the server sends only minimal, non-sensitive status (e.g. { type: 'status', data: { server: 'brewski', connectionName } }). After successful auth the server will send privileged broker details.

3) Admin HTTP endpoints and protections
- Sensitive endpoints (publish, threshold updates, push registration, direct push) are rate-limited by IP+endpoint using an in-memory token-bucket. Tune with RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX.
- The `/publish` and `/get` endpoints will require `BRIDGE_TOKEN` if it is configured.

4) Deployment notes
- For single-instance deployments the in-memory rate-limiter is acceptable. For production or multi-instance deployments, replace with a Redis-backed rate limiter (e.g., using `rate-limiter-flexible`) to avoid inconsistent limits across nodes.
- Prefer storing `BRIDGE_TOKEN` in a secrets manager. As a short-term option, add it as an `Environment=` entry in the `brewski.service` systemd unit or a systemd drop-in file at `/etc/systemd/system/brewski.service.d/override.conf` (then `systemctl daemon-reload` and `systemctl restart brewski`).
- TLS: Cloudflare Tunnel is configured to accept the origin self-signed cert (`originRequest.noTLSVerify: true`). Cloudflare edge presents a public cert—mobile clients talk to Cloudflare, not directly to this origin.

5) App Store / Play Store review checklist (common flags and mitigations)
- Privacy policy URL: present and reachable. `docs/PRIVACY.md` exists, but provide a public URL (GitHub Pages or hosted page) for the store listing.
- Data collection disclosures (Data Safety): ensure the app's Play Store data safety form and App Store privacy sections match actual data flows (push tokens, device identifiers, telemetry).
- Permissions: iOS/Android should only request permissions required by the app. Background location, microphone, camera, contacts, SMS, etc., will trigger extra review and require justification.
- Push notifications: register/send push tokens securely. Do not leak tokens in logs or public endpoints. Ensure token storage and deletion flows exist.
- Encryption/Transport: ensure all network calls use TLS (App Transport Security rules on iOS). Cloudflare edge terminates TLS; origin-to-cloudflared can be TLS with `noTLSVerify` if using self-signed certs.
- Third-party SDKs: list SDKs in the app and verify their privacy policies. Some analytics/crash SDKs raise flags for data collection.
- Background network activity: if the app performs background networking or long-running tasks, document why; excessive background use can lead to rejection.
- Account & sign-in: if account creation or sign-in is available, ensure password reset, account deletion, and privacy flows are implemented as per store guidelines.
- Local data handling: clearly state what is stored locally, what is sent to the server, and retention periods. Implement data deletion on account removal if required.
- Export/compliance: if the app uses encryption, confirm export compliance forms as required by Apple/Google.

6) Quick mitigation suggestions for common rejections
- Add a clear, accessible privacy policy URL in the app and store listing.
- Minimize requested permissions; request permissions at point-of-use with rationale text.
- Ensure network calls use TLS and avoid sending credentials or other secrets in responses. (We removed broker details from `/info`.)
- Provide instructions for reviewers to exercise the app (test accounts, tokens, or a REPL endpoint). Consider adding a temporary review token with limited scope and expiration.

7) Future improvements (low effort → higher effort)
- Add Redis-backed rate limiter for HA (medium effort, tested library: rate-limiter-flexible).
- Audit/logging: add structured audit logs for admin actions (threshold updates, push registrations) and rotate logs to central storage.
- Secrets: integrate a secrets manager and remove any local backups from machines that aren't secure.
- CI tests: add a small smoke-test that validates public vs. token-authenticated responses and presence of security headers.

If you want, I can add a systemd drop-in to set `BRIDGE_TOKEN`, create a public privacy page (GitHub Pages), and add the CI smoke-test next. Tell me which to prioritize.
