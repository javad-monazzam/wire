#!/bin/bash
# One-off cleanup for configs touched by the previous (commenting) version.
#
#   - strips every "#!OFF!" marker, restoring the peer blocks
#   - records those clients in /etc/wireguard/disabled.json so they stay off
#   - reports any client whose AllowedIPs is malformed (e.g. "156.6.86./32")
#
# Run once:  sudo bash cleanup.sh

set -euo pipefail

NIC=$(grep '^SERVER_WG_NIC=' /etc/wireguard/params | cut -d= -f2)
CONF="/etc/wireguard/${NIC}.conf"
STATE="/etc/wireguard/disabled.json"

cp -a "$CONF" "${CONF}.bak.$(date +%s)"
echo "backup: ${CONF}.bak.*"

# Which clients are currently commented out?
DISABLED=$(awk '
  /^### Client /      { name = $3 }
  /^#!OFF!/           { if (name && !seen[name]++) print name }
' "$CONF")

# Strip the markers.
sed -i 's/^#!OFF!//' "$CONF"

# Record them as disabled.
if [ -n "$DISABLED" ]; then
    printf '%s\n' "$DISABLED" | awk 'BEGIN{printf "["} {printf "%s\"%s\"", (NR>1?", ":""), $0} END{print "]"}' > "$STATE"
    chmod 600 "$STATE"
    echo "marked disabled: $(echo "$DISABLED" | tr '\n' ' ')"
else
    echo "[]" > "$STATE"; chmod 600 "$STATE"
    echo "no commented peers found"
fi

# Flag configs the old bug corrupted.
BAD=$(awk '
  /^### Client / { name = $3 }
  /^AllowedIPs/  { if ($0 ~ /[0-9]\.\/|= *\//) print "  " name ": " $0 }
' "$CONF")

if [ -n "$BAD" ]; then
    echo
    echo "MALFORMED AllowedIPs - these clients need deleting and recreating:"
    echo "$BAD"
fi

echo
echo "conf is now valid; restart the panel:  systemctl restart jwpn"
