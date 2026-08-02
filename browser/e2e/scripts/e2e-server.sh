#!/usr/bin/env bash
#
# Runs the atomic-server the e2e suite talks to, against a data directory of its
# own.
#
# Which port? Whatever the data-browser is configured to talk to —
# `VITE_ATOMIC_SERVER_URL` in `browser/data-browser/.env.development`, overridden
# by `.env.development.local` if present. This is easy to get wrong: the suite's
# own `SERVER_URL` (default 9883) only points the test *helpers*, while the app
# the tests drive uses the vite env. Start a server on 9883 while the SPA is
# pointed at 9885 and every test fails on a connection refused that names neither.
#
# Why a separate store: sharing yours means every run adds drives, tables and
# rows to the store you actually work in, and a store with a few hundred runs'
# worth of that makes the suite fail on timing rather than on bugs — the totals
# footer and the template specs start losing races they win in isolation. A red
# run then tells you nothing.
#
#   ./scripts/e2e-server.sh           # start (keeps whatever is already there)
#   ./scripts/e2e-server.sh --fresh   # wipe the e2e store first
#
# Safe to wipe: this directory only ever holds test data.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STORE="${ATOMIC_E2E_STORE:-$REPO_ROOT/.e2e-store}"
BINARY="${ATOMIC_E2E_BINARY:-$REPO_ROOT/target/debug/atomic-server}"
ENV_DIR="$REPO_ROOT/browser/data-browser"

# The last definition wins, and `.env.development.local` overrides the committed
# default — the same precedence vite applies.
read_server_url() {
  local url=''
  local file
  for file in "$ENV_DIR/.env.development" "$ENV_DIR/.env.development.local"; do
    if [[ -f "$file" ]]; then
      local found
      found=$(grep -E '^\s*VITE_ATOMIC_SERVER_URL=' "$file" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)
      [[ -n "$found" ]] && url="$found"
    fi
  done
  echo "$url"
}

SERVER_URL="${ATOMIC_E2E_SERVER_URL:-$(read_server_url)}"

if [[ -z "$SERVER_URL" ]]; then
  echo "Could not read VITE_ATOMIC_SERVER_URL from $ENV_DIR/.env.development*" >&2
  echo "Set ATOMIC_E2E_SERVER_URL=http://localhost:PORT and retry." >&2
  exit 1
fi

PORT="${SERVER_URL##*:}"
PORT="${PORT%%/*}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Could not read a port out of '$SERVER_URL'" >&2
  exit 1
fi

if [[ "${1:-}" == "--fresh" ]]; then
  echo "Wiping $STORE"
  rm -rf "$STORE"
fi

if [[ ! -x "$BINARY" ]]; then
  echo "No server binary at $BINARY" >&2
  echo "Build one first:" >&2
  echo "  ATOMICSERVER_SKIP_JS_BUILD=true cargo build -p atomic-server" >&2
  exit 1
fi

# A port already in use is almost always your own dev server. Say so, rather
# than letting redb fail with "Database already open" a minute later.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something is already listening on $PORT." >&2
  echo "If that is your dev server, stop it first — the suite needs that port," >&2
  echo "because it is what $ENV_DIR/.env.development points the app at." >&2
  exit 1
fi

mkdir -p "$STORE"

# The store degrades the suite surprisingly fast: measured on this repo,
# `aggregates.spec.ts` passes in 10s on a fresh store and fails outright on a
# 324MB one, which is about two full suite runs' worth. Say so, because the
# failure mode looks nothing like its cause.
SIZE_MB=$(du -sm "$STORE" 2>/dev/null | cut -f1 || echo 0)

if [[ "$SIZE_MB" -gt 150 ]]; then
  echo
  echo "NOTE: the e2e store is ${SIZE_MB}MB. Past ~150MB some specs start failing"
  echo "      on timing rather than on bugs. Restart with --fresh if a failure"
  echo "      does not reproduce when you run that spec alone."
  echo
fi

echo "Serving e2e on $SERVER_URL with its own store at $STORE"
echo "Run the tests with a matching helper URL:"
echo "  SERVER_URL=$SERVER_URL pnpm test-e2e"

# `ATOMIC_REPOPULATE_DEFAULTS` so an existing e2e store picks up vocabulary added
# since it was created: a store seeded before a Property existed can never
# receive it otherwise, and every test using that Property fails on a 404 that
# looks nothing like the cause.
exec env \
  ATOMIC_DATA_DIR="$STORE/data" \
  ATOMIC_CONFIG_DIR="$STORE/config" \
  ATOMIC_CACHE_DIR="$STORE/cache" \
  ATOMIC_PORT="$PORT" \
  ATOMIC_DOMAIN=localhost \
  ATOMIC_REPOPULATE_DEFAULTS=true \
  "$BINARY"
