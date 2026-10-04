#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web (cloud sessions).
#
# 1. Exports session environment variables.
# 2. Runs cloud-setup.sh: toolchains, pnpm install, Playwright browsers. Close
#    to a no-op when the environment's setup script already ran it (see
#    AGENTS.md); otherwise it installs them here, which takes a few minutes.
# 3. Starts cloud-build.sh in the background (the @tomic packages, then a
#    debug atomic-server) and tells the agent how to wait for it.
#
# Keep these scripts in sync with the repo's requirements — see AGENTS.md.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
HOOKS="$REPO/.claude/hooks"
STATE="${ATOMIC_SETUP_STATE:-/tmp/atomic-setup}"
mkdir -p "$STATE"

# stdout is reserved for the JSON below; everything else goes to the log.
exec 3>&1 >>"$STATE/setup.log" 2>&1
echo "==> session-start $(date -u +%FT%TZ)"

# --- Session environment ----------------------------------------------------
# atomic-server binds to `::` by default, and cloud containers have no IPv6
# ("Address family not supported by protocol"). ATOMIC_IP makes `cargo run`,
# browser/lib's integration fixture and the e2e server bind IPv4 instead.
if [ ! -e /proc/net/if_inet6 ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export ATOMIC_IP="${ATOMIC_IP:-0.0.0.0}"' >>"$CLAUDE_ENV_FILE"
fi

# --- Tools ------------------------------------------------------------------
start=$(date +%s)
REPO="$REPO" bash "$HOOKS/cloud-setup.sh"
echo "cloud-setup.sh took $(($(date +%s) - start))s"

# --- Background build -------------------------------------------------------
if [ -f "$STATE/server.done" ]; then
  context="Cloud setup: toolchains, browser/node_modules, the @tomic packages \
($(cat "$STATE/packages.done" 2>/dev/null)) and a debug atomic-server \
($(cat "$STATE/server.done")) are already built on this VM. Log: $STATE/build.log."
else
  REPO="$REPO" ATOMIC_SETUP_STATE="$STATE" setsid nohup bash "$HOOKS/cloud-build.sh" \
    </dev/null >>"$STATE/build.log" 2>&1 &
  context="Cloud setup: toolchains, wasm-pack, Playwright browsers and \
browser/node_modules are ready. A background job (.claude/hooks/cloud-build.sh) \
is still building the @tomic packages and then a debug atomic-server, which \
also builds data-browser and the WASM; from cold that takes 10-20 minutes. \
Log: $STATE/build.log. When each step ends it writes $STATE/packages.done or \
$STATE/server.done, containing ok or failed. Reading and editing code is fine \
right away. Before JS typecheck or tests, wait for packages.done; before cargo \
builds or tests, running the server, or e2e, wait for server.done, e.g. run \
\`until [ -e $STATE/server.done ]; do sleep 10; done; cat $STATE/server.done\` \
in the background. A cargo command started earlier just waits for the build \
lock. Don't start a second pnpm install or build of the same packages meanwhile."
fi

jq -n --arg ctx "$context" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}' >&3
