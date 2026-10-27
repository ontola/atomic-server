{{#title Local-first Sync Engine: build apps whose data syncs without a backend}}
# Local-first Sync Engine

The engine that keeps the workspace in agreement across devices is a library you can build on.
You write an app against a local store; persistence, identity, permissions, history and sync come with it.

## What the engine does

- **A local store on every platform.** `@tomic/lib` in the browser runs the same Rust core (compiled to WebAssembly) on top of OPFS. `atomic_lib` provides it natively in Rust, the CLI, desktop and [Flutter](flutter.md) apps.
- **Automatic CRDT merging.** Every Resource is a [Loro](https://loro.dev) CRDT document. Accepted concurrent edits merge automatically without a coordinator. Applications decide when the result needs human review: convergence does not guarantee that business rules are satisfied.
- **Signed writes.** Edits travel as [Commits](commits/intro.md): a Loro delta plus an Ed25519 signature. Receivers verify the signature and the signer's rights before applying anything, the same way on a server, a phone and a browser tab.
- **Efficient reconciliation.** Devices compare version vectors and exchange only what differs. An outbox holds offline edits and drains them, in order, to the first reachable peer.
- **Several transports, one protocol.** See the table below.
- **Rights on every link.** A device sends a peer only what that peer's Agent may read, and accepts only writes that Agent may make. Pairing introduces devices; it grants nothing.
- **Live collaboration built in.** Edits in progress, cursors and presence are ephemeral state, broadcast to connected peers and never written to disk.

## Transports

| Transport | Between | Notes |
| --- | --- | --- |
| WebSocket | A client and an always-on AtomicServer | The default for the web app. Subscriptions push every applied commit. |
| Iroh (QUIC) | Two devices running `atomic_lib` | Pair by scanning a code. Works through NAT via a relay, direct when possible. |
| WebRTC | Up to eight browser tabs | A signaling service introduces the tabs, data flows tab to tab. See [browser peer sync](browser-peer-sync.md). |
| HTTP `POST /commit` | Any client and an AtomicServer | Fallback and scripting, no live updates. |

Finding a Drive you only know by identifier uses [peer discovery](identifiers.md#resolution) through the pkarr relay network.
A mesh transport over Reticulum is planned and not built.

For recommendations by app type, see [choosing transports and designing for offline edits](local-first-guide/7-design-decisions.md).
The transport connects replicas; your application still defines record identity, business rules, and how rejected or ambiguous changes are reviewed.

## Using it

The [local-first guide](local-first-guide/1-index.md) takes you from a keypair and a server-less Store through persistence, syncing to an always-on server, and the same Drive on a phone. The reference pages are:

- [`@tomic/lib`](js.md), [Store](js-lib/store.md) and [Resource](js-lib/resource.md)
- [`@tomic/react`](usecases/react.md) hooks and [`@tomic/svelte`](svelte.md)
- [Rust](rust-lib.md) and [Flutter / Dart](flutter.md)
- The [wire protocol](websockets.md), if you are implementing a client or peer
- [Migrating from PostgreSQL](local-first-guide/8-from-postgres.md), for an incremental adoption path and the guarantees to evaluate before replacing a database

## What you do not need

Atomic supplies resource storage, signing, permissions, synchronization and CRDT merging, so you can start without building those layers yourself. Classes and properties are data. Your application still needs policies for business identity, key recovery, coordinated decisions and data transformations when the model changes.
You can still run [AtomicServer](atomic-server.md) when you want an always-on replica, HTTP access for crawlers and scripts, full-text search across a Drive, or [plugins](plugins.md).

## How it works, in depth

- [Atomic Sync](sync.md): the model, a day in the life of an edit and what crosses the link.
- [Local-first and data ownership](local-first.md): why the design looks like this and its trade-offs.
