#!/usr/bin/env bash
set -euo pipefail

# Default AVD name
AVD_NAME="brewski33"
APK_PATH="${APK_PATH:-$(pwd)/builds/brew-remote-preview.apk}"
ADB="${ANDROID_SDK_ROOT:-$HOME/Documents/Android}/platform-tools/adb"
EMU_BIN="${ANDROID_SDK_ROOT:-$HOME/Documents/Android}/emulator/emulator"
LOG_DIR="$HOME/emulator-logs"
mkdir -p "$LOG_DIR"

usage() {
  echo "Usage: $0 [-i | --install] [-k | --kill-existing] [-w | --window]"
  echo "  -i / --install       Install APK after boot if sys.boot_completed=1 and APK exists"
  echo "  -k / --kill-existing Stop any running emulator processes first"
  echo "  -w / --window        Show emulator UI window (omit -no-window)"
  exit 0
}

INSTALL_AFTER=0
KILL_EXISTING=0
SHOW_WINDOW=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--install) INSTALL_AFTER=1; shift;;
    -k|--kill-existing) KILL_EXISTING=1; shift;;
    -w|--window) SHOW_WINDOW=1; shift;;
    -h|--help) usage;;
    *) echo "Unknown arg: $1"; usage;;
  esac
done

if [[ $KILL_EXISTING -eq 1 ]]; then
  echo "Killing existing emulator processes..."
  pkill -f qemu-system-x86_64 || true
  pkill -f "$EMU_BIN" || true
  sleep 1
fi

if [[ ! -x "$EMU_BIN" ]]; then
  echo "Emulator binary not found at $EMU_BIN" >&2
  exit 1
fi

# Build emulator args
EMU_ARGS=( -avd "$AVD_NAME" -gpu swiftshader_indirect -no-snapshot -no-boot-anim )
if [[ $SHOW_WINDOW -eq 0 ]]; then
  EMU_ARGS+=( -no-window )
fi

# Start emulator (headless by default) with software GPU for stability
LOG_FILE="$LOG_DIR/${AVD_NAME}.log"
rm -f "$LOG_FILE"
nohup "$EMU_BIN" "${EMU_ARGS[@]}" > "$LOG_FILE" 2>&1 &
EMUPID=$!

echo "Started $AVD_NAME (pid=$EMUPID). Waiting for device..."
"$ADB" wait-for-device

BOOTED=0
for i in $(seq 1 240); do
  BOOT=$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') || true
  if [[ "$BOOT" == "1" ]]; then
    echo "Boot complete after ${i}s"
    BOOTED=1
    break
  fi
  sleep 1
done

if [[ $BOOTED -ne 1 ]]; then
  echo "Emulator failed to finish booting within timeout. See $LOG_FILE"
  exit 2
fi

if [[ $INSTALL_AFTER -eq 1 ]]; then
  if [[ -f "$APK_PATH" ]]; then
    echo "Installing APK $APK_PATH"
    if "$ADB" install -r "$APK_PATH"; then
      echo "Install successful"
    else
      echo "Install failed" >&2
    fi
  else
    echo "APK not found at $APK_PATH (skip install)" >&2
  fi
fi

echo "Done. Log: $LOG_FILE"
