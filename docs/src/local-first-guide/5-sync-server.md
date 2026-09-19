# Step 4: sync to an always-on device

So far the reading list exists on one device.
To reach a second browser, a colleague, or a backup, it needs a copy on something that stays online: an [AtomicServer](../atomic-server.md).
The server does not become the owner of the data. It becomes one more replica, one that can be dialed by a browser tab.

## Connect

Point the Store at the server. It opens a WebSocket, authenticates with your Agent, and starts the [sync](../sync.md) engine.

```ts
import { StoreEvents } from '@tomic/lib';

store.setServerUrl('http://localhost:9883');

store.on(StoreEvents.SyncStatusChanged, status => {
  console.log(status.serverConnected, status.pendingDirtyCount);
});
```

Nothing is pushed yet.
The Drive was created with `localOnly: true`, so the engine skips it.
Connecting to a server *fetches* Drives this device lacks; it never offers the ones it has.
That is deliberate: a workspace should not leave a device because that device happened to reach a server.

## Offer the Drive

Lifting the local-only flag runs a normal reconcile against the server, which pushes every Resource in the Drive as signed commits:

```ts
await store.promoteLocalDrive(drive.subject);
```

The server verifies each signature and each write right.
A self-hosted server accepts a new Drive from any Agent.
A managed node accepts it only if the Drive is enrolled, which is handled by the hosting layer, not by this call.
If the server refuses, the Drive stays local and the error is on the sync status.

From this point on, `save()` still applies locally first, and the outbox drains to the server whenever the socket is open.
Close the laptop, edit on the train, open it again: the outbox catches up.

## Read it from somewhere else

Open the server's web app in another browser, sign in with the same secret, and the Drive is there.
Or fetch it with `curl`, since the server also serves DIDs over HTTP:

```sh
curl -H "Accept: application/ad+json" \
  "http://localhost:9883/did?subject=$(printf %s "$DRIVE_DID" | jq -sRr @uri)"
```

## Share it

Give a colleague read or write access by adding their Agent to the Drive's `read` or `write` list, or send them an [invite](../invitations.md).
Their edits arrive through the same WebSocket subscription your `store.subscribe` callback already listens to, and merge in the CRDT with yours.

## What you have

A Drive that lives on your device and on a server, editable offline, visible to a second browser, shareable.
Everything the server holds is signed by you, so any other node, self-hosted or not, could take its place.

Next: [the same Drive on a phone](6-phone.md).
