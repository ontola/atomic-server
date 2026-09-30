#!/usr/bin/env bash
# Provisions the tools a Claude Code cloud session needs for this repo and
# warms the download caches. Every step checks first and skips what is already
# there, so a re-run on a provisioned VM takes seconds.
#
# Two callers:
# - The cloud environment's setup script (see AGENTS.md). The environment
#   cache snapshots the filesystem after it, so everything outside the repo
#   (toolchains, ~/.cargo registry, the pnpm store, Playwright browsers) is
#   free in later sessions. That snapshot is only taken when the setup script
#   finishes in about five minutes, hence the parallel downloads below.
# - session-start.sh, so sessions without that setup script still work.
#
# Every step is best-effort: a failing step logs a warning, the rest still
# runs, and the script always exits 0 (a failing setup script blocks sessions).
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
BIN=/usr/local/bin
BINARYEN=version_117

step() { echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }

# --- Rust -------------------------------------------------------------------
step "Rust toolchain from rust-toolchain.toml + wasm targets"
RUST_VERSION=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$REPO/rust-toolchain.toml")
installed=$(rustup +"$RUST_VERSION" target list --installed 2>/dev/null)
if grep -q wasm32-unknown-unknown <<<"$installed" && grep -q wasm32-wasip2 <<<"$installed"; then
  echo "Rust $RUST_VERSION already installed"
else
  rustup toolchain install "$RUST_VERSION" --profile minimal \
    --component rustfmt --component clippy \
    --target wasm32-unknown-unknown --target wasm32-wasip2 ||
    warn "rustup install failed"
fi

# Rust crates download in the background while the JS side installs.
(cd "$REPO" && cargo fetch --locked >/dev/null 2>&1 || warn "cargo fetch failed") &
cargo_fetch=$!

# --- wasm-pack + wasm-opt ---------------------------------------------------
# wasm-pack's own binaryen download fails behind the session proxy, so put
# wasm-opt on PATH; wasm-pack uses it from there.
step "wasm-pack"
WASM_PACK=$(sed -n 's/^version=//p' "$REPO/.dagger/scripts/install-wasm-pack.sh")
if wasm-pack --version 2>/dev/null | grep -qF "$WASM_PACK"; then
  echo "wasm-pack $WASM_PACK already installed"
else
  sh "$REPO/.dagger/scripts/install-wasm-pack.sh" "$BIN" || warn "wasm-pack install failed"
fi

step "binaryen (wasm-opt)"
if wasm-opt --version 2>/dev/null | grep -q "($BINARYEN)"; then
  echo "wasm-opt $BINARYEN already installed"
else
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

# --- JS dependencies --------------------------------------------------------
# Fills the pnpm store (~/.local/share/pnpm), which the environment cache
# keeps; in a fresh clone the install is then mostly hard links.
step "pnpm install"
(cd "$REPO/browser" && pnpm install --frozen-lockfile) || warn "pnpm install failed"

# --- Playwright browsers ----------------------------------------------------
# The image's preinstalled Chromium usually lags @tomic/e2e's Playwright, and
# the session proxy blocks Playwright's CDN (cdn.playwright.dev). Chrome for
# Testing builds are the same zips, mirrored on storage.googleapis.com, so
# unpack those into the directories Playwright expects.
step "Playwright browsers for @tomic/e2e"
cd "$REPO/browser/e2e" &&
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= pnpm exec playwright install --dry-run chromium chromium-headless-shell 2>/dev/null |
  awk '/Install location:/{loc=$3} /Download url:/{if (loc) print loc, $3; loc=""}' |
    while read -r loc url; do
      case "$url" in */builds/cft/*) ;; *) continue ;; esac
      if [ -f "$loc/INSTALLATION_COMPLETE" ]; then
        echo "$loc already installed"
        continue
      fi
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

step "cargo fetch"
wait "$cargo_fetch"

step "Tools ready"
exit 0
