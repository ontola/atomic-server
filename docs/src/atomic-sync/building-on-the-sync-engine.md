{{#title Building an app on the Atomic Sync engine}}
# Building on the sync engine

Every developer who builds a multi-device app ends up solving the same things: where to store data, who is allowed to change it, how to merge edits, how to get it to the other devices.
The sync engine is a library so you don't have to, and you can use it without running the Atomic app.
You write against a local store, and identity, signing, permissions, history and sync come with it.

## In the browser or Node: `@tomic/lib`

`@tomic/lib` runs the same Rust core as the app, compiled to WebAssembly, on top of OPFS in the browser.

- [Build a local-first app](../local-first-guide/1-index.md) is the guided path: an identity, a local Drive, persistence, syncing to a server and a second device.
- Point a store at a server with `store.setServerUrl(url)`. Track progress with the `StoreEvents.SyncStatusChanged` event, which reports whether the server is connected and how many edits are still pending.
- [Store](../js-lib/store.md), [Agent](../js-lib/agent.md) and [Resource](../js-lib/resource.md) are the reference pages. `resource.save()` applies a change locally first and queues it for delivery.
- [`@tomic/react`](../usecases/react.md) and [`@tomic/svelte`](../svelte.md) wrap the store in hooks and components.

## In Rust: `atomic_lib`

`atomic_lib` provides the store, the signed commits and the sync engine.
The transports are Cargo features: `ws` for WebSocket clients, `iroh` for peer-to-peer, `discovery` for the pkarr lookup.
`AtomicNode` is a convenience facade with local saves that go to the outbox and commit ingestion policies. See [atomic_lib](../rust-lib.md) and the [crate README](https://github.com/ontola/atomic-server/blob/develop/lib/README.md).
The Flutter SDK wraps the same crate. See [Flutter / Dart](../flutter.md).

## What the engine does not decide

The engine converges copies and enforces who may write. It can't know what your data _means_.
As the [overview](overview.md) says, merging does not check business rules, so your app still decides:

- what counts as the same record, and how rejected or ambiguous changes are reviewed;
- key backup and recovery, since an identity is a key;
- how to migrate data when your model changes.

See [Choose transports and design for offline edits](../local-first-guide/7-design-decisions.md) and [Migrating from PostgreSQL](../local-first-guide/8-from-postgres.md).

## If you need to speak the protocol yourself

The [wire protocol](../websockets.md) documents every frame, and `lib/src/sync/protocol_vectors.json` holds golden vectors that the Rust and TypeScript encoders are tested against.
