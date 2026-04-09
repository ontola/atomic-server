{{#title Atomic Data WebSocket Protocol — sync, real-time collaboration, and offline-first}}
# WebSocket Protocol

The WebSocket protocol is the primary communication channel between Atomic Data clients and servers. It handles authentication, real-time updates, collaborative editing, and drive synchronization.

This same protocol is designed to work over other transports (e.g. Reticulum mesh) in the future.

## Connection

Connect to the `/ws` endpoint of an `atomic-server`. The server upgrades the HTTP request to a WebSocket connection.

- **Protocol**: `atomicdata-ws.v0.1`
- **Transport**: `wss://` (secure) or `ws://` for local development
- **Authentication**: sent as the first message after connection (see below)

## Message format

All messages are UTF-8 text frames. Each message starts with a type keyword followed by a space and a payload (usually JSON):

```
TYPE payload
```

## Authentication

Before sending any other messages, the client authenticates:

```
-> AUTHENTICATE {"https://atomicdata.dev/properties/auth/agent":"did:ad:agent:...", ...}
<- AUTHENTICATED
```

The authentication payload is a JSON-AD object containing the agent DID, a signed timestamp, and the public key. See [Authentication](./authentication.md) for details.

If authentication fails, the server responds with `ERROR`. Unauthenticated connections can only access public resources.

## Resource fetching

```
-> GET <subject>
<- RESOURCE <json-ad>
```

Fetches a single resource by its subject URL or DID. The response is a JSON-AD object. If the resource is not found or unauthorized, the server returns an Error resource with the requested subject as `@id`.

## Subscriptions

### Resource subscriptions (legacy)

```
-> SUBSCRIBE <subject>
-> UNSUBSCRIBE <subject>
<- COMMIT <commit-json-ad>
```

Subscribe to changes on a specific resource. The server sends `COMMIT` messages whenever the resource is modified.

### Query subscriptions

```
-> SUBSCRIBE_QUERY {"drive":"<drive-subject>"}
<- QUERY_UPDATE {"added":["<subject>",...],"removed":["<subject>",...]}
```

Subscribe to all changes within a drive. The server sends `QUERY_UPDATE` messages when resources are added, removed, or modified within the drive's scope. The client can then fetch individual resources as needed.

## Drive synchronization

Drive sync ensures a client and server (or two peers) have the same set of resources with the same state. The protocol uses Loro CRDT version vectors for efficient diffing.

### Version vector exchange

```
-> SYNC_VV {
     "drive": "<drive-subject>",
     "driveHash": "<sha256-hex>",
     "peers": ["<peer-id-1>", "<peer-id-2>"],
     "resources": {
       "<subject>": [<counter-for-peer-1>, <counter-for-peer-2>],
       ...
     }
   }
```

The client sends its version vector list for all resources in the drive. Each resource's Loro `oplogVersion()` is represented as an array of counters indexed by the `peers` array (deduplicated peer IDs across all resources).

The server compares with its own version vectors and responds with one of:

**Fast path** — everything is in sync:

```
<- SYNC_OK {"drive":"<drive-subject>"}
```

**Slow path** — differences found:

```
<- SYNC_DIFF {
     "drive": "<drive-subject>",
     "pull": ["<subject>", ...],
     "push": ["<subject>", ...]
   }
```

- `pull`: subjects the server needs from the client (client-ahead or unknown to server)
- `push`: subjects the server will send to the client (server-ahead or unknown to client)

### Delta exchange

After a `SYNC_DIFF`, both sides exchange Loro deltas:

```
-> SYNC_DELTAS {
     "drive": "<drive-subject>",
     "deltas": {
       "<subject>": "<base64-encoded-loro-bytes>",
       ...
     }
   }
```

```
<- SYNC_DELTAS {
     "drive": "<drive-subject>",
     "deltas": {
       "<subject>": "<base64-encoded-loro-bytes>",
       ...
     }
   }
```

The bytes are Loro snapshots (for new resources) or deltas (for resources both sides have). The receiver imports them into its local Loro doc, materializes properties, and updates indexes.

### Legacy drive sync

For backward compatibility, the older timestamp-based sync is still supported:

```
-> SYNC_DRIVE {"drive":"<drive-subject>", "since": <unix-millis>}
<- RESOURCE <json-ad>
   ... (one per resource)
<- SYNC_DONE {"drive":"<drive-subject>", "timestamp": <unix-millis>, "count": <n>}
```

## Real-time collaborative editing (Loro sync)

For live collaboration on a single resource (e.g. a document being edited by multiple users), the protocol supports streaming Loro updates:

```
-> LORO_SYNC_SUBSCRIBE {"subject":"<subject>"}
-> LORO_SYNC_UNSUBSCRIBE {"subject":"<subject>"}
-> LORO_SYNC_UPDATE <json>
<- LORO_SYNC_UPDATE <json>
```

Subscribers receive real-time Loro CRDT updates as other users edit the resource. Updates are binary Loro deltas, base64-encoded in the JSON payload.

### Ephemeral updates (cursors, presence)

```
-> LORO_EPHEMERAL_UPDATE <json>
<- LORO_EPHEMERAL_UPDATE <json>
```

Ephemeral updates carry transient state like cursor positions and user presence. They are broadcast to all subscribers of the resource but are never persisted.

## Error handling

```
<- ERROR <message>
```

Sent by the server when a message is malformed, unauthorized, or otherwise fails. The message is a plaintext description.

## Typical connection flow

```
Client                              Server
  |                                    |
  |-- AUTHENTICATE {agent, sig, ...} ->|
  |<------------- AUTHENTICATED -------|
  |                                    |
  |-- SUBSCRIBE_QUERY {drive} -------->|
  |                                    |
  |-- SYNC_VV {drive, peers, vvs} ---->|
  |<----------- SYNC_DIFF {pull,push} -|
  |<----------- SYNC_DELTAS {deltas} --|
  |-- SYNC_DELTAS {deltas} ----------->|
  |                                    |
  |<----------- COMMIT {commit} -------|  (subscription update)
  |<----------- QUERY_UPDATE {added} --|  (drive change)
  |                                    |
  |-- GET <subject> ------------------>|
  |<----------- RESOURCE <json-ad> ----|
  |                                    |
  |-- LORO_SYNC_SUBSCRIBE {subject} -->|
  |<--- LORO_SYNC_UPDATE {delta} ------|  (real-time collab)
  |-- LORO_SYNC_UPDATE {delta} ------->|
  |<--- LORO_EPHEMERAL_UPDATE {cursor}>|  (presence)
```

## Implementation

- [Client implementation (TypeScript)](https://github.com/atomicdata-dev/atomic-server/blob/master/browser/lib/src/websockets.ts)
- [Server implementation (Rust/Actix)](https://github.com/atomicdata-dev/atomic-server/blob/master/server/src/handlers/web_sockets.rs)
- [Sync protocol design](https://github.com/atomicdata-dev/atomic-server/blob/master/docs/design/unified-data-layer.md#sync-protocol)
