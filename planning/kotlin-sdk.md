# Kotlin SDK

## Status

Decision, not built. Same *product* scope as the Python v1 SDK
([`python-sdk.md`](./python-sdk.md)): local read / write / query / persist
over `atomic_lib`. Different *binding*.

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
- One UDL gives Swift for free when iOS wants the same v1 surface.

Do **not** copy `python/src/*.rs` into a `kotlin/` crate and re-wrap `Db`.
That is how the binding zoo grows. The Python v1 API is the *shape* to
expose, not the code to duplicate.

## Shared Rust surface first

Before (or as the first commit of) the Kotlin work, extract the generic
store API into one Rust module that every binding calls:

```text
atomic_lib::sdk  (or a small atomic-ffi crate)

  open / in_memory
  setup / load_agent / create_agent
  create_drive / list_drives
  create / get / query / delete / flush
  Resource: get/set/save/destroy / to_json
```

Callers:

| Binding | Today | Target |
| --- | --- | --- |
| Python | PyO3 talks to `Db` directly | keep PyO3; point it at `sdk` when convenient |
| Flutter | FRB `simple.rs` mixes store + canvas | store group calls `sdk`; canvas stays FRB |
| Kotlin / Swift | none | UniFFI over `sdk` |
| Android host | none | same UniFFI, then Binder in Kotlin |
| WASM | `ClientDb` | later; OPFS constraints differ |

This is a thin slice of [`atomic-lib-runtime.md`](./atomic-lib-runtime.md)
`AtomicNode` — enough for local CRUD, not events / outbox / transport yet.

`flutter/rust/src/api/simple.rs` already listed the groups. Steal those, drop
canvas/history/peer from v1.

## v1 Kotlin product scope (match Python)

```kotlin
val store = Store.open(path)          // or Store.inMemory()
val setup = store.setup("Ada")
val note = store.create(Urls.PLAIN_TEXT, name = "Hello", parent = setup.driveSubject)
note.set(Urls.DESCRIPTION, "offline")
note.save()
val got = store.get(note.subject)
store.query(parent = setup.driveSubject)
store.flush()
```

Ship as an AAR (`dev.atomicdata:sdk`) for JVM + Android. JVM-only is enough
to test the binding; Android needs `cargo-ndk` and rustls-platform-verifier
JNI init (known pitfall from the Android build work).

Same v1 exclusions as Python: no WS/Iroh, no blobs, no history. Sync waits
until the shared `sdk` grows it, rather than each language inventing a
session API.

## What Kotlin adds that Python does not

- **Process lifetime.** An Android host can be killed the moment the caller
  unbinds. `flush()` after every user-visible write is load-bearing, not
  polite. See android-data-reuse.
- **One store per device.** The in-process UniFFI SDK is the *host* path.
  Other apps should not each open a redb file. The Binder client SDK is a
  later layer on top of this, not a second store.
- **redb exclusive lock.** Same as Python: one process owns the file. On
  Android that is the elected host, not "whoever imported the AAR".

## Layout (when built)

```text
ffi/                    # or kotlin/ — excluded from the Cargo workspace
  Cargo.toml            # uniffi, atomic_lib (db-redb)
  src/lib.rs            # thin UniFFI scaffolding
  src/atomic.udl        # the sdk surface
  android/              # Gradle AAR
  tests/                # JVM unit tests against in-memory store
```

Exclude from the workspace like `python/` and `flutter/rust`.

## Order

1. Extract `atomic_lib::sdk` (or `atomic-ffi`) with in-process Rust tests.
   No new language yet. This is the useful prerequisite.
2. UniFFI + JVM tests for the same cases as `python/tests/`.
3. Android AAR + `cargo-ndk`.
4. Only then Binder host/client (`android-data-reuse.md`).

Skipping step 1 and writing Kotlin-only wrappers around `Db` will have to
be rewritten when Swift, the Android host, and `AtomicNode` show up.

## Not this work

- Rewriting the Python SDK onto UniFFI. PyO3 stays.
- Replacing Flutter's FRB with UniFFI. FRB stays for Dart; UniFFI is the
  non-Flutter native entry.
- Wear OS / watch HTTP clients (`habits-app.md`). Different product.
