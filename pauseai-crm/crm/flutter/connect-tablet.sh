#!/bin/bash
# Connect Samsung tablet (R52X80AC5CY) over WiFi for wireless debugging.
#
# On the tablet: Settings → Developer options → Wireless debugging → ON
#   → "Pair device with pairing code" shows IP:pair_port and a 6-digit code
#
# Usage:
#   ./connect-tablet.sh pair 192.168.0.169:37123 123456
#   ./connect-tablet.sh connect 192.168.0.169:41234
#   ./connect-tablet.sh status
#
# After connect, run: make tablet

set -euo pipefail

TABLET_SERIAL="${TABLET_SERIAL:-R52X80AC5CY}"

cmd="${1:-status}"
shift || true

case "$cmd" in
  pair)
    if [[ $# -lt 2 ]]; then
      echo "Usage: $0 pair IP:PAIR_PORT CODE"
      exit 1
    fi
    adb pair "$1" "$2"
    ;;
  connect)
    if [[ $# -lt 1 ]]; then
      echo "Usage: $0 connect IP:CONNECT_PORT"
      echo "  (use the port shown on the main Wireless debugging screen, not the pairing dialog)"
      exit 1
    fi
    adb connect "$1"
    sleep 1
  adb devices -l | grep -E "$TABLET_SERIAL|${1%%:*}" || true
    ;;
  status)
    echo "Expected tablet serial: $TABLET_SERIAL"
    adb devices -l
    echo ""
    echo "mDNS services:"
    adb mdns services 2>&1 || true
    ;;
  *)
    echo "Unknown command: $cmd"
    exit 1
    ;;
esac
