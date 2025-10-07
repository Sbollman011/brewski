#!/usr/bin/env bash
set -euo pipefail

backup="/etc/gai.conf.bak.$(date +%Y%m%d-%H%M%S)"
[ -f /etc/gai.conf ] && sudo cp /etc/gai.conf "$backup"

target_line='precedence ::ffff:0:0/96  100'

if grep -q "^${target_line}" /etc/gai.conf; then
  echo "Already enabled."
elif grep -q "^#${target_line}" /etc/gai.conf; then
  sudo sed -i "s|^#${target_line}|${target_line}|" /etc/gai.conf
  echo "Uncommented existing precedence line."
else
  echo "${target_line}" | sudo tee -a /etc/gai.conf >/dev/null
  echo "Appended precedence line."
fi

echo "Result:"
grep '::ffff:0:0/96' /etc/gai.conf

# Remove any previous lines
sudo sed -i '/mqtt\.brewingremote\.com/d' /etc/hosts

# Add only the IPv4 mapping
echo '5.78.121.148 mqtt.brewingremote.com' | sudo tee -a /etc/hosts

# Verify: should show ONLY IPv4 now (no 64:ff9b:: lines)
getent ahosts mqtt.brewingremote.com

sudo systemd-resolve --flush-caches 2>/dev/null || true
sudo resolvectl flush-caches 2>/dev/null || true
getent ahosts mqtt.brewingremote.com