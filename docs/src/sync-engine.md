{{#title Local-first Sync Engine: build apps whose data syncs without a backend}}
# Local-first Sync Engine

Most apps keep your data on their own server, which makes it hard for you to leave and gives them a reason to keep it that way.
The engine that keeps the workspace in agreement across devices is built so that your data lives on _your_ devices instead, and you stay in control of it ([why](motivation.md#give-people-more-control-over-their-data)).
It is also a library you can build on: you write an app against a local store, and persistence, identity, permissions, history and sync come with it.

## What the engine does

It keeps a full local copy on every device, merges concurrent edits as [Loro](https://loro.dev) CRDTs, and sends only signed [Commits](commits/intro.md) that each receiver checks against the signer's rights. [Atomic Sync overview](atomic-sync/overview.md) explains the model.

- **A local store on every platform.** `@tomic/lib` in the browser runs the same Rust core (compiled to WebAssembly) on top of OPFS. `atomic_lib` provides it natively in Rust, the CLI, desktop and [Flutter](flutter.md) apps.
- **Offline edits.** An outbox holds edits and drains them, in order, to the first reachable peer.
- **Several transports, one protocol.** WebSocket, Iroh, WebRTC and HTTP, described in [transports](atomic-sync/transports.md). Finding a Drive you only know by identifier uses [peer discovery](identifiers.md#resolution).
- **Live collaboration built in.** Edits in progress, cursors and presence are ephemeral state, broadcast to connected peers and never written to disk.

For recommendations by app type, see [choosing transports and designing for offline edits](local-first-guide/7-design-decisions.md).

## Using it

The [local-first guide](local-first-guide/1-index.md) takes you from a keypair and a server-less Store through persistence, syncing to an always-on server, and the same Drive on a phone. The reference pages are:

- [`@tomic/lib`](js.md), [Store](js-lib/store.md) and [Resource](js-lib/resource.md)
- [`@tomic/react`](usecases/react.md) hooks and [`@tomic/svelte`](svelte.md)
- [Rust](rust-lib.md) and [Flutter / Dart](flutter.md)
- The [wire protocol](websockets.md), if you are implementing a client or peer
- [Migrating from PostgreSQL](local-first-guide/8-from-postgres.md), for an incremental adoption path and the guarantees to evaluate before replacing a database

## What you do not need

Atomic supplies resource storage, signing, permissions, synchronization and CRDT merging, so you can start without building those layers yourself. Classes and properties are data. Your application still needs policies for business identity and key recovery.
You can still run [AtomicServer](atomic-server.md) when you want an always-on replica, HTTP access for crawlers and scripts, full-text search across a Drive, or [plugins](plugins.md).

## How it works, in depth

- [Atomic Sync](sync.md): the model, a day in the life of an edit and what crosses the link.
- [Local-first and data ownership](local-first.md): why the design looks like this and its trade-offs.
