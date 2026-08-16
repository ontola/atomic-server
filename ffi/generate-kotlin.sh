#!/usr/bin/env bash
# Rebuild the cdylib and regenerate committed Kotlin bindings.
set -euo pipefail
cd "$(dirname "$0")"
cargo build
cargo run --bin uniffi-bindgen -- generate \
  --library target/debug/libatomic_ffi.so \
  --language kotlin \
  --out-dir kotlin/src/main/kotlin \
  --no-format
