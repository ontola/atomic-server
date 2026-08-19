# Python SDK

## Status

v1 implemented: local read / write / query / persist. Package lives in
`python/`, import `atomic_data`.

## Decision

Wrap `atomic_lib` with **PyO3 + maturin**. Do not reimplement commits, Loro,
or Ed25519 in Python. Do not ship an HTTP-**only** client as the SDK — local
redb + Iroh stay the default, and HTTP GET / search / `save_remote()` ride
the same `atomic_lib` store (schema fetch for unknown Class / Property URLs).

This matches the existing bindings:

- Browser: `wasm-bindgen` → `ClientDb` over redb/OPFS
- Flutter: `flutter_rust_bridge` → `Db` on disk
- Python: PyO3 → `Db` on disk

UniFFI would help if one IDL had to generate Swift + Kotlin + Python. The
Python API can be idiomatic on its own (dict-like `Resource`, sync methods,
context manager). Flutter already has its own bridge.

Kotlin uses UniFFI in `ffi/` — see [`kotlin-sdk.md`](./kotlin-sdk.md).
Do not clone `python/src` for that. PyO3 keeps its skin; a later
`atomic_lib::sdk` can sit under both.

The crate is **excluded from the Cargo workspace** (same reason as
`flutter/rust`): workspace `clippy` / `nextest` should not compile PyO3 on
every Rust CI run.

## v1 surface

- `Store.open(path, server=None)` / `Store.in_memory(server=None)`
- `setup`, `load_agent`, `create_agent`, `create_drive`
- `create`, `get` (HTTP GET for unknown `https://` subjects), `search`, `query`, `delete`, `flush`
- Iroh: `start_peer`, `announce`, `sync_with`, `wait_for`, live push on `save`
- `Resource` dict access, `save`, `save_remote`, `destroy`, `to_dict`, `to_json`
- `atomic_data.urls` constants

Python calls are synchronous. Each one `block_on`s a process-wide tokio
runtime and drops the GIL for the Rust work.

## Sync

Iroh is in. Local CRUD without P2P is not the product.

- `start_peer()` / `peer_id` / `announce()` / `sync_with(node_id)`
- `.save()` broadcasts a live Loro update when peers are connected
- `wait_for(subject)` observes local or peer changes
- Two-process pytest (`tests/test_iroh.py`) — one node per OS process

WS `SyncSession` (unified-sync) is still the next *shared* API. Python
ships the same Iroh calls Flutter already has, because that is what
makes two devices converge today.

## Not in v1

- WebSocket-to-server session
- Blobs
- History / time-travel
- Code-first schema (see `json-schema-code-first.md`)
- PyPI publish / Dagger CI job (GitHub Actions `Python SDK` covers pytest on Linux and Windows)

## Tests

```bash
cd python && uv run pytest
```
