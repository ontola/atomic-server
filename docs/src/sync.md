{{#title Atomic Sync: keeping devices in agreement without a central server}}
# Atomic Sync

Atomic Sync is how two copies of a Drive end up holding the same data.
It is one protocol with one set of rules, spoken over whichever transport connects the two devices: a WebSocket to an always-on device, an Iroh QUIC stream between two phones, or a WebRTC data channel between two browser tabs.
The transport changes; what crosses it, and who is allowed to send it, does not.

This page walks through the model; the [overview](atomic-sync/overview.md) lists its main points. The [wire protocol reference](websockets.md) has every frame and byte; [browser peer sync](browser-peer-sync.md) covers the WebRTC path and its operator settings.

## Why sync instead of request and response

In the HTTP era a client asked a server for the current state, and the server was the only place that state lived.
Every edit was a round trip, and no connection meant no work.

In the [local-first](local-first.md) model each device keeps a full copy of the Drives it uses.
Edits are applied to that local copy first, immediately, and are signed by the Agent making them.
Sync is what happens afterwards: the device tells its peers what it changed and asks what it missed.
Because every Resource is a [Loro CRDT](https://loro.dev) document, accepted edits to the same Resource merge automatically without a coordinator.

The browser sidebar's sync indicator describes the selected Drive's server sync.
A connection to a server used for another Drive does not make this Drive synced.
A Drive excluded from server sync shows a red **Not syncing with a server** indicator;
an eligible Drive without an acknowledged sync shows **Sync not confirmed**.
The indicator stays red while edits are unsaved, saving, queued, blocked or
being reconciled. **Synced with server** requires confirmation that the current
server holds the selected Drive's latest resource state and every referenced
file or image chunk, with no unconfirmed local changes.
The desktop app's embedded server does not count as another place.
These labels do not certify Cloud Vault backups or browser peer copies; inspect
those services separately on the Sync page. Servers that cannot provide this
confirmation leave the indicator red.

### Confirming a server copy

`GET /drive-sync-confirmation?subject=<drive>&hash=<hash>&hashVersion=2` is a
signed, read-only request. The caller must be able to read a Drive stored on
that server. `hash` is the canonical v2 resource-state hash used by Atomic Sync.
The request neither uploads data nor turns on synchronization.

```json
{
  "version": 1,
  "drive": "atomic:...",
  "hashVersion": 2,
  "driveHash": "<canonical v2 hash>",
  "confirmed": true,
  "checkedBlobs": 12
}
```

`confirmed` is true only when the complete readable Drive inventory matches
the requested hash and all of its supported attachment references are present
and verified. A chunked file requires every chunk, not an additional monolithic
copy. Incomplete reads, invalid references, concurrent changes and missing bytes
provide no confirmation. Responses are not cacheable. The browser discards a
response if its identity, server, Drive or local state changed while checking.

The check uses the database's atomic parent-index consistency and normal
content-addressed storage invariants. It reports the copy observed during the
check. Strong object revisions can reuse a previously verified content hash,
but every check rechecks the object's current presence and revision.

The [transports reference](atomic-sync/transports.md) compares WebSocket, Iroh, WebRTC and HTTP, and how a Drive is found by identifier.

## What crosses the link

Not everything a device holds travels, and not everything that travels is kept.

- **Persisted state**: signed commits, and on trusted links the Loro snapshots they produce. This is what a peer stores, indexes and serves onward.
- **Ephemeral state**: edits in progress on a rich-text document, cursor positions, who is present in a Drive. Broadcast to whoever is connected right now, never written to disk, gone when the tab closes.
- **Blobs**: the bytes behind a [File](files.md), fetched by hash on demand rather than pushed with the Drive.
- **Deletes**: a signed destroy commit, so a peer can check that whoever deleted was allowed to. A bare "delete this" frame from a peer is ignored.

## A day in the life of an edit

1. You change a cell in a table on your laptop, on a train, with no connection.
2. The change is written to the laptop's local store and shows up in the UI at once. The laptop signs a commit for it and puts it in the outbox.
3. Back online, the laptop opens a WebSocket to your always-on device, proves who it is, and drains the outbox. The server verifies the signature and your write right, applies the Loro delta, and pushes the update to every other subscribed client.
4. Your phone, paired to the laptop directly, dials it over Iroh the next time both are awake. They compare version vectors, exchange only what differs, and end up identical.
5. Meanwhile a colleague edited the same table from a browser tab. If you edited the same row, accepted changes merge automatically in that Resource's CRDT.

## Where the code lives

The sync engine is transport-agnostic and lives in `atomic_lib` (`lib/src/sync/`).
The server, the Flutter app and the WASM build in the browser all run that same engine, which is why a phone can act as a hub for another phone.
The TypeScript client in `@tomic/lib` mirrors the frame encoding for the WebSocket and WebRTC paths.

## Up next

- The full frame-by-frame [wire protocol](websockets.md), if you are implementing a client or a peer.
- [Browser peer sync](browser-peer-sync.md), for the WebRTC room and how to run the signaling endpoint yourself.
- [Decentralized Identifiers](did.md), for how a device finds a Drive it has never seen.
