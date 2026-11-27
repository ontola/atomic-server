#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
test "$(uname -s)" = Linux
test -f ../atomic-saas/Cargo.toml
# Build-only callers run Clippy and each real recovery case independently.
BUILD_ONLY="${NATIVE_RECOVERY_BUILD_ONLY:-false}"
case "$BUILD_ONLY" in true|false) ;; *) echo 'NATIVE_RECOVERY_BUILD_ONLY must be true or false' >&2; exit 2 ;; esac
ARTIFACT_DIR="${NATIVE_RECOVERY_ARTIFACT_DIR:-/artifacts}"
mkdir -p target/native-recovery-ci "$ARTIFACT_DIR"
export CARGO_BUILD_BUILD_DIR="$ROOT/target/build"
export CARGO_TARGET_DIR="$ROOT/target"
export PATH="$ROOT/browser/node_modules/.bin:$PATH"
export VITE_E2E=true VITE_ATOMIC_SERVER_URL=http://localhost:9883
export VITE_MANAGED_PORTAL_URL=http://localhost:3031
export VITE_MANAGED_API_BASE=http://localhost:3031/api
export VITE_SENTRY_DSN=''

pnpm -C browser install --frozen-lockfile
# Build the app dependency closure plus the separately embedded form runtime.
# One package at a time also serializes the shared localization writer.
pnpm -C browser --recursive --workspace-concurrency=1 \
  --filter '@tomic/data-browser^...' --filter '@tomic/form-app...' run build
pnpm -C browser/data-browser build:wasm
# The embedded HTTP server and the real WebView each need their own bundle.
pnpm -C browser/data-browser exec vite build
TAURI=1 pnpm -C browser/data-browser exec vite build --outDir dist-tauri
test -s browser/data-browser/dist-tauri/index.html
grep -q '<script' browser/data-browser/dist-tauri/index.html
export TAURI_CONFIG='{"productName":"Atomic Native Recovery CI","identifier":"io.ontola.atomicserver.native-recovery-ci","build":{"devUrl":null,"beforeBuildCommand":""},"app":{"withGlobalTauri":true,"windows":[{"title":"Atomic Native Recovery CI","width":1100,"height":760,"incognito":true}]},"bundle":{"active":false}}'
cargo build --locked -p atomic-server-tauri -p atomic_lib \
  --features atomic-server-tauri/native-recovery-tests \
  --bin atomic-server-tauri --example native_late_file_peer --example native_vault_remove_blob
if [[ "$BUILD_ONLY" != true ]]; then
  cargo clippy --locked -p atomic-server-tauri --features native-recovery-tests \
    --all-targets -- -D warnings
fi
# This is the actual Cloud Vault API. Its static portal is not used by these
# native tests, but RustEmbed still needs a valid portal build at compile time.
(cd ../atomic-saas/portal && npm ci && npm run build)
(cd ../atomic-saas && cargo build --locked --bin atomic-saas)
if [[ "$BUILD_ONLY" == true ]]; then exit 0; fi
export NATIVE_RECOVERY_BIN_DIR="$ROOT/target/debug"
export NATIVE_RECOVERY_SAAS_BINARY="$ROOT/target/debug/atomic-saas"
export NATIVE_RECOVERY_ARTIFACT_DIR="$ARTIFACT_DIR"
# Run the actual Tauri WebView; this is not Playwright's separate browser.
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x900x24' \
  node desktop/scripts/native-recovery/run.mjs
