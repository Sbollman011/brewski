// Centralized host configuration for client code.
// Resolution precedence (runtime):
// 1) window.__SERVER_FQDN / window.__MQTT_WS_PATH (injected by hosting/dev server)
// 2) process.env.SERVER_FQDN / process.env.MQTT_WS_PATH (build-time env)
// 3) fallback defaults

// NOTE: keep this file dependency-light so it works in both web and React Native.
export const API_HOST = (typeof window !== 'undefined' && window.__SERVER_FQDN)
  ? window.__SERVER_FQDN
  : (typeof process !== 'undefined' && process.env && process.env.SERVER_FQDN)
    ? process.env.SERVER_FQDN
    : 'api.brewingremote.com';

// MQTT / WebSocket host defaults to the API host but can be overridden.
export const MQTT_WS_HOST = (typeof window !== 'undefined' && window.__MQTT_WS_HOST)
  ? window.__MQTT_WS_HOST
  : (typeof process !== 'undefined' && process.env && process.env.MQTT_WS_HOST)
    ? process.env.MQTT_WS_HOST
    : API_HOST;

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
  return `https://${API_HOST}${path}`;
}

// Helper to build websocket URL (wss for secure, ws for local/dev when requested)
export function wsUrl({ useSecure = true, legacy = false, path = null } = {}) {
  const host = MQTT_WS_HOST;
  const wsPath = path || (legacy ? MQTT_WS_LEGACY_PATH : MQTT_WS_PATH);
  const proto = useSecure ? 'wss' : 'ws';
  return `${proto}://${host}${wsPath}`;
}
