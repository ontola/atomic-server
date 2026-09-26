#!/usr/bin/env bash
# Build a clearly named local-service Mac .app without changing release config.
# Run the app only in a separate macOS test user: default WKWebView storage can
# otherwise expose an existing Atomic Server identity to the test build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -d /Volumes/AtomicMacAcceptance ]]; then
  DEFAULT_RUN=/Volumes/AtomicMacAcceptance/run
  DEFAULT_TARGET=/Volumes/AtomicMacAcceptance/target
else
  DEFAULT_RUN=/private/tmp/atomic-mac-acceptance
  DEFAULT_TARGET="$ROOT/target"
fi
RUN="${ATOMIC_MAC_ACCEPTANCE_DIR:-$DEFAULT_RUN}"
TARGET="${ATOMIC_MAC_CARGO_TARGET_DIR:-$DEFAULT_TARGET}"
BUILD_DIR="${ATOMIC_MAC_CARGO_BUILD_DIR:-$TARGET/build-cache}"
APP_NAME='Atomic Server Account Acceptance'
APP_PATH="$TARGET/release/bundle/macos/$APP_NAME.app"
export PATH="$ROOT/browser/node_modules/.bin:$ROOT/browser/lib/node_modules/.bin:$ROOT/browser/react/node_modules/.bin:$PATH"

mkdir -p "$RUN" "$TARGET" "$BUILD_DIR" "$RUN/tmp"
# wasm-opt and the linker use TMPDIR even when Cargo's target is elsewhere.
export TMPDIR="$RUN/tmp"
free_kib="$(df -Pk "$TARGET" | awk 'NR == 2 { print $4 }')"
(( free_kib >= 30 * 1024 * 1024 )) || {
  echo "Release build needs at least 30 GiB free on this volume; only $((free_kib / 1024 / 1024)) GiB is available." >&2
  exit 1
}
if [[ -f "$RUN/frontend.pid" ]] && kill -0 "$(cat "$RUN/frontend.pid")" 2>/dev/null; then
  echo "Stop mac-account-stack.sh first: Vite and a build must not write translation catalogs together." >&2
  exit 1
fi
while read -r pid; do
  [[ -n "$pid" ]] || continue
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  if [[ "$cwd" == "$ROOT/browser/data-browser" ]]; then
    echo "Another Vite process is serving this checkout; stop it before building." >&2
    exit 1
  fi
done < <(pgrep -f '[v]ite' || true)

cat > "$RUN/tauri.acceptance.conf.json" <<'JSON'
{
  "productName": "Atomic Server Account Acceptance",
  "identifier": "io.ontola.atomicserver.account-acceptance",
  "build": { "beforeBuildCommand": "" },
  "app": { "windows": [{ "title": "Atomic Server Account Acceptance" }] },
  "bundle": { "targets": ["app"] }
}
JSON

# Use the installed project binaries directly. pnpm 11 currently attempts to
# fetch the pinned pnpm 10 release and can fail signature verification offline;
# bypassing the launcher does not change dependencies or the lockfile.
(cd "$ROOT/browser/lib" && ./node_modules/.bin/tsup)
(cd "$ROOT/browser/react" && ./node_modules/.bin/tsup)
(
  cd "$ROOT/wasm"
  CARGO_TARGET_DIR="$TARGET/wasm-pack" CARGO_BUILD_BUILD_DIR="$BUILD_DIR" \
    env -u CARGO_ENCODED_RUSTFLAGS -u RUSTFLAGS \
    wasm-pack build --target web --out-dir "$RUN/wasm-pkg"
  cp "$RUN/wasm-pkg/atomic_wasm.js" "$RUN/wasm-pkg/atomic_wasm_bg.wasm" "$ROOT/browser/data-browser/public/wasm/"
)
(
  cd "$ROOT/browser/data-browser"
  TAURI=1 VITE_ATOMIC_SERVER_URL=http://localhost:9883 \
    VITE_MANAGED_PORTAL_URL=http://localhost:49238 \
    VITE_MANAGED_API_BASE=http://localhost:3031/api VITE_SENTRY_DSN='' \
    ./node_modules/.bin/vite build
)
(
  cd "$ROOT/desktop"
  CARGO_TARGET_DIR="$TARGET" CARGO_BUILD_BUILD_DIR="$BUILD_DIR" \
    APPLE_SIGNING_IDENTITY=- cargo tauri build \
    --features account-acceptance \
    --config "$RUN/tauri.acceptance.conf.json" --bundles app
)

[[ -d "$APP_PATH" ]] || { echo "Expected app missing: $APP_PATH" >&2; exit 1; }
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Contents/Info.plist")"
[[ "$bundle_id" == io.ontola.atomicserver.account-acceptance ]] || {
  echo "Unexpected bundle identifier: $bundle_id" >&2
  exit 1
}
echo "Built $APP_PATH"
echo "This package points to http://localhost:49238 and http://localhost:3031/api."
echo "Launch it in a separate macOS test user for persistent-profile acceptance."
