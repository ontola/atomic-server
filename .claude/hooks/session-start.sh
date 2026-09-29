#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web (cloud sessions).
#
# Installs the pinned toolchains and warms dependency caches and builds so
# agents can lint, test and run the stack right away. The container is
# snapshotted after this hook, so later sessions start warm and every step
# below is close to a no-op on a re-run.
#
# Every step is best-effort: a failing step logs a warning and the rest still
# runs. Keep this in sync with the repo's requirements (rust-toolchain.toml,
# wasm-pack/binaryen versions, @tomic/e2e's Playwright) — see AGENTS.md.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
BIN=/usr/local/bin
BINARYEN=version_117

step() { echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }

# --- Session environment ----------------------------------------------------
# atomic-server binds to `::` by default, and cloud containers have no IPv6
# ("Address family not supported by protocol"). ATOMIC_IP makes `cargo run`,
# browser/lib's integration fixture and the e2e server bind IPv4 instead.
if [ ! -e /proc/net/if_inet6 ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  step "No IPv6: exporting ATOMIC_IP=0.0.0.0 for this session"
  echo 'export ATOMIC_IP="${ATOMIC_IP:-0.0.0.0}"' >>"$CLAUDE_ENV_FILE"
fi

# --- Rust -------------------------------------------------------------------
step "Rust toolchain from rust-toolchain.toml + wasm targets"
RUST_VERSION=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$REPO/rust-toolchain.toml")
rustup toolchain install "$RUST_VERSION" --profile minimal \
  --component rustfmt --component clippy \
  --target wasm32-unknown-unknown --target wasm32-wasip2 ||
  warn "rustup install failed"

# --- wasm-pack + wasm-opt ---------------------------------------------------
# wasm-pack's own binaryen download fails behind the session proxy, so put
# wasm-opt on PATH; wasm-pack uses it from there.
step "wasm-pack"
if ! command -v wasm-pack >/dev/null; then
  sh "$REPO/.dagger/scripts/install-wasm-pack.sh" "$BIN" || warn "wasm-pack install failed"
fi

step "binaryen (wasm-opt)"
if ! wasm-opt --version 2>/dev/null | grep -q "($BINARYEN)"; then
  tmp=$(mktemp -d)
  if curl -fsSL --retry 3 \
    "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN}/binaryen-${BINARYEN}-x86_64-linux.tar.gz" |
    tar -xz -C "$tmp"; then
    rm -rf /opt/binaryen && mv "$tmp/binaryen-${BINARYEN}" /opt/binaryen
    ln -sf /opt/binaryen/bin/wasm-opt "$BIN/wasm-opt"
    wasm-opt --version
  else
    warn "binaryen download failed"
  fi
  rm -rf "$tmp"
fi

# --- JS dependencies and workspace packages ---------------------------------
step "pnpm install"
cd "$REPO/browser" || exit 0
pnpm install --frozen-lockfile || warn "pnpm install failed"

# typecheck and vitest need these packages' dist/. data-browser (which also
# compiles the WASM) is built by the atomic-server build below.
step "Build @tomic workspace packages"
pnpm --filter @tomic/lib --filter @tomic/react --filter @tomic/plugin \
  --filter @tomic/service-ui --filter @tomic/edit-mode \
  --filter @tomic/cli --filter @tomic/svelte -r build ||
  warn "workspace package build failed"

# --- Playwright browsers ----------------------------------------------------
# The image's preinstalled Chromium usually lags @tomic/e2e's Playwright, and
# the session proxy blocks Playwright's CDN (cdn.playwright.dev). Chrome for
# Testing builds are the same zips, mirrored on storage.googleapis.com, so
# unpack those into the directories Playwright expects.
step "Playwright browsers for @tomic/e2e"
cd "$REPO/browser/e2e" || exit 0
if ! PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= pnpm exec playwright install chromium chromium-headless-shell >/dev/null 2>&1; then
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= pnpm exec playwright install --dry-run chromium chromium-headless-shell 2>/dev/null |
    awk '/Install location:/{loc=$3} /Download url:/{if (loc) print loc, $3; loc=""}' |
    while read -r loc url; do
      case "$url" in */builds/cft/*) ;; *) continue ;; esac
      [ -f "$loc/INSTALLATION_COMPLETE" ] && continue
      mirror="https://storage.googleapis.com/chrome-for-testing-public/${url#*/builds/cft/}"
      echo "Downloading $mirror"
      tmp=$(mktemp -d)
      if curl -fsSL --retry 3 "$mirror" -o "$tmp/browser.zip" && unzip -q "$tmp/browser.zip" -d "$tmp/x"; then
        rm -rf "$loc" && mkdir -p "$loc" && mv "$tmp"/x/* "$loc"/ &&
          touch "$loc/INSTALLATION_COMPLETE" "$loc/DEPENDENCIES_VALIDATED"
      else
        warn "Playwright browser download failed: $mirror"
      fi
      rm -rf "$tmp"
    done
fi

# --- Rust dependencies and a warm debug build -------------------------------
step "cargo fetch"
cd "$REPO" || exit 0
cargo fetch --locked || warn "cargo fetch failed"

# The biggest time sink in sessions: a cold server build takes tens of
# minutes. Its build.rs also builds data-browser and the WASM (wasm-pack), so
# the Vite dev server and `server/` both work afterwards. Uses the default
# target/ dir: browser/lib's integration tests expect target/debug/atomic-server.
step "Debug build of atomic-server"
cargo build -p atomic-server || warn "server build failed"

step "Done"
df -h / | tail -1
