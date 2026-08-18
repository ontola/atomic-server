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
#   ./scripts/e2e-server.sh              # start; wipes the store if it is oversized
#   ./scripts/e2e-server.sh --fresh      # wipe the e2e store first, always
#   ./scripts/e2e-server.sh --keep-store # keep an oversized store (warns instead)
#   ./scripts/e2e-server.sh --stale-ok   # start even if the binary predates its sources
#
# Safe to wipe: this directory only ever holds test data.
#
# Two things this refuses to let you do silently, because both produce a
# failure list that looks like real bugs and is not:
#   - run against a store big enough to fail specs on timing (it wipes it)
#   - run against a binary older than its sources (it stops and tells you)
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

FRESH=false
KEEP_STORE=false
STALE_OK=false

for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=true ;;
    --keep-store) KEEP_STORE=true ;;
    --stale-ok) STALE_OK=true ;;
    -h|--help)
      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--fresh] [--keep-store] [--stale-ok]" >&2
      exit 1
      ;;
  esac
done

if [[ "$FRESH" == true ]]; then
  echo "Wiping $STORE"
  rm -rf "$STORE"
fi

if [[ ! -x "$BINARY" ]]; then
  echo "No server binary at $BINARY" >&2
  echo "Build one first:" >&2
  echo "  ATOMICSERVER_SKIP_JS_BUILD=true cargo build -p atomic-server" >&2
  exit 1
fi

# Is the binary older than the sources that go into it? This matters more than
# it looks: `build.rs` embeds the data-browser bundle, and the invite and
# dev-drive pages are served from THAT copy rather than from vite. So a binary
# built on another branch serves one frontend on those pages and vite serves
# another everywhere else, and the specs that cross the boundary fail for
# reasons visible nowhere in their output. Checked against source mtimes rather
# than a commit date, so switching branches and editing a file both count.
stale_source() {
  find "$REPO_ROOT/server/src" \
       "$REPO_ROOT/lib/src" \
       "$REPO_ROOT/browser/data-browser/src" \
       "$REPO_ROOT/browser/lib/src" \
       -type f -newer "$BINARY" -print -quit 2>/dev/null
}

if [[ "$STALE_OK" != true ]] && [[ -n "$(stale_source)" ]]; then
  echo "The server binary is older than the sources it is built from." >&2
  echo "  binary: $BINARY" >&2
  echo "  newer:  $(stale_source)" >&2
  echo >&2
  echo "Rebuild it (this also refreshes the embedded frontend bundle):" >&2
  echo "  cargo build -p atomic-server" >&2
  echo >&2
  echo "Pass --stale-ok to start anyway. That is fine when the specs you are" >&2
  echo "running only touch vite-served pages; it is not fine for anything" >&2
  echo "going through invite, dev-drive, or a server-side plugin hook." >&2
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
# This used to print a note and carry on. A note is the wrong shape for this:
# the usual way to start this server is in the background with output going to
# a log, so nobody reads it, and the reward for missing it is a failure list
# that changes every run. Wipe instead — the directory only ever holds test
# data, and one full suite is enough to cross the line.
SIZE_MB=$(du -sm "$STORE" 2>/dev/null | cut -f1 || echo 0)

if [[ "$SIZE_MB" -gt 150 ]] && [[ "$FRESH" != true ]]; then
  if [[ "$KEEP_STORE" == true ]]; then
    echo
    echo "WARNING: the e2e store is ${SIZE_MB}MB and --keep-store was passed."
    echo "         Past ~150MB specs start failing on timing rather than on"
    echo "         bugs, and the set changes run to run. Do not trust a failure"
    echo "         list from this store without reproducing it on a fresh one."
    echo
  else
    echo "The e2e store is ${SIZE_MB}MB — past the ~150MB point where specs"
    echo "start failing on timing. Wiping it (pass --keep-store to keep it)."
    rm -rf "$STORE"
    mkdir -p "$STORE"
  fi
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
