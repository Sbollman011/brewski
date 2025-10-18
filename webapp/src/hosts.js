// Centralized host configuration for client code.
// Resolution precedence (runtime):
// 1) window.__SERVER_FQDN / window.__MQTT_WS_PATH (injected by hosting/dev server)
// 2) process.env.SERVER_FQDN / process.env.MQTT_WS_PATH (build-time env)
// 3) fallback defaults

// NOTE: keep this file dependency-light so it works in both web and React Native.
// Resolution precedence (runtime):
// 1) window.__SERVER_FQDN (injected by hosting/dev server)
// 2) process.env.SERVER_FQDN (build-time env)
// 3) temporary developer override (set here for local dev work)
// 4) default 'api.brewingremote.com'
//
// For this development session we want to temporarily target a local backend
// at localhost:8080 while preserving the normal precedence. To revert, remove
// or set `TEMP_DEV_OVERRIDE` to false.
const TEMP_DEV_OVERRIDE = true; // <--- toggle this for local dev work
// Include explicit scheme to avoid ambiguous scheme detection in dev.
// This makes apiUrl() return e.g. 'http://localhost:8080' reliably.
const TEMP_DEV_HOST = 'http://localhost:8080';
// When in TEMP_DEV_OVERRIDE mode, prefer a local websocket host for dev work.
// Set `TEMP_DEV_USE_REMOTE_WS` to true if you intentionally want to reach the
// remote (production) websocket endpoint instead of your local dev server.
const TEMP_DEV_USE_REMOTE_WS = false;
const TEMP_DEV_REMOTE_WS_HOST = 'mqtt.brewingremote.com:8883';
// Local websocket host used during TEMP_DEV_OVERRIDE when not using the remote
// websocket. Keep as host[:port] (no scheme) so wsUrl()/Dashboard logic can
// decide ws vs wss based on environment.
const TEMP_DEV_LOCAL_WS_HOST = 'localhost:8080';

export const API_HOST = (typeof window !== 'undefined' && window.__SERVER_FQDN)
  ? window.__SERVER_FQDN
  : (typeof process !== 'undefined' && process.env && process.env.SERVER_FQDN)
    ? process.env.SERVER_FQDN
    : (TEMP_DEV_OVERRIDE ? TEMP_DEV_HOST : 'api.brewingremote.com');

// MQTT / WebSocket host defaults to the API host but can be overridden.
// Note: prefer an explicit runtime `window.__MQTT_WS_HOST` when present. For
// local dev sessions we also want the TEMP_DEV_OVERRIDE to take precedence
// over any build-time `process.env.MQTT_WS_HOST` so developers don't need to
// rebuild when toggling local mode.
export const MQTT_WS_HOST = (typeof window !== 'undefined' && window.__MQTT_WS_HOST)
  ? window.__MQTT_WS_HOST
  : (TEMP_DEV_OVERRIDE
    ? (TEMP_DEV_USE_REMOTE_WS ? TEMP_DEV_REMOTE_WS_HOST : (TEMP_DEV_LOCAL_WS_HOST || API_HOST))
    : (typeof process !== 'undefined' && process.env && process.env.MQTT_WS_HOST)
      ? process.env.MQTT_WS_HOST
      : API_HOST);

// Two named websocket paths: prefer `_ws` as the default (used in many places),
// but keep legacy '/ws' path available as `MQTT_WS_LEGACY_PATH`.
export const MQTT_WS_PATH = (typeof window !== 'undefined' && window.__MQTT_WS_PATH)
  ? window.__MQTT_WS_PATH
  : (typeof process !== 'undefined' && process.env && process.env.MQTT_WS_PATH)
    ? process.env.MQTT_WS_PATH
    : '/_ws';

export const MQTT_WS_LEGACY_PATH = (typeof window !== 'undefined' && window.__MQTT_WS_LEGACY_PATH)
  ? window.__MQTT_WS_LEGACY_PATH
  : (typeof process !== 'undefined' && process.env && process.env.MQTT_WS_LEGACY_PATH)
    ? process.env.MQTT_WS_LEGACY_PATH
    : '/ws';

// Helper to build absolute https URL to the API host for a given relative path
export function apiUrl(path) {
  if (!path) path = '/';
  if (!path.startsWith('/')) path = '/' + path;
  // If API_HOST includes a scheme (http:// or https://), respect it exactly.
  try {
    if (/^https?:\/\//i.test(API_HOST)) {
      // trim trailing slash on host if present, then append path
      return API_HOST.replace(/\/$/, '') + path;
    }
    const devHttp = (typeof process !== 'undefined' && process.env && process.env.DEV_API_HTTP === '1') || false;
    // consider host local if it's localhost, 127.x, or 0.0.0.0
    const isLocalHost = /^localhost$/.test(API_HOST) || /^127\./.test(API_HOST) || API_HOST.startsWith('0.0.0.0');
    const proto = (devHttp || isLocalHost) ? 'http' : 'https';
    return `${proto}://${API_HOST}${path}`;
  } catch (e) {
    return `https://${API_HOST}${path}`;
  }
}

// Helper to build websocket URL (wss for secure, ws for local/dev when requested)
export function wsUrl({ useSecure = true, legacy = false, path = null } = {}) {
  const host = MQTT_WS_HOST;
  const wsPath = path || (legacy ? MQTT_WS_LEGACY_PATH : MQTT_WS_PATH);
  const proto = useSecure ? 'wss' : 'ws';
  return `${proto}://${host}${wsPath}`;
}
