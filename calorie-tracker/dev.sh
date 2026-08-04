#!/bin/bash
# Usage: ./dev.sh ios | ./dev.sh android | ./dev.sh <device-id>
# Hot reload from any terminal: make reload-ios / make reload-android
#
# Unlike the canvas app's dev.sh this resolves Flutter from PATH rather than
# hardcoding a mise install directory: the pinned path there points at a version
# that is not installed on every machine, and a wrong absolute path fails with
# "no such file" rather than anything you can act on. `mise exec` still works —
# it just puts flutter on PATH first.
set -euo pipefail

FLUTTER="${FLUTTER:-$(command -v flutter || true)}"
if [ -z "$FLUTTER" ]; then
  echo "flutter not found on PATH. Install it, or run via: mise exec -- ./dev.sh $*" >&2
  exit 1
fi

TARGET="${1:-}"
case "$TARGET" in
  ios)     DEVICE="ios" ;;
  android) DEVICE="android" ;;
  "")      echo "Usage: $0 ios|android|<device-id>"; exit 1 ;;
  *)       DEVICE="$TARGET" ;;
esac

FIFO="/tmp/caltracker_${TARGET}_pipe"
WRITER_PID_FILE="/tmp/caltracker_${TARGET}_writer.pid"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Clean up from any previous run
kill "$(cat "$WRITER_PID_FILE" 2>/dev/null)" 2>/dev/null || true
rm -f "$FIFO"
mkfifo "$FIFO"

# Keep the write end of the FIFO open so flutter run never sees EOF
sleep 86400 > "$FIFO" &
echo $! > "$WRITER_PID_FILE"

echo ""
echo "  Hot reload:  make reload-$TARGET"
echo "  Hot restart: make restart-$TARGET"
echo "  Quit:        Ctrl+C"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${TARGET}.log"
: > "$LOG_FILE"
echo "  Log file: $LOG_FILE"
echo ""

cleanup() {
  kill "$(cat "$WRITER_PID_FILE" 2>/dev/null)" 2>/dev/null || true
  rm -f "$FIFO" "$WRITER_PID_FILE"
}
trap cleanup EXIT

"$FLUTTER" run -d "$DEVICE" < "$FIFO" 2>&1 | tee -a "$LOG_FILE"
