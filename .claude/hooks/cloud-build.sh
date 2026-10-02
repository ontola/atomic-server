#!/usr/bin/env bash
# Background build for Claude Code cloud sessions, started by
# session-start.sh. Nothing inside the repo survives between sessions (each
# one starts from a fresh clone), so this runs every session; it is kept out
# of the hook so the agent can start working meanwhile.
#
# Progress goes to $STATE/build.log. Each step writes a marker when it ends,
# containing `ok` or `failed`:
#   $STATE/packages.done  @tomic/* packages built (typecheck, vitest)
#   $STATE/server.done    debug atomic-server built (cargo, server, e2e)
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
STATE="${ATOMIC_SETUP_STATE:-/tmp/atomic-setup}"
mkdir -p "$STATE"

# One build per VM, even if a resumed session starts the hook again.
exec 9>"$STATE/build.lock"
flock -n 9 || exit 0

mark() { echo "$2" >"$STATE/$1.done"; }

echo "==> Build @tomic workspace packages ($(date -u +%T))"
cd "$REPO/browser" || exit 1
# data-browser (which also compiles the WASM) is built by the server build.
if pnpm --filter @tomic/lib --filter @tomic/react --filter @tomic/plugin \
  --filter @tomic/service-ui --filter @tomic/edit-mode \
  --filter @tomic/cli --filter @tomic/svelte -r build; then
  mark packages ok
else
  mark packages failed
fi

# Its build.rs also builds data-browser and the WASM (wasm-pack), so the Vite
# dev server and `server/` both work afterwards. Uses the default target/:
# browser/lib's integration tests expect target/debug/atomic-server.
echo "==> Debug build of atomic-server ($(date -u +%T))"
cd "$REPO" || exit 1
if cargo build -p atomic-server; then
  mark server ok
else
  mark server failed
fi
echo "==> Done ($(date -u +%T))"
