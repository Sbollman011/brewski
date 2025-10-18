#!/usr/bin/env bash
# dev-start.sh - helper to run the BrewSki dev environment.
# Usage:
#   ./scripts/dev-start.sh client    # start the Expo client (foreground)
#   ./scripts/dev-start.sh server    # start the server (background)
#   ./scripts/dev-start.sh both      # start server (bg) then client (fg)
#   ./scripts/dev-start.sh help      # show this message

set -eu
cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

# Recommended dev env flags
export DEV_API_HTTP=1
# Enable relaxed CORS on the server so browser dev clients can call localhost:8080
export RELAX_CORS=1
export ALLOW_LOCALHOST_ORIGINS=1
# Make the server connect to the central broker in dev (toggle as needed)
# By default prefer a local broker on localhost:1883 for development. Set
# DEV_MQTT_OVERRIDE=1 if you explicitly want to connect to the remote
# broker (mqtt.brewingremote.com:8883).
export DEV_MQTT_OVERRIDE=0
# Default local mqtt host/port for dev convenience (can be overridden in env)
# Prefer 127.0.0.1 to avoid IPv6 (::1) vs IPv4 resolution issues when binding locally.
export MQTT_HOST=${MQTT_HOST:-127.0.0.1}
export MQTT_PORT=${MQTT_PORT:-1883}
# By default disable telemetry writes in local dev to avoid DB growth. Set DISABLE_TELEMETRY=0 to enable.
export DISABLE_TELEMETRY=${DISABLE_TELEMETRY:-1}

# Convenience: if nvm is present, source it so server uses the right Node
if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
elif [ -f "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
fi

cmd=${1:-both}

start_server() {
  echo "Starting server (background) with RELAX_CORS=${RELAX_CORS}, ALLOW_LOCALHOST_ORIGINS=${ALLOW_LOCALHOST_ORIGINS}, DEV_MQTT_OVERRIDE=${DEV_MQTT_OVERRIDE}"
  # Ensure Node 18 is used if available via nvm
  if command -v nvm >/dev/null 2>&1; then
    nvm use 18 >/dev/null 2>&1 || true
  fi
  # Run server; use nohup so it survives closing this shell if you want
  # Keep logs in server/dev-server.log
  mkdir -p server/logs
  (cd "$REPO_ROOT" && RELAX_CORS=${RELAX_CORS} ALLOW_LOCALHOST_ORIGINS=${ALLOW_LOCALHOST_ORIGINS} DEV_MQTT_OVERRIDE=${DEV_MQTT_OVERRIDE} DISABLE_TELEMETRY=${DISABLE_TELEMETRY} MQTT_HOST=${MQTT_HOST} MQTT_PORT=${MQTT_PORT} node bin/server.js) > server/logs/dev-server.log 2>&1 &
  SERVER_PID=$!
  echo "Server started (pid ${SERVER_PID}), logs -> server/logs/dev-server.log"
}

start_client() {
  echo "Starting Expo client (foreground) with DEV_API_HTTP=${DEV_API_HTTP}"
  cd "$REPO_ROOT/webapp"
  # If you prefer tunnel or lan, change the args below
  DEV_API_HTTP=${DEV_API_HTTP} npx expo start --tunnel
}

case "$cmd" in
  client)
    start_client
    ;;
  server)
    start_server
    ;;
  both)
    start_server
    # small delay so server can bind before client tries calls
    sleep 1
    start_client
    ;;
  help|-h|--help)
    sed -n '1,120p' "$0"
    ;;
  *)
    echo "Unknown command: $cmd"
    echo "Usage: $0 [client|server|both|help]"
    exit 2
    ;;
esac
