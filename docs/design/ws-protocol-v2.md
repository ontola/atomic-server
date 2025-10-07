# WebSocket Protocol v2: Binary-first, Unified Messages

## Problem

The current WebSocket protocol (v0.1) grew organically. It has 20+ message types, encodes binary Loro data as base64 inside JSON text frames (+33% overhead), and uses different message shapes for the same operation (sending resource data). The protocol works but is inefficient and hard to extend.

## Goals

1. **Binary-first**: Loro bytes travel as raw binary, not base64-in-JSON
2. **Fewer message types**: one unified `UPDATE` for all resource data transfer
3. **Request-response correlation**: match responses to requests
4. **Drop legacy cruft**: no more COMMIT JSON-AD, SUBSCRIBE per-resource, SYNC_DRIVE timestamp-based sync
5. **Backward compatible upgrade**: v1 and v2 clients can connect to the same server during migration

## Design

### Frame format

Every message is a **binary WebSocket frame** with a 1-byte type tag followed by type-specific content:

```
[type: u8] [payload...]
```

Type tags:

| Tag  | Name          | Role        | Description                        |
| ---- | ------------- | ----------- | ---------------------------------- |
| 0x01 | AUTH          | Init → Resp | Authenticate                       |
| 0x02 | AUTH_OK       | Resp → Init | Authentication succeeded           |
| 0x03 | ERROR         | either      | Error response                     |
| 0x10 | GET           | either      | Fetch a resource                   |
| 0x11 | UPDATE        | either      | Resource data (snapshot or delta)  |
| 0x12 | DESTROY       | either      | Resource deleted                   |
| 0x20 | SUB           | either      | Subscribe to a drive or resource   |
| 0x21 | UNSUB         | either      | Unsubscribe                        |
| 0x30 | SYNC          | either      | Start sync (VVs + hash)            |
| 0x31 | SYNC_OK       | either      | Drive is in sync                   |
| 0x32 | SYNC_DIFF     | either      | Sync diff (pull/push lists)        |
| 0x33 | SYNC_PUSH     | either      | Batch of updates for sync (chunked)|
| 0x34 | BLOB_REQUEST  | either      | Request binary blob by BLAKE3 hash |
| 0x35 | BLOB_RESPONSE | either      | Send binary blob data              |
| 0x36 | QUERY_UPDATE  | Resp → Init | Watched-query result set changed   |
| 0x40 | EPHEMERAL     | either      | Cursor/presence (not persisted)    |

That's 14 message types, down from 20+.

### AUTH (0x01)

```
[0x01] [json-bytes...]
```

The initiator proves their identity to the responder. The responder answers with AUTH_OK (0x02) or ERROR (0x03).

When the connection already carries valid authentication (e.g. via a cookie or pre-authenticated stream), the responder may send AUTH_OK immediately without waiting for an explicit AUTH message.

### ERROR (0x03)

```
[0x03] [request_id: u16] [utf8-message...]
```

The `request_id` matches the request that caused the error. `0x0000` means unsolicited.

### GET (0x10)

```
[0x10] [request_id: u16] [subject-utf8...]
```

The requester assigns a `request_id` (any u16). The responder responds with an UPDATE (0x11) carrying the same `request_id`, or an ERROR (0x03).

### UPDATE (0x11) — the core message

```
[0x11] [flags: u8] [request_id: u16] [subject_len: u16] [subject: utf8] [loro_bytes...]
```

Flags (bitfield):

- bit 0: `snapshot` (1) vs `delta` (0)
- bit 1: `has_commit_id` — a commit ID follows the subject before loro_bytes
- bit 2: `push` — this is a subscription push (server→client), not a response

If `has_commit_id` is set:

```
... [commit_id_len: u16] [commit_id: utf8] [loro_bytes...]
```

This single message type replaces:

- `RESOURCE` (GET response → UPDATE with snapshot flag + request_id)
- `COMMIT` / `COMMIT_LORO` (subscription push → UPDATE with push flag + commit_id)
- `SYNC_DELTAS` individual entries (sync → UPDATE with delta flag)
- `LORO_SYNC_UPDATE` (collab → UPDATE with delta flag + push)

The `loro_bytes` are raw Loro binary — no base64, no JSON wrapping.

**Materialization**: the receiver imports the bytes into the resource's LoroDoc and rebuilds the read cache. For GET responses, this replaces JSON-AD parsing entirely.

### DESTROY (0x12)

```
[0x12] [request_id: u16] [subject-utf8...]
```

Resource was deleted. If `request_id` is non-zero, it's a response to a GET. If zero, it's a subscription push.

### SUB / UNSUB (0x20, 0x21)

```
[0x20] [drive-subject-utf8...]
[0x21] [drive-subject-utf8...]
```

Subscribe/unsubscribe to all changes within a drive. Replaces both `SUBSCRIBE` (per-resource) and `SUBSCRIBE_QUERY` (per-drive). Drive-level is the only granularity.

When subscribed, the server sends UPDATE messages (with push flag) for every resource change in the drive. The client no longer needs to subscribe to individual resources — the drive subscription covers everything.

For collection/query changes (resources added/removed from a watched filter or appearing in a subscribed drive), the server emits `QUERY_UPDATE (0x36)` — see below.

In addition to the `SUB`-keyed drive-wide subscription, clients may register narrower filter subscriptions through the text frame `SUBSCRIBE_QUERY <json>` (`{ property, value, drive }`). Filter subscriptions are persisted in `Tree::WatchedQueries`; both kinds flow through the same `db_events` listener and emit `QUERY_UPDATE` as their notification.

### SYNC (0x30)

```
[0x30] [drive_subject_len: u16] [drive_subject: utf8] [hash: 32 bytes] [vv_msgpack...]
```

Peers exchange drive-level hashes and version vectors to determine what needs to be synchronized.

### SYNC_OK (0x31)

```
[0x31] [drive_subject_len: u16] [drive_subject: utf8]
```

Hashes matched. Both peers are in sync. ~30 bytes total.

### SYNC_DIFF (0x32)

```
[0x32] [drive_subject_len: u16] [drive_subject: utf8] [diff_msgpack...]
```

A peer tells the other which resources it wants to `pull` and which it will `push`.

### SYNC_PUSH (0x33)

```
[0x33] [drive_subject_len: u16] [drive_subject: utf8]
  [flags: u8]                                       ← bit 0 = LAST
  [count: u16]
  [subject_len: u16] [subject: utf8] [bytes_len: u32] [loro_bytes...]
  [subject_len: u16] [subject: utf8] [bytes_len: u32] [loro_bytes...]
  ...
```

A batch of Loro snapshots/deltas for sync. Replaces the JSON `SYNC_DELTAS` message. No base64, no JSON — just subject + raw bytes, repeated.

**Chunked.** Senders use `protocol::encode_sync_push_chunks` to split the entry list into one or more frames bounded by `SYNC_PUSH_MAX_ENTRIES = 100` and `SYNC_PUSH_MAX_BYTES = 1 MiB` (whichever fills first). Only the final chunk has the `LAST` bit set in `flags`. Receivers loop reading `SYNC_PUSH` frames until they see `LAST`. Empty pushes still emit a single `LAST`-flagged frame so the receiver doesn't hang.

This keeps individual frames under typical WebSocket per-message limits and bounds memory on both sides.

### BLOB_REQUEST (0x34)

```
[0x34] [hash: 32 bytes]
```

Request a binary blob by its raw BLAKE3 hash.

### BLOB_RESPONSE (0x35)

```
[0x35] [hash: 32 bytes] [bytes...]
```

Response carrying the binary blob data. The hash is repeated to allow the receiver to correlate the data with the request or internal pending list.

### QUERY_UPDATE (0x36)

```
[0x36]
[property_len: u16] [property: utf8]   ← may be empty (drive-wide)
[value_len: u16] [value: utf8]         ← may be empty (drive-wide)
[added_count: u16] {[subject_len: u16] [subject: utf8]}*
[removed_count: u16] {[subject_len: u16] [subject: utf8]}*
```

Server → client. The watched query identified by `(property, value)` (or by drive scope, when both are empty) gained or lost members. Both `added` and `removed` are flat lists of subjects.

The server emits this from a single `db_events` listener task that consumes `DbEvent::QueryMembershipChanged` (for filter subscriptions registered via `SUBSCRIBE_QUERY`) and `DbEvent::Changed` / `Destroyed` (for drive-wide `SUB` subscriptions). The text-format `QUERY_UPDATE <json>` predecessor is gone.

Future extension: inline a Loro snapshot for each added subject so the client doesn't have to follow up with a `GET`. Wire form would be `[added_count: u16] {[subject_len: u16] [subject] [snapshot_len: u32] [loro_snapshot]}*`. Not implemented yet.

### EPHEMERAL (0x40)

```
[0x40] [subject_len: u16] [subject: utf8] [payload...]
```

Cursors, presence, and other transient state. Broadcast to all peers interested in the subject. Never persisted. The payload format is application-defined (currently JSON with cursor positions).

## Size comparison

A typical property update (e.g. renaming a folder) with one Loro peer, ~80 bytes of Loro delta:

| Protocol         | Wire size      | Notes                                       |
| ---------------- | -------------- | ------------------------------------------- |
| v1 `COMMIT`      | ~2000 bytes    | Full JSON-AD commit resource                |
| v1 `COMMIT_LORO` | ~250 bytes     | JSON + base64 Loro delta                    |
| **v2 `UPDATE`**  | **~120 bytes** | 1 + 1 + 2 + subject + commit_id + raw delta |

A SYNC_OK response (nothing changed):

| Protocol         | Wire size              |
| ---------------- | ---------------------- |
| v1 `SYNC_OK`     | ~50 bytes (JSON text)  |
| **v2 `SYNC_OK`** | **~30 bytes** (binary) |

A sync push with 10 resources, ~200 bytes avg Loro snapshot each:

| Protocol           | Wire size                   |
| ------------------ | --------------------------- |
| v1 `SYNC_DELTAS`   | ~4000 bytes (JSON + base64) |
| **v2 `SYNC_PUSH`** | **~2500 bytes** (binary)    |

## Migration

### Version negotiation

The WebSocket subprotocol header handles version selection:

```
Client: Sec-WebSocket-Protocol: atomicdata-ws.v2, atomicdata-ws.v0.1
Server: Sec-WebSocket-Protocol: atomicdata-ws.v2
```

If the server doesn't support v2, it falls back to v0.1 and the client uses text messages. If the server supports v2, all communication uses binary frames.

### Transition period

During migration, the server supports both protocols simultaneously. Each WebSocket connection negotiates its version independently. This means:

- Old clients connect with v0.1, get text messages
- New clients connect with v2, get binary messages
- The server maintains both code paths until v0.1 is dropped

### Client detection

The server stores the negotiated protocol version on the `WebSocketConnection` actor. Message handlers check the version and format accordingly:

```rust
if self.protocol_version == WsVersion::V2 {
    ctx.binary(encode_update(...));
} else {
    ctx.text(format!("COMMIT_LORO {}", ...));
}
```

## What this enables

1. **Loro-native reads**: GET returns a Loro snapshot. The client imports it and rebuilds cache. No JSON-AD parsing on the hot path. JSON-AD is still available via HTTP Accept header for external consumers.

2. **Symmetric protocol**: The same UPDATE message works for GET responses, subscription pushes, sync deltas, and collab updates. The flags differentiate context.

3. **Future transport**: The binary frame format works over any bidirectional byte stream — WebSocket, WebRTC data channels, Reticulum, TCP. No HTTP/text assumptions.

4. **Efficient sync**: The SYNC → SYNC_OK fast path is 30 bytes round trip. The SYNC_PUSH batch avoids per-message overhead and base64 encoding.

## Open questions

- **Compression**: Should we use WebSocket permessage-deflate, or compress individual Loro snapshots with zstd? Loro bytes are already fairly compact, but property URLs are long and repetitive.
- **Streaming large resources**: A Loro snapshot for a large document could be megabytes. `SYNC_PUSH` is now chunked; should `UPDATE` also support chunking for outsized snapshots? Or rely on the per-message frame limit?
- **Text fallback**: Should v2 support a text-mode fallback for debugging (e.g. browser devtools)? Or is the binary protocol always binary?
- **Inline Loro snapshots in `QUERY_UPDATE`**: Would let the client skip the follow-up `GET` for added subjects (see the section above). Cost: bigger frames, encoder needs to fetch each snapshot.
