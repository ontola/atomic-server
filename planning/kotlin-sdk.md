# Kotlin SDK

## Status

v1 implemented for JVM: local read / write / query / persist plus Iroh P2P.
Crate lives in `ffi/` (`atomic-ffi`), Kotlin package `dev.atomicdata`.

Android AAR / `cargo-ndk` and the Binder host are **not** built.

## Decision

Use **UniFFI**, not PyO3-style hand bindings, not `flutter_rust_bridge`, not
an HTTP client.

Kotlin is the first language where UniFFI is the obvious tool:

- UniFFI's Kotlin (and Swift) backends are first-class. Python's is not,
  which is why `python/` uses PyO3.
- [`android-data-reuse.md`](./android-data-reuse.md) already needs UniFFI:
  the on-device host must serve other apps over Binder **without a Flutter
  engine**. FRB cannot be that entry point.
- [`virtual-drive.md`](./virtual-drive.md) needs the same Swift + Kotlin
  pair for File Provider / DocumentsProvider.
- One UniFFI surface gives Swift for free when iOS wants the same v1 API.

Do **not** copy `python/src/*.rs` into a `kotlin/` crate and re-wrap `Db`.
`ffi/` is that shared surface. Python keeps its PyO3 skin.

## Shared Rust surface

`ffi/` is a small crate (excluded from the Cargo workspace) that every
non-Python / non-Flutter binding should call:

```text
atomic-ffi

  open / in_memory
  setup / load_agent / create_agent
  create_drive / list_drives
  create / get / query / delete / flush
  Resource: get/set/save/destroy_resource / to_json
  start_peer / sync_with / announce / wait_for
```

Callers:

| Binding | Today | Target |
| --- | --- | --- |
| Python | PyO3 talks to `Db` directly | keep PyO3; point it at `ffi`/`sdk` when convenient |
| Flutter | FRB `simple.rs` mixes store + canvas | store group can call the same helpers; canvas stays FRB |
| Kotlin / Swift | UniFFI over `ffi/` (Kotlin JVM done) | Swift generate from the same crate |
| Android host | none | same UniFFI, then Binder in Kotlin |
| WASM | `ClientDb` | later; OPFS constraints differ |

This is a thin slice of [`atomic-lib-runtime.md`](./atomic-lib-runtime.md)
`AtomicNode` — enough for local CRUD + Iroh, not events / outbox / WS yet.

## v1 Kotlin product scope (match Python)

```kotlin
val store = Store.open(path)          // or Store.inMemory()
val setup = store.setup("Ada")
val note = store.create(Urls.PLAIN_TEXT, "Hello", setup.driveSubject, mapOf("description" to "offline"))
note.set(Urls.DESCRIPTION, "offline")
note.save()
val got = store.get(note.subject())
store.query(setup.driveSubject, null, null, null, null, 0u)
store.flush()
val node = store.startPeer()
// other.syncWith(node, null)
```

`Resource.destroyResource()` deletes the resource. UniFFI already uses
`destroy()` for FFI handle teardown, so the method cannot be named
`destroy()` in Kotlin.

Iroh belongs in Kotlin v1 the same way it does in Python — local CRUD
without P2P is not the product. `startPeer` is process-global (one Iroh
`Router` / NodeID per OS process). Two nodes = two processes.

## What Kotlin adds that Python does not

- **Process lifetime.** An Android host can be killed the moment the caller
  unbinds. `flush()` after every user-visible write is load-bearing, not
  polite. See android-data-reuse.
- **One store per device.** The in-process UniFFI SDK is the *host* path.
  Other apps should not each open a redb file. The Binder client SDK is a
  later layer on top of this, not a second store.
- **redb exclusive lock.** Same as Python: one process owns the file. On
  Android that is the elected host, not "whoever imported the AAR".

## Layout

```text
ffi/                    # excluded from the Cargo workspace
  Cargo.toml            # uniffi, atomic_lib (db-redb, iroh, discovery)
  src/lib.rs            # UniFFI scaffolding
  src/{store,resource,peer,convert}.rs
  uniffi.toml           # package_name = dev.atomicdata
  kotlin/               # Gradle JVM + generated bindings + JUnit
  generate-kotlin.sh
```

## Still open

1. Android AAR + `cargo-ndk` + rustls-platform-verifier JNI init.
2. Swift generate from the same crate.
3. Binder host/client (`android-data-reuse.md`).
4. Point Python at a shared `atomic_lib::sdk` (optional; PyO3 stays).

## Not this work

- Rewriting the Python SDK onto UniFFI. PyO3 stays.
- Replacing Flutter's FRB with UniFFI. FRB stays for Dart; UniFFI is the
  non-Flutter native entry.
- Wear OS / watch HTTP clients (`habits-app.md`). Different product.
