# Sync & pairing

AtomicServer treats every machine that holds your data as a **device**. A home
server or hosted instance is just an always-on device. Sync is how workspaces
converge between them.

For the wire format, see the [WebSocket / sync protocol](../../websockets.md).
This page is the product guide.

## Concepts

| Say | Meaning |
| --- | --- |
| **Workspace** | What the schema calls a Drive — the unit you sync |
| **Device** | A machine running Atomic (phone, desktop, server) |
| **Always-on device** | A device that never sleeps (AtomicServer, desktop app left running) |
| **Pairing code** | A scannable code that tells one device how to reach another |
| **Sync** | Make two devices hold the same workspace data |

Rights still decide what each side may read or write, on every transport. Pairing
only solves routing — it does not grant access.

## Browser vs native devices

- A **browser tab** stores data locally (see [Local-first](../local-first.md)) but
  is not an Iroh node. It syncs through an always-on device over WebSocket.
- **Desktop (Tauri), mobile, and AtomicServer** are nodes. They can pair with each
  other over Iroh using a pairing code, and also speak WebSocket.

Two browser tabs with no always-on device between them cannot reach each other.
Say that plainly in onboarding copy when it applies.

## Pairing two devices

1. On the device that already has the workspace, open **Sync** (or Devices) and
   show a pairing code / QR.
2. On the new device, scan or paste the code.
3. The devices connect (Iroh over a relay if needed), authenticate as agents, and
   run a drive sync: version vectors → diffs → Loro snapshots → any missing
   file blobs.

The code is **routing only**. It never carries your agent secret. Getting the
same identity onto a second device is a separate step (passkey restore, or
pasting the agent secret).

After the first sync, reconnects need no scan — known peers are remembered.

## Connecting a browser to an always-on device

In the browser, open Sync and add the address of your AtomicServer (for example
`http://localhost:9885` or `https://atomicdata.dev`). Authenticate with your
agent. The browser then:

- fetches and subscribes to workspaces you can read,
- drains its offline outbox as commits,
- receives live [presence](presence.md) and updates over the WebSocket.

To move a workspace that was created only in the browser onto a server, use the
promote / push action on the Sync screen so the always-on device receives it.

## What syncs

- Resource state as Loro CRDT snapshots and deltas
- Signed [Commits](../../commits/intro.md) (authorship and history)
- File **blobs** by BLAKE3 content hash (`BLOB_REQUEST` / `BLOB_RESPONSE`)

Ephemeral [presence](presence.md) (cursors, "who is viewing") is relayed live
and is **not** persisted or synced as history.

## Related

- [Local-first architecture](../local-first.md)
- [`did:ad:node:` identifiers](../../did.md#node-identifiers)
- [Protocol reference](../../websockets.md)
