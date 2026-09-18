{{#title Kotlin SDK for Atomic Data}}

# Kotlin SDK

Local-first [Atomic Data](atomic-data-overview.md) for the JVM. The package
wraps [`atomic_lib`](rust-lib.md) through
[UniFFI](https://mozilla.github.io/uniffi-rs/) — the same Rust store the
browser (WASM), Flutter app, and [Python SDK](python.md) use. Reads and
writes go to a local [redb](https://github.com/cberner/redb) file. Edits are
signed Loro commits. A server is optional for local CRUD and Iroh; HTTP GET /
search / `saveRemote()` are still available.

Source: [`ffi/`](https://github.com/atomicdata-dev/atomic-server/tree/develop/ffi)
(crate `atomic-ffi`, Kotlin package `dev.atomicdata`).

Python stays on PyO3. This UniFFI surface is what Swift and the Android
Binder host will share later.

## Install

From a checkout of this repo (needs a Rust toolchain and JDK 21):

```bash
cd ffi
cargo build
./generate-kotlin.sh
cd kotlin && ./gradlew test
```

Point `jna.library.path` at `ffi/target/debug` so the JVM can load
`libatomic_ffi`.

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
```

`setup.agentSecret` is the only way to sign writes after you reopen the
store. Keep it.

```kotlin
val store = Store.open("./my-atomic-data")
store.loadAgent(secret)
```

`Store.inMemory()` is the same API without a directory.

`Resource.destroyResource()` deletes the resource. It is not named
`destroy()` because UniFFI already uses that for FFI handle teardown.

## HTTP (schema, search, remote save)

The core ontology is bundled, so validation works offline. Unknown Class /
Property URLs are loaded with `store.get("https://…")` (HTTP GET + cache).

```kotlin
val store = Store.open("./my-atomic-data", "https://atomicdata.dev")
// or later: store.setServer("https://atomicdata.dev")

val schema = store.get("https://atomicdata.dev/classes/Bookmark")
val hits = store.search("notes", 10u)
note.saveRemote()   // POST /commit; did:ad: needs store.server()
```

`has(subject)` is local-only. `search()` errors if no server is set. `save()`
stays local; `saveRemote()` is the HTTP POST.

## P2P sync (Iroh)

```kotlin
val node = store.startPeer()   // did:ad:node:…
store.announce(null)           // optional pkarr publish
// On the other device, same agent secret (or a grant), then:
other.syncWith(node, null)
```

After the first sync, connected peers get live Loro updates on `.save()`.
`store.waitFor(subject, timeoutSecs)` blocks until a local or peer change
lands.

Two Iroh nodes cannot share one JVM — `startPeer` is process-global, same
as Flutter and Python. Use two processes (or two devices).

## What this is not (yet)

WebSocket-to-server `SyncSession` is not wrapped. Blobs and history are not
wrapped. An Android AAR (`cargo-ndk`) and Binder host are later layers.
Iroh P2P is.
