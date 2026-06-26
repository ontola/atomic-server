# Dev cargo-lock contention

> Status: planned 2026-05-28. DX. Quick win.

## Problem

Multiple times this session: `Blocking waiting for file lock on
artifact directory` when running `cargo run` or `cargo test`. The
culprit is one of:

- `rust-analyzer` background check
- `pnpm dev` triggering `wasm-pack` (which spawns its own cargo)
- A test suite still tearing down

Each holds an exclusive lock on `target/`. Building competing artifacts
serializes, killing iteration speed (cargo run after a code change can
take 5+ minutes just waiting).

## Symptom

`cargo run` blocks indefinitely or errors out. Have to manually find
and kill the offending pid. Happened ≥5 times in the last day.

## Proposal

Give each "tool" its own `target/` directory:

| Tool | Target dir | How to set |
|---|---|---|
| Manual `cargo` | `target/` | default |
| `rust-analyzer` | `target/rust-analyzer/` | `rust-analyzer.cargo.targetDir` in VS Code settings.json (or `.cargo/config.toml` per-workspace) |
| `wasm-pack` | `target/wasm/` | `wasm-pack build --target ... --out-dir browser/lib/wasm` already does this for output; the *cargo* target dir can be set via `CARGO_TARGET_DIR` in the wasm build script |
| `cargo test` | `target/` | shares with manual `cargo run` (acceptable — usually not concurrent) |

Recommended: set `rust-analyzer.cargo.targetDir = "target/rust-analyzer"`
in `.vscode/settings.json` (commit it; everyone benefits). That alone
eliminates the most common offender — rust-analyzer's background check.

For wasm-pack, set `CARGO_TARGET_DIR=target/wasm` in the script that
invokes it (likely in `browser/lib/package.json` or wherever
`wasm-pack build` runs).

## Risk

Disk usage triples for `target/` (three independent build artifacts).
On modern SSDs and with a 2026-era dev box, this is noise; the time
saved per iteration pays for the GBs many times over.

## Effort

~30 minutes:

1. Add `.vscode/settings.json` entry.
2. Update the wasm-pack invocation script.
3. Document in `CONTRIBUTING.md` or `README.md` if needed.

## Concrete steps

1. `mkdir target/rust-analyzer target/wasm` (so cargo doesn't refuse
   to start).
2. `git diff` the `.vscode/settings.json` change.
3. Find the wasm-pack invocation: `rg 'wasm-pack' browser/`.
4. Wrap with `CARGO_TARGET_DIR=...`.
5. Restart VS Code; verify rust-analyzer uses the new dir
   (`ls target/rust-analyzer/debug/` should populate after a few
   minutes).
