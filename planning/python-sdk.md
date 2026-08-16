# Python SDK

## Status

v1 implemented: local read / write / query / persist. Package lives in
`python/`, import `atomic_data`.

## Decision

Wrap `atomic_lib` with **PyO3 + maturin**. Do not reimplement commits, Loro,
or Ed25519 in Python. Do not ship an HTTP-only client as the SDK.

This matches the existing bindings:

- Browser: `wasm-bindgen` → `ClientDb` over redb/OPFS
- Flutter: `flutter_rust_bridge` → `Db` on disk
- Python: PyO3 → `Db` on disk

UniFFI would help if one IDL had to generate Swift + Kotlin + Python. The
Python API can be idiomatic on its own (dict-like `Resource`, sync methods,
context manager). Flutter already has its own bridge.

Kotlin is next and **does** use UniFFI — see [`kotlin-sdk.md`](./kotlin-sdk.md).
Do not clone `python/src` for that. Extract a shared `atomic_lib::sdk`
surface first; PyO3 can keep its skin.

The crate is **excluded from the Cargo workspace** (same reason as
`flutter/rust`): workspace `clippy` / `nextest` should not compile PyO3 on
every Rust CI run.

## v1 surface

- `Store.open(path)` / `Store.in_memory()`
- `setup`, `load_agent`, `create_agent`, `create_drive`
- `create`, `get`, `query`, `delete`, `flush`
- `Resource` dict access, `save`, `destroy`, `to_dict`, `to_json`
- `atomic_data.urls` constants

Python calls are synchronous. Each one `block_on`s a process-wide tokio
runtime and drops the GIL for the Rust work.

## Not in v1

- **Iroh / WS sync.** Not blocked — `atomic_lib` already has it, Flutter
  already wraps it (`start_peer`, `peer_announce`, `peer_sync`). Left out
  because v1 was the binding + local redb loop, Iroh is a heavy feature
  (`iroh` + `discovery`, live `Router`, one node per process), and
  [`unified-sync.md`](./unified-sync.md) does not want a new language to
  ship `peer_sync()` as the primary API. Next network work should be a
  `SyncSession` (WS or Iroh), not a Python-only QR/peer helper.
- Blobs
- History / time-travel
- Code-first schema (see `json-schema-code-first.md`)
- PyPI publish / Dagger CI job

## Tests

```bash
cd python && maturin develop && pytest
```
