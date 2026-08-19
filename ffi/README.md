# atomic-ffi / Kotlin SDK

Local-first [Atomic Data](https://atomicdata.dev) for the JVM. This crate
exposes `atomic_lib` through [UniFFI](https://mozilla.github.io/uniffi-rs/).
Kotlin is the first generated language; Swift can use the same surface later.

This is **not** an HTTP-only client. Reads and writes go to a local [redb]
database. Edits are signed Loro CRDT commits. Sync is Iroh:
`startPeer()`, hand the node URI to another device, `syncWith()`. HTTP GET of
`https://` subjects loads schema and other external resources; pass `server`
for `/search` and `saveRemote()` (POST `/commit`).

[redb]: https://github.com/cberner/redb

Python stays on PyO3 (`../python`). Do not clone this crate to add another
hand-rolled binding.

The crate is **excluded from the Cargo workspace** (same reason as
`python/` and `flutter/rust`): workspace clippy / nextest should not compile
UniFFI + Iroh on every Rust CI run.

## Layout

```text
ffi/
  src/                 UniFFI objects: Store, Resource, Iroh helpers
  uniffi.toml          package_name = dev.atomicdata
  kotlin/              Gradle JVM project + generated bindings
  generate-kotlin.sh   cargo build + uniffi-bindgen
```

Android AAR / `cargo-ndk` is not in this tree yet.

## Build

Needs a Rust toolchain and JDK 21.

```bash
cd ffi
cargo test                          # in-process Rust tests (no Iroh start)
./generate-kotlin.sh                # refresh kotlin/src/main/kotlin/dev/atomicdata/atomic_ffi.kt
cd kotlin && ./gradlew test         # JVM CRUD + two-process Iroh
```

`./gradlew test` expects `ffi/target/debug/libatomic_ffi.so` (or `.dylib` /
`.dll`) on `jna.library.path`.

## Quick start

```kotlin
import dev.atomicdata.Store
import dev.atomicdata.Urls

val store = Store.open("./my-atomic-data")
val setup = store.setup("Ada")

val note = store.create(
    Urls.PLAIN_TEXT,
    "Hello",
    null,
    mapOf("description" to "A locally stored note"),
)
note.set(Urls.DESCRIPTION, "Edited offline")
note.save()

val got = store.get(note.subject())
println("${got?.get("name")} ${got?.get("description")}")

for (child in store.query(setup.driveSubject, null, null, null, null, 0u)) {
    println("${child.subject()} ${child.name()}")
}

store.flush()

val node = store.startPeer()   // did:ad:node:…
// other.syncWith(node, null)
```

`Resource.destroyResource()` deletes the resource. It is not named
`destroy()` because UniFFI already uses that for FFI handle teardown.

Talk to a running AtomicServer:

```kotlin
val store = Store.open("./my-atomic-data", "https://atomicdata.dev")
val page = store.get("https://atomicdata.dev")   // HTTP GET + cache
val hits = store.search("folder", 10u)           // GET /search
note.saveRemote()                                // POST /commit
```

Two Iroh nodes cannot share one process — `startPeer` is process-global,
same as Flutter and Python.

## What this is not (yet)

WebSocket-to-server `SyncSession` is not wrapped. Blobs and history are not
wrapped. Android AAR / Binder host is a later layer
(`planning/android-data-reuse.md`). Iroh P2P is.
