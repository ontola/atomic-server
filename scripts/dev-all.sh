#!/usr/bin/env bash
#
# One dev environment across the browser and the macOS app — both served by a
# single Vite, so a save reloads both at once.
#
#   scripts/dev-all.sh              # vite + macOS app
#   scripts/dev-all.sh vite         # just the dev server (browser only)
#   scripts/dev-all.sh macos        # vite + the macOS app
#
# Exactly one Vite. `tauri dev` runs `beforeDevCommand`, which starts a Vite of
# its own. Two of them race on src/locales/*.po (wuchale's extractor is not
# concurrency-safe) and corrupt the catalogs. So we start Vite once here and
# hand Tauri a config with `beforeDevCommand` emptied.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VITE_PORT=6747
LOG_DIR="${TMPDIR:-/tmp}/atomic-dev"

# Tauri would otherwise start a second Vite (see header).
NO_BEFORE_DEV='{"build":{"beforeDevCommand":""}}'

mkdir -p "$LOG_DIR"

log() { printf '\033[36m[dev]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[dev]\033[0m %s\n' "$*" >&2; exit 1; }

vite_is_up() { curl -sf -o /dev/null "http://localhost:$VITE_PORT/"; }

start_vite() {
  if vite_is_up; then
    log "Vite already listening on $VITE_PORT — reusing it."
    return
  fi

  log "Starting Vite on 0.0.0.0:$VITE_PORT (log: $LOG_DIR/vite.log)"
  (cd "$REPO_ROOT/browser/data-browser" && pnpm dev >"$LOG_DIR/vite.log" 2>&1) &

  for _ in $(seq 60); do
    vite_is_up && { log "Vite is up."; return; }
    sleep 1
  done
  die "Vite never came up. See $LOG_DIR/vite.log"
}

# The macOS app embeds its own atomic-server on 9883, against the same ReDB in
# ~/Library/Application Support/atomic-data. A standalone atomic-server holds
# that lock, so the app would panic on boot ("Database already open"). They are
# mutually exclusive — and you don't need both: the browser on 6747 happily
# talks to whichever server owns 9883.
assert_9883_free() {
  local pids
  pids=$(lsof -nP -tiTCP:9883 -sTCP:LISTEN 2>/dev/null || true)
  [ -z "$pids" ] || die "Something already serves 9883 (pid $pids) — probably a
      standalone atomic-server. The macOS app embeds its own on that port and
      against the same ReDB, so stop it first (the browser will then use the
      app's server)."
}

start_macos() {
  assert_9883_free
  log "Starting the macOS app (log: $LOG_DIR/macos.log)"
  (cd "$REPO_ROOT/desktop" && cargo tauri dev \
      --no-dev-server-wait -c "$NO_BEFORE_DEV" >"$LOG_DIR/macos.log" 2>&1) &
}

case "${1:-all}" in
  vite)    start_vite ;;
  macos)   start_vite; start_macos ;;
  all)     start_vite; start_macos ;;
  *)       die "Usage: $0 [all|vite|macos]" ;;
esac

log "Browser: http://localhost:$VITE_PORT"
log "Ctrl-C to stop. Logs in $LOG_DIR"
wait
