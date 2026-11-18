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

## Checking an individual resource

In resource lists, select a resource's sync icon to open **Copies & sync**.
The panel separates this device's local copy, the configured server, Cloud Vault
and peers. It
shows pending saves and failures for that resource, rather than treating a
connected server as proof that every resource is saved.

A confirmed copy covers the resource version saved on the device, acknowledged
by the server, or received directly from that server. Later edits need a new
confirmation. A server going offline does not erase an earlier confirmation;
its connection status is shown separately.

The browser saves server confirmations locally for the account and server that
supplied them. After a reload, it compares those confirmations with the restored
resource, including while offline. The local-copy indicator checks the data
actually stored on this device. Newer offline edits remain waiting to sync.
Existing resources without a saved server confirmation remain unconfirmed until
the server supplies one. Clearing local storage also clears these confirmations.

Cloud Vault confirms the resource versions included in a successfully uploaded
backup. Checkpoints also require successful publication. Edits made during or
after the upload remain waiting for backup. A workspace backup timestamp, an
unchanged backup pass, or another account's backup does not establish this proof.

Vault confirmations are stored privately on this device for the managed account,
agent, provider, workspace and Vault key epoch. Reloading recovers them once the
current account and Vault are established. A fully offline fresh reload may show
the backup as unconfirmed because it cannot verify which account's Vault is
selected. Going offline in an already verified session preserves its confirmation.
Older backups without resource evidence stay unconfirmed until a subsequent
backup includes that resource's version.

Peers connected over WebRTC confirm a resource only after an authenticated peer
checks the requested version against its stored data and completes its storage flush. A
connection, cursor, or workspace sync message alone cannot confirm a copy.
The panel shows the confirmed peer-copy count and each peer's confirmation
time. A purple peer icon distinguishes these copies from server or Vault copies.
Later edits remain waiting for peers until their version is confirmed.

Peer confirmations describe currently connected WebRTC sessions. Closing a
peer tab or app removes its available-copy confirmation; reloading requires a
fresh connection and acknowledgement. Multiple tabs sharing one database count as
one peer copy, and another tab using this device's database never adds a
remote copy. Distinct storage identities do not establish a separate physical
device or guarantee a recoverable backup. Older peers can still synchronize
without providing these confirmations. Compatible native WebRTC peers use the
same storage acknowledgement; the receipt does not identify device type. Native
Iroh drive-level acknowledgements are not used as per-resource evidence here.

File resource confirmations describe the resource data, not whether every
destination has its attachment bytes.

## Connecting a cloud account

If this app is configured with a cloud provider, the provider's account card
on Sync shows whether this client is signed in. Use its **Sign in** action to
connect the client. When the app runs on a different site from the provider,
the sign-in form links this client to the account; signing in only on the
provider's website does not connect a localhost or self-hosted app. Off-site
clients use their approved device session rather than the portal's browser cookie.

This account connection is separate from the Agent that signs edits to a Drive.
Connecting an account does not purchase hosting or copy a Drive to a server.

## Where the code lives

The sync engine is transport-agnostic and lives in `atomic_lib` (`lib/src/sync/`).
The server, the Flutter app and the WASM build in the browser all run that same engine, which is why a phone can act as a hub for another phone.
The TypeScript client in `@tomic/lib` mirrors the frame encoding for the WebSocket and WebRTC paths.

## Up next

- The full frame-by-frame [wire protocol](websockets.md), if you are implementing a client or a peer.
- [Browser peer sync](browser-peer-sync.md), for the WebRTC room and how to run the signaling endpoint yourself.
- [Decentralized Identifiers](did.md), for how a device finds a Drive it has never seen.
