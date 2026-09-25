#!/usr/bin/env bash
#
# Start an isolated atomic-server + data-browser for a live user-testing
# session, with the dev-only interaction logger on and demo data seeded.
#
#   scripts/demo-session/demo-session.sh [branch] [options]
#
#   branch            atomic-server branch or commit to test (default: the
#                     branch this script's checkout is on). Uses that branch's
#                     existing worktree if there is one, else makes one under
#                     $DEMO_HOME/worktrees/ (detached, for a commit).
#   --port N          atomic-server port (default 9893)
#   --vite-port N     Vite dev server port (default 6757)
#   --seed NAME       seed to run on first open (default: calendar; "none" to skip)
#   --no-build        start from what is already built
#   --build-only      build, then exit without starting anything
#
# Every run gets a fresh data dir under $DEMO_HOME/sessions/<stamp>-<branch>/,
# next to server.log, vite.log and ux.jsonl (the interaction log). Ctrl-C
# stops both processes; the session dir is kept for the findings report.
#
# The tooling (this script, the logger plugin and client, and the seeds)
# always comes from THIS checkout, so it works against branches that predate
# it. See README.md next to this file.
set -euo pipefail

TOOLING="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TOOLING/../.." && pwd)"
DEMO_HOME="${DEMO_HOME:-$HOME/.cache/atomic-demo}"
PORT=9893
VITE_PORT=6757
SEED=calendar
BUILD=1
BUILD_ONLY=0
BRANCH=""

log() { printf '\033[36m[demo]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[demo]\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --vite-port) VITE_PORT="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --build-only) BUILD_ONLY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) die "Unknown option $1" ;;
    *) BRANCH="$1"; shift ;;
  esac
done

BRANCH="${BRANCH:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}"
SLUG="$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9._-' '-')"

[ "$BUILD_ONLY" = 1 ] || for port in "$PORT" "$VITE_PORT"; do
  if lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Port $port is in use (pid $(lsof -nP -tiTCP:"$port" -sTCP:LISTEN | head -1)). Pick another with --port/--vite-port."
  fi
done

# --- Worktree for the branch -------------------------------------------------

worktree_for() {
  git -C "$REPO_ROOT" worktree list --porcelain |
    awk -v ref="refs/heads/$1" '/^worktree /{wt=$2} $0=="branch "ref{print wt; exit}'
}

WORKTREE="$(worktree_for "$BRANCH")"

if [ -z "$WORKTREE" ] && [[ "$BRANCH" =~ ^[0-9a-f]{7,40}$ ]]; then
  # A commit (e.g. atomic-plugins' .atomic-server-ref): a detached worktree,
  # so a moving branch head can't change what is tested.
  git -C "$REPO_ROOT" fetch -q origin
  SHA="$(git -C "$REPO_ROOT" rev-parse --verify "$BRANCH^{commit}")"
  SLUG="${SHA:0:12}"
  WORKTREE="$DEMO_HOME/worktrees/$SLUG"
  if [ ! -d "$WORKTREE" ]; then
    log "Creating a detached worktree for $SHA at $WORKTREE"
    git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$SHA"
  fi
fi

if [ -z "$WORKTREE" ]; then
  WORKTREE="$DEMO_HOME/worktrees/$SLUG"
  log "Creating a worktree for $BRANCH at $WORKTREE"
  git -C "$REPO_ROOT" fetch -q origin
  if git -C "$REPO_ROOT" show-ref -q --verify "refs/heads/$BRANCH"; then
    git -C "$REPO_ROOT" worktree add "$WORKTREE" "$BRANCH"
  else
    git -C "$REPO_ROOT" worktree add --no-track -b "$BRANCH" "$WORKTREE" "origin/$BRANCH"
  fi
fi

log "Testing $BRANCH @ $(git -C "$WORKTREE" rev-parse --short HEAD) in $WORKTREE"
[ -z "$(git -C "$WORKTREE" status --porcelain)" ] ||
  log "Note: the worktree has uncommitted changes; they are included."

BROWSER="$WORKTREE/browser"
DATA_BROWSER="$BROWSER/data-browser"

# --- Build ---------------------------------------------------------------------

# True when any file under the given dirs is newer than the stamp file.
newer_than() {
  local stamp="$1"; shift
  [ ! -f "$stamp" ] && return 0
  [ -n "$(find "$@" -newer "$stamp" -type f -print -quit 2>/dev/null)" ]
}

build() {
  mkdir -p "$DEMO_HOME/stamps"
  local stamps="$DEMO_HOME/stamps/$SLUG"
  mkdir -p "$stamps"

  if newer_than "$stamps/pnpm-install" "$BROWSER/pnpm-lock.yaml" || [ ! -d "$BROWSER/node_modules" ]; then
    log "pnpm install"
    (cd "$BROWSER" && pnpm install --frozen-lockfile) && touch "$stamps/pnpm-install"
  fi

  # The workspace packages the data-browser imports from their built dist/.
  local pkgs=(lib react edit-mode plugin service-ui) dirs=() filters=()
  for pkg in "${pkgs[@]}"; do
    dirs+=("$BROWSER/$pkg/src")
    filters+=(--filter "@tomic/$pkg")
  done
  if newer_than "$stamps/js-libs" "${dirs[@]}"; then
    log "Building ${pkgs[*]}"
    (cd "$BROWSER" && pnpm "${filters[@]}" run build) && touch "$stamps/js-libs"
  fi

  # The wasm pair only depends on wasm/ and lib/; cache it by their git trees
  # so switching branches does not rebuild it (about 3 minutes) needlessly.
  local key dirty=""
  key="$(git -C "$WORKTREE" rev-parse HEAD:wasm HEAD:lib | shasum | cut -c1-16)"
  [ -z "$(git -C "$WORKTREE" status --porcelain -- wasm lib)" ] || dirty=1
  local cache="$DEMO_HOME/wasm/$key"
  if [ -n "$dirty" ] || [ ! -f "$cache/atomic_wasm_bg.wasm" ]; then
    log "Building the wasm pair (wasm-pack)"
    (cd "$WORKTREE/wasm" &&
      CARGO_TARGET_DIR="$DEMO_HOME/target-wasm" env -u CARGO_ENCODED_RUSTFLAGS -u RUSTFLAGS \
        cargo bin wasm-pack build --target web --out-dir pkg)
    mkdir -p "$cache"
    cp "$WORKTREE/wasm/pkg/atomic_wasm.js" "$WORKTREE/wasm/pkg/atomic_wasm_bg.wasm" "$cache/"
  fi
  mkdir -p "$DATA_BROWSER/public/wasm"
  cp "$cache/atomic_wasm.js" "$cache/atomic_wasm_bg.wasm" "$DATA_BROWSER/public/wasm/"

  # The server embeds a built frontend, but in a session the app comes from
  # Vite; a placeholder page saves a full production build.
  if [ ! -f "$WORKTREE/server/assets_tmp/index.html" ]; then
    mkdir -p "$WORKTREE/server/assets_tmp"
    printf '<!doctype html><title>atomic-server</title><p>Demo build: the app is served by the Vite dev server. See scripts/demo-session.</p>\n' \
      >"$WORKTREE/server/assets_tmp/index.html"
  fi

  log "cargo build -p atomic-server (target: $DEMO_HOME/target)"
  (cd "$WORKTREE" && SKIP_WASM_BUILD=1 ATOMICSERVER_SKIP_JS_BUILD=true \
    CARGO_TARGET_DIR="$DEMO_HOME/target" cargo build -p atomic-server)
}

[ "$BUILD" = 1 ] && build
[ "$BUILD_ONLY" = 1 ] && { log "Built $BRANCH."; exit 0; }

# --- Session dir ----------------------------------------------------------------

SESSION="$DEMO_HOME/sessions/$(date +%Y%m%d-%H%M%S)-$SLUG"
mkdir -p "$SESSION/data" "$SESSION/config" "$SESSION/cache"
# Freeze the binary: another branch's build may overwrite the shared target.
cp "$DEMO_HOME/target/debug/atomic-server" "$SESSION/atomic-server"
UX_LOG="$SESSION/ux.jsonl"
touch "$UX_LOG"
ln -sfn "$SESSION" "$DEMO_HOME/sessions/latest"

cat >"$SESSION/session.env" <<EOF
BRANCH=$BRANCH
COMMIT=$(git -C "$WORKTREE" rev-parse HEAD)
WORKTREE=$WORKTREE
SERVER_URL=http://localhost:$PORT
APP_URL=http://localhost:$VITE_PORT
UX_LOG=$UX_LOG
EOF

PIDS=()
cleanup() {
  log "Stopping"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  log "Session files kept in $SESSION"
}
trap cleanup EXIT INT TERM

# --- atomic-server ----------------------------------------------------------------

log "Starting atomic-server on http://localhost:$PORT (log: $SESSION/server.log)"
ATOMIC_DATA_DIR="$SESSION/data" \
ATOMIC_CONFIG_DIR="$SESSION/config" \
ATOMIC_CACHE_DIR="$SESSION/cache" \
ATOMIC_PORT="$PORT" \
ATOMIC_DOMAIN=localhost \
  "$SESSION/atomic-server" >"$SESSION/server.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 120); do
  curl -sf -o /dev/null "http://localhost:$PORT/" && break
  kill -0 "${PIDS[0]}" 2>/dev/null || die "atomic-server exited. See $SESSION/server.log"
  sleep 0.5
done
curl -sf -o /dev/null "http://localhost:$PORT/" || die "atomic-server did not come up. See $SESSION/server.log"

# --- Vite -------------------------------------------------------------------------

# The wrapper config is generated next to the data-browser (in its ignored
# node_modules) so Vite's default config bundler can follow static imports of
# both the branch's own vite.config.ts and this checkout's logger plugin.
VITE_CONFIG="$DATA_BROWSER/node_modules/.demo-session/vite.config.ts"
mkdir -p "$(dirname "$VITE_CONFIG")"
cat >"$VITE_CONFIG" <<EOF
// Generated by $TOOLING/demo-session.sh; do not edit.
import base from '../../vite.config';
import { uxLogPlugin } from '$TOOLING/uxLogPlugin';

export default async (env: { command: string; mode: string }) => {
  const config = typeof base === 'function' ? await base(env) : base;

  return {
    ...config,
    root: '$DATA_BROWSER',
    plugins: [
      ...(config.plugins ?? []),
      process.env.VITE_UX_LOG === 'true' &&
        uxLogPlugin({
          logFile: '$UX_LOG',
          seedFile: '$TOOLING/seed.js',
          clientFile: '$TOOLING/uxLogClient.js',
        }),
    ],
    server: {
      ...config.server,
      port: $VITE_PORT,
      strictPort: true,
      host: 'localhost',
      open: false,
    },
  };
};
EOF

log "Starting the data-browser on http://localhost:$VITE_PORT (log: $SESSION/vite.log)"
(
  cd "$DATA_BROWSER"
  node scripts/build-website-runtime.mjs
  VITE_ATOMIC_SERVER_URL="http://localhost:$PORT" \
  VITE_UX_LOG=true \
    exec node_modules/.bin/vite --config "$VITE_CONFIG"
) >"$SESSION/vite.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 120); do
  curl -sf -o /dev/null "http://localhost:$VITE_PORT/" && break
  kill -0 "${PIDS[1]}" 2>/dev/null || die "Vite exited. See $SESSION/vite.log"
  sleep 0.5
done
curl -sf -o /dev/null "http://localhost:$VITE_PORT/" || die "Vite did not come up. See $SESSION/vite.log"

OPEN="http://localhost:$VITE_PORT/app/dev-drive"
[ "$SEED" != none ] && OPEN="$OPEN?demo-seed=$SEED"
echo "OPEN_URL=$OPEN" >>"$SESSION/session.env"

log "Ready."
log "  Open:        $OPEN"
log "               (makes a fresh agent + drive in the browser, seeds '$SEED', opens it)"
log "  Interaction: tail -f $UX_LOG"
log "  Server:      tail -f $SESSION/server.log"
log "Ctrl-C to stop."
wait
