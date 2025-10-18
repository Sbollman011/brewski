# Brewski — Copilot instructions

This file gives focused, actionable context an AI coding agent needs to be productive in this repository.

- Big picture: Node server (server/) provides HTTP API, WebSocket bridge and MQTT ingestion. The React/Expo app lives in `webapp/`. The DB is SQLite (`brewski.sqlite3`) and the ingestion path is in `server/lib/ingest.js`.

- Key entry points and files:
  - `bin/server.js` — server bootstrap used in production/dev.
  - `server/http-server.js` — main HTTP routing, static SPA serving, API rewrite (/api -> /admin/api), and admin token gating.
  - `server/mqtt-client.js` and `server/mqtt-client.next.js` — MQTT ingestion and grouping logic (see groupSegmentIndex and message hooks).
  - `server/lib/ingest.js` — telemetry ingestion into SQLite (better-sqlite3). Important: ingestion only stores numeric Sensor messages and enforces throttling.
  - `webapp/src/hosts.js` — central host resolution helpers used by client (API_HOST, MQTT_WS_HOST, apiUrl, wsUrl).
  - `scripts/dev-start.sh` — recommended developer convenience script (starts server and/or Expo client with dev env overrides).
  - `server/scripts/deploy-web.sh` — deploy static web build into `server/public` (used in production deploy).

- Important environment variables (commonly used in scripts and code):
  - DEV_MQTT_OVERRIDE=1 — make server connect to remote broker in dev.
  - RELAX_CORS=1 and ALLOW_LOCALHOST_ORIGINS=1 — relax CORS for local browser testing.
  - BREWSKI_DB_FILE or BREWSKI_DB_PATH — path to SQLite DB used by `better-sqlite3`.
  - MQTT_GROUP_SEGMENT_INDEX — controls group extraction (default 1). See `mqtt-client.next.js`.
  - MQTT_HOST/PORT/USER/PASS, MQTT_PROTOCOL, MQTT_CA_FILE, MQTT_KEY_FILE — broker config.
  - CSP_ENABLE_NONCE — toggles nonce injection for SPA index in `http-server.js`.

- Conventions and patterns to respect when changing code:
  - API rewrite: requests to `/api/*` are rewritten to `/admin/api/*` in `http-server.js`. Do not let API paths fall through to static index.html.
  - Admin SPA gating: serving `/admin` index requires a valid admin JWT (checked in `http-server.js`). Changing auth behavior requires updating both server-side gating and client-side expectations (see `webapp/src/api.js`).
  - Ingestion rules: numeric sensor ingestion occurs only for topics ending in `/Sensor` (and some `/Target` handling for power state). `server/lib/ingest.js` contains throttling logic; keep writes synchronous-safe (better-sqlite3 is sync).
  - Persistence: mqtt-client persists latest terminal topics to `.latest-targets.json` — keep that behavior if you refactor state persistence.

- Developer workflows (quick commands/examples):
  - Start everything (recommended):
    ./scripts/dev-start.sh both
    - Logs: `server/logs/dev-server.log`.
  - Start server only:
    ./scripts/dev-start.sh server
  - Start Expo client (webapp):
    cd webapp && npx expo start --tunnel
  - Build & deploy webapp (production):
    cd webapp && npm install && npm run web:build
    cd server && ./scripts/deploy-web.sh   # syncs to server/public
  - Quick health check: curl -s https://api.brewingremote.com/health or (local) http://localhost:8080/health

- Integration & cross-component notes:
  - Web client uses `apiUrl()` and `wsUrl()` helpers from `webapp/src/hosts.js` to decide absolute hosts; prefer modifying that helper instead of hardcoding hosts.
  - MQTT grouping: `mqtt-client.next.js` emits `group-message` and maintains `groupLatest`, `groupRecent`. Use those APIs to add group-level endpoints.
  - The server is single-process and uses synchronous DB access (better-sqlite3). Avoid long-running synchronous work on request paths.
  - Backups/migrations: see `server/backups/` and `server/migrations/` for DB history and schema changes.

- Testing & CI:
  - There are no automated tests in the repo. Small, local validations: run `node bin/server.js` and curl `/health`, hit admin GET endpoints, and verify MQTT flows using a local broker.

- Helpful TODOs for future automation (only if you implement them):
  - Add a `/info` endpoint that returns commit hash for easier debugging (helper already exists in `http-server.js`).
  - Add simple unit tests around `lib/ingest.js` and MQTT grouping logic.

If any section is unclear or you'd like more examples (small PRs that show how to add a new admin API, or how to write a safe migration), tell me which area to expand and I'll iterate.  