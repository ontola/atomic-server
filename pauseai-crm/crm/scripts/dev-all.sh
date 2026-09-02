#!/usr/bin/env bash
#
# One dev environment across browser, the macOS app, and every attached Android
# device — all served by a single Vite, so a save reloads all of them at once.
#
#   scripts/dev-all.sh              # vite + macOS app + all Android devices
#   scripts/dev-all.sh vite         # just the dev server (browser only)
#   scripts/dev-all.sh macos        # vite + the macOS app
#   scripts/dev-all.sh android      # vite + every attached Android device
#
# Two things make this work:
#
#   Exactly one Vite. `tauri dev` and `tauri android dev` each run
#   `beforeDevCommand`, which starts a Vite of its own. Two of them race on
#   src/locales/*.po (wuchale's extractor is not concurrency-safe) and corrupt
#   the catalogs. So we start Vite once here and hand every Tauri process a
#   config with `beforeDevCommand` emptied.
#
#   `adb reverse`, not the LAN IP. Each device's own localhost:6747 is
#   forwarded to this Mac, so the page origin is `http://localhost:6747`
#   everywhere — same as the browser. That keeps one CORS story against the
#   embedded server on localhost:9883 (which runs *on the device*, and is not
#   forwarded), needs no cleartext exemption beyond the debug build's, and
#   survives the Mac changing networks.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VITE_PORT=6747
LOG_DIR="${TMPDIR:-/tmp}/atomic-dev"
APK=gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
APP_ID=com.atomicdata.dev

# Tauri would otherwise start a second Vite (see header).
NO_BEFORE_DEV='{"build":{"beforeDevCommand":""}}'

# Gradle needs a full JDK. mise puts a `zulu-jre` (no javac) on JAVA_HOME, and
# Gradle then dies with "Failed to calculate the value of task
# ':buildSrc:compileJava' property 'javaCompiler'". Android Studio's bundled JBR
# is a real JDK, so it wins whenever it's installed — this must override the
# inherited JAVA_HOME, not defer to it.
JBR="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
[ -x "$JBR/bin/javac" ] && export JAVA_HOME="$JBR"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}"
export ANDROID_NDK_HOME="$NDK_HOME"

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

android_serials() {
  adb devices | awk 'NR>1 && $2=="device" {print $1}'
}

# Point each device's localhost:6747 at this Mac. Idempotent.
reverse_ports() {
  for serial in $(android_serials); do
    adb -s "$serial" reverse "tcp:$VITE_PORT" "tcp:$VITE_PORT" >/dev/null
    log "adb reverse ready on $serial"
  done
}

# Deliberately NOT `tauri android dev`: it drives exactly one device (chosen by
# a fuzzy name match, not the adb serial) and silently opens Android Studio when
# that match fails. Instead, build one APK whose `frontendDist` is the dev
# server's URL — Tauri then embeds no assets and loads that URL at startup — and
# install it everywhere. Every device shows the same Vite, with HMR.
#
# `beforeBuildCommand` is emptied too: there is no static frontend to build.
ANDROID_DEV_CONFIG="{\"build\":{\"frontendDist\":\"http://localhost:$VITE_PORT\",\"beforeBuildCommand\":\"\"}}"

start_android() {
  local serials
  serials=$(android_serials)
  [ -n "$serials" ] || die "No Android devices attached (check 'adb devices')."

  reverse_ports

  log "Building the dev APK (loads http://localhost:$VITE_PORT) — log: $LOG_DIR/android.log"
  (cd "$REPO_ROOT/desktop" && cargo tauri android build --target aarch64 --debug \
      -c "$ANDROID_DEV_CONFIG" >"$LOG_DIR/android.log" 2>&1) \
    || die "APK build failed. See $LOG_DIR/android.log"

  [ -f "$REPO_ROOT/desktop/$APK" ] || die "APK not found at desktop/$APK"

  for serial in $serials; do
    log "Installing on $serial"
    adb -s "$serial" install -r "$REPO_ROOT/desktop/$APK" >/dev/null \
      || die "Install failed on $serial (MIUI: confirm the prompt on the device)."
    adb -s "$serial" shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
    adb -s "$serial" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    log "Launched on $serial"
  done
}

# The macOS app embeds its own atomic-server on 9883, against the same ReDB in
# ~/Library/Application Support/atomic-data. A standalone atomic-server holds
# that lock, so the app would panic on boot ("Database already open"). They are
# mutually exclusive — and you don't need both: the browser on 6747 happily
# talks to whichever server owns 9883.
#
# Android is unaffected: each device runs its own server, on its own storage.
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
  android) start_vite; start_android ;;
  all)     start_vite; start_android; start_macos ;;
  *)       die "Usage: $0 [all|vite|macos|android]" ;;
esac

log "Browser: http://localhost:$VITE_PORT"
log "Ctrl-C to stop. Logs in $LOG_DIR"
wait
