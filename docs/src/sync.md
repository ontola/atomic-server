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

Peers connected over WebRTC or native Iroh confirm a resource only after an
authenticated peer checks the requested version against its stored data and
completes its storage flush. A connection, cursor, or workspace sync message
alone cannot confirm a copy.
The panel shows the confirmed peer-copy count and each peer's confirmation
time. A purple peer icon distinguishes these copies from server or Vault copies.
Later edits remain waiting for peers until their version is confirmed.

Peer confirmations describe currently connected peer sessions. Closing a
peer tab or app removes its available-copy confirmation once the disconnection
is detected. An abruptly lost native peer can remain listed until its connection
liveness timeout expires. Restarting the native
node or reconnecting requires fresh acknowledgements. Reloading an embedded
resource view can read the native host’s existing live confirmations; a browser
tab that owns its WebRTC connection needs a new connection and acknowledgement.
Multiple tabs sharing one database count as
one peer copy, and another tab using this device's database never adds a
remote copy. Distinct storage identities do not establish a separate physical
device or guarantee a recoverable backup. Older peers can still synchronize
without providing these confirmations. Compatible native WebRTC peers use the
same storage acknowledgement in both directions; the receipt does not identify
device type. Native Iroh peers negotiate resource receipts separately from
drive-level sync. The native host supplies live WebRTC and Iroh evidence to
embedded resource views; those views do not open another peer connection. A
peer reached over both transports still counts once when its confirmed storage
identity is the same.

For files and directly attached files, the panel separates **resource details**
from **file contents**. A destination gets a complete-copy check only when both
are confirmed there. A metadata receipt from one peer cannot be combined with
file bytes on another. Renaming a file can leave its contents confirmed while
its new details are pending; replacing its contents immediately requires new
byte proof.

Contents confirmation checks actual stored bytes against their content hashes,
including the order and complete hash of split files. Local contents are checked
again after reload. Server checks are authorized for the signed-in agent. Peer
checks require the attachment-confirmation capability and a live session.
Cloud Vault records content proof only after the required encrypted file chunks
have been uploaded and confirmed, or an existing encrypted copy has been opened
and verified. Listing a file in a backup is insufficient.

These checks cover supported File resources and explicit attachment references.
They do not claim that arbitrary links or external images embedded in document
text are copied. Missing, unreadable, unsupported or oversized content remains
unconfirmed. The current verifier admits at most 64 MiB per stored blob/chunk
and 512 MiB per batch. Older peers and unsupported storage backends can still
sync without supplying contents proof. Peer confirmations do not count external
shared object stores as separate file copies.

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
