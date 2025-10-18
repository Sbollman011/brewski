# Brewski Platform

Unified MQTT bridge + Admin/Manager web portal + React Native (Expo) client.

## Components

- **Node server**: HTTP/HTTPS API, WebSocket bridge, MQTT client (`server/`, entry `bin/server.js`).
- **Expo app**: Cross‑platform dashboard + admin/manager portal (`webapp/`).
- **Production web build**: Static export served from `server/public` (preferred) or fallback `webapp/web-build`.

## Hosts / Domains

| Purpose | Host |
|---------|------|
| API + WebSocket | https://api.brewingremote.com |
| Public Web UI   | https://brewingremote.com |

Both are fronted by Cloudflare Tunnel -> local Node server (port 8080). Expo dev server (8081) is only used during development and no longer fronts production.

````markdown
# Brewski Platform

Unified MQTT bridge + Admin/Manager web portal + React Native (Expo) client.

## Components

- **Node server**: HTTP/HTTPS API, WebSocket bridge, MQTT client (`server/`, entry `bin/server.js`).
- **Expo app**: Cross‑platform dashboard + admin/manager portal (`webapp/`).
- **Production web build**: Static export served from `server/public` (preferred) or fallback `webapp/web-build`.

## Hosts / Domains

| Purpose | Host |
|---------|------|
| API + WebSocket | https://api.brewingremote.com |
| Public Web UI   | https://brewingremote.com |

Both are fronted by Cloudflare Tunnel -> local Node server (port 8080). Expo dev server (8081) is only used during development and no longer fronts production.

## Development Quick Start

```bash
# Install dependencies
cd webapp
npm install

# Start Expo (choose web / native platform as needed)
npm run web            # or: npm start

# In another shell (from repo root) start server
node bin/server.js
```

## Production Web Deploy

1. Build Expo static web export:
	```bash
	cd webapp
	npm install         # ensure dependencies
	npm run web:build   # outputs to webapp/web-build
	```
2. Sync build to server public directory:
	```bash
	npm run deploy:web  # rsync -> server/public
	```
3. Restart Node server (examples):
	```bash
	sudo systemctl restart brewski.service
	# or manual
	pkill -f bin/server.js || true
	node bin/server.js &
	```
4. Restart Cloudflared (if config changed):
	```bash
	sudo systemctl restart cloudflared
	```
5. Verify deployment:
	```bash
	curl -I https://brewingremote.com/
	curl -s https://api.brewingremote.com/health
	```
	- Root returns 200 HTML referencing `/assets/`.
	- Network tab shows static assets, no requests to `localhost:8081`.

### Rollback

If something fails:
- Move `server/public/index.html` out of the way to force legacy fallback.
- (Optional) Point Cloudflared frontend ingress back to Expo dev server.
- Restart services.

## Authentication & Routing

- JWT stored as `brewski_jwt` (web) + in-memory ref (native).
- Unauthenticated clicks on Manage now set an intended screen and open login (no hard 401 reload).
- `/admin` requires `is_admin === 1`.
- `/manage` accessible to admins and `role === 'manager'`.
- After login, user is routed to intended screen (`admin`/`dashboard`).

## Manager vs Admin Permissions

- Managers: limited portal view (their customer only). Can delete users only if target role ∈ {`user`, `privileged`} and not themselves.
- Admins: full CRUD on customers, users, topics.
- Permission denials surface via in‑app dismissible notice (not alerts).

## Code Layout Highlights

```
bin/server.js              # server bootstrap
server/http-server.js      # static + API routing + SPA gating
server/mqtt-client.js      # MQTT integration (not shown here)
webapp/src/api.js          # apiFetch helper with host logic
webapp/views/AdminPortal.js# unified admin/manager portal
webapp/views/Landing.js    # landing with SPA-managed Manage button
```

## Deployment Checklist

- [ ] `npm run web:build` completed
- [ ] `npm run deploy:web` synced to `server/public`
- [ ] Server restarted (`systemctl` or manual)
- [ ] Cloudflared restarted (if host mapping changed)
- [ ] Visit https://brewingremote.com (no 401 on Manage unauthenticated → shows login)
- [ ] Post-login: Manage shows correct portal based on role

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| 401 after clicking Manage unauthenticated | Direct navigation causing server auth gate | Ensure SPA handler (`onManagePress`) in Landing; rebuild if stale |
| Getting dev HTML instead of JSON for /admin/api/* | Using app host relative URL | Force absolute `https://api.brewingremote.com` (handled in `apiFetch`) |
| Manager cannot delete basic user | Role mismatch or UI stale | Refresh portal; confirm target role ∈ {user, privileged} |
| Assets 404 | Build not synced | Re-run `npm run deploy:web` |

## Future Enhancements (Ideas)
- Merge `apiFetch` & `doFetchFactory` into shared hook.
- Version stamp (commit hash) endpoint or footer.
- CI pipeline auto-deploy on tag.
- Automated role-based E2E tests.

## License
Proprietary (internal use). © 2025 Brewski.

----

Additional local dev host configuration
---------------------------------------

To support running the client against local or remote API and WebSocket hosts without touching many files,
the project includes a small helper at `webapp/src/hosts.js` and the following runtime/build-time overrides.

Client helpers

- `webapp/src/hosts.js` exposes:
  - `API_HOST` — resolved from `window.__SERVER_FQDN` (runtime) or `process.env.SERVER_FQDN` (build-time) or falls back to `api.brewingremote.com`.
  - `MQTT_WS_HOST` — resolved from `window.__MQTT_WS_HOST` or `process.env.MQTT_WS_HOST` or defaults to `API_HOST`.
  - `MQTT_WS_PATH` and `MQTT_WS_LEGACY_PATH` — default to `/_ws` and `/ws` respectively.
  - `apiUrl(path)` — helper returning an `https://` absolute URL to the API host.
  - `wsUrl(opts)` — helper returning a `wss://` or `ws://` websocket URL.

How to override (examples)

- Browser temporary override (DevTools Console):

  window.__SERVER_FQDN = '192.168.1.50:3000';
  window.__MQTT_WS_HOST = '192.168.1.50:8080';
  window.__MQTT_WS_PATH = '/_ws';
  window.location.reload();

- Build-time env (native builds / CI):

  SERVER_FQDN=192.168.1.50:3000 MQTT_WS_HOST=192.168.1.50:8080 npm run start

Server CORS / allowed origins

- Default allowed origins derive from `process.env.SERVER_FQDN` when set.
- Override by providing `APP_ORIGINS` (comma-separated origins list).
- Allow localhost origins for development with `ALLOW_LOCALHOST_ORIGINS=1`.

Security note: do not set `RELAX_CORS=1` in production.

If you'd like, I can also:
- Add a small dev script to inject `window.__SERVER_FQDN` automatically into the SPA HTML when running a local static server.
- Replace any remaining hard-coded host strings across the repo with `apiUrl()` calls.
