{{#title Remote peers: keep a Drive available when your devices are off}}
# Remote peers

Peer-to-peer sync has one catch: it only moves data while two devices are on at the same time.
If your phone is asleep and your laptop is closed, nobody else can get to your Drive.
The fix is a remote peer: a node that stays online, holds a full copy of a Drive, and syncs with your devices whenever they connect.
In practice this is an [AtomicServer](../atomic-server.md) that you run.

## What a remote peer is

It is an ordinary peer. It runs the same sync engine as your phone or laptop, with a store on disk, and it keeps the same version vectors.
It does not _own_ the data. The owner is whoever holds the Agent key that signed the Drive. Any node can replicate a Drive without that key, because trust comes from [commit signatures](../commits/intro.md) and not from the node serving them (see [Drive replication](../identifiers.md#drive-replication)).

What it gives you:

- A device that was offline catches up from it, even if no other device of yours is on.
- Browsers can reach it. A tab can't be dialed, but it can open a WebSocket.
- Other people can join a Drive without your devices being on.
- Full-text search, HTTP access and [plugins](../plugins.md) run next to the data.

There's a trade-off: the server can read the Resources it stores, so run it on a machine you trust.
It can't forge your edits, because it does not have your Agent key.

## Setting one up

1. [Install and run an AtomicServer](../atomicserver/installation.md) on a machine that stays on.
2. Make it reachable. For devices outside your network that means a public address with HTTPS. See [Make your server shareable](../atomicserver/installation.md#make-your-server-shareable).
3. Decide who may put data on it. By default anyone who can reach the server may create an account, so name yourself as the owner before you expose it. See [Putting your server on the internet](../atomicserver/installation.md#putting-your-server-on-the-internet).
4. Connect your devices. In the web app, sign in on the server. In code, call `store.setServerUrl(...)`. Connecting fetches the Drives you lack. To upload a Drive that was local-only, promote it. See [Step 4 of the local-first guide](../local-first-guide/5-sync-server.md).

From then on, each device opens a WebSocket, reconciles its Drives and stays subscribed for live updates.
Edits made offline wait in the outbox and are delivered on the next connection.

## Native devices and Iroh

An AtomicServer also starts an Iroh node and logs its `atomic:node:` id.
Native apps can pair with it directly, and it can be told to dial another node with `POST /iroh-sync`, which requires write rights on the Drive.
A server also publishes, through the pkarr relay, which Drives it holds and its public HTTPS origin if it has one. A client that knows only a Drive's identifier can find the server this way, and still verifies every signature. See [resolution](../identifiers.md#resolution).

## More than one

Nothing limits a Drive to one remote peer. Each device can sync with any node that holds the Drive and lets its Agent in, for example a server at home and a second one elsewhere.

## Options at a glance

| You want | Do |
| --- | --- |
| Availability for you and a few people | One AtomicServer you run |
| Redundancy | A second AtomicServer, or a device that is often on |
| No server at all | Peer-to-peer only, accepting that peers must overlap in time. See [transports](transports.md). |
