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

| Tag | Name | Direction | Description |
|-----|------|-----------|-------------|
| 0x01 | AUTH | C→S | Authenticate |
| 0x02 | AUTH_OK | S→C | Authentication succeeded |
| 0x03 | ERROR | S→C | Error response |
| 0x10 | GET | C→S | Fetch a resource |
| 0x11 | UPDATE | either | Resource data (snapshot or delta) |
| 0x12 | DESTROY | either | Resource deleted |
| 0x20 | SUB | C→S | Subscribe to a drive |
| 0x21 | UNSUB | C→S | Unsubscribe from a drive |
| 0x30 | SYNC | C→S | Start drive sync (VVs + hash) |
| 0x31 | SYNC_OK | S→C | Drive is in sync |
| 0x32 | SYNC_DIFF | S→C | Sync diff (pull/push lists) |
| 0x33 | SYNC_PUSH | either | Batch of updates for sync |
| 0x40 | EPHEMERAL | either | Cursor/presence (not persisted) |

That's 13 message types, down from 20+.

### AUTH (0x01)

```
[0x01] [json-bytes...]
```

Same authentication JSON as v1, just in a binary frame. The server responds with AUTH_OK (0x02) or ERROR (0x03).

When the WebSocket upgrade request carries a valid authentication cookie, the server sends AUTH_OK immediately without waiting for an explicit AUTH message. The client can start sending messages right away.

### ERROR (0x03)

```
[0x03] [request_id: u16] [utf8-message...]
```

The `request_id` matches the request that caused the error. `0x0000` means unsolicited (server-initiated error).

### GET (0x10)

```
[0x10] [request_id: u16] [subject-utf8...]
```

The client assigns a `request_id` (any u16). The server responds with an UPDATE (0x11) carrying the same `request_id`, or an ERROR (0x03).

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

For collection/query changes (resources added/removed from a parent), the server can send a lightweight notification:

```
[0x20] [flags: u8] [drive-subject...] — with a "query_update" flag and a JSON payload
```

Or we keep QUERY_UPDATE as a separate text message during migration. It's low-frequency enough that efficiency doesn't matter.

### SYNC (0x30)

```
[0x30] [drive_subject_len: u16] [drive_subject: utf8] [hash: 32 bytes] [vv_msgpack...]
```

The drive hash is raw 32 bytes (SHA-256), not hex-encoded. The VV data is msgpack-encoded (compact binary) instead of JSON:

```msgpack
{
  "peers": ["peer1", "peer2"],
  "resources": {
    "did:ad:xyz": [12, 0],
    "did:ad:abc": [5, 3]
  }
}
```

### SYNC_OK (0x31)

```
[0x31] [drive_subject_len: u16] [drive_subject: utf8]
```

Hashes matched. Drive is in sync. ~30 bytes total.

### SYNC_DIFF (0x32)

```
[0x32] [drive_subject_len: u16] [drive_subject: utf8] [diff_msgpack...]
```

```msgpack
{
  "pull": ["did:ad:task2"],
  "push": ["did:ad:readme", "did:ad:design"]
}
```

### SYNC_PUSH (0x33)

```
[0x33] [drive_subject_len: u16] [drive_subject: utf8] [count: u16]
  [subject_len: u16] [subject: utf8] [bytes_len: u32] [loro_bytes...]
  [subject_len: u16] [subject: utf8] [bytes_len: u32] [loro_bytes...]
  ...
```

A batch of Loro snapshots/deltas for sync. Replaces the JSON `SYNC_DELTAS` message. No base64, no JSON — just subject + raw bytes, repeated.

### EPHEMERAL (0x40)

```
[0x40] [subject_len: u16] [subject: utf8] [payload...]
```

Cursors, presence, and other transient state. Broadcast to all subscribers of the subject's drive. Never persisted. The payload format is application-defined (currently JSON with cursor positions).

## Size comparison

A typical property update (e.g. renaming a folder) with one Loro peer, ~80 bytes of Loro delta:

| Protocol | Wire size | Notes |
|----------|----------|-------|
| v1 `COMMIT` | ~2000 bytes | Full JSON-AD commit resource |
| v1 `COMMIT_LORO` | ~250 bytes | JSON + base64 Loro delta |
| **v2 `UPDATE`** | **~120 bytes** | 1 + 1 + 2 + subject + commit_id + raw delta |

A SYNC_OK response (nothing changed):

| Protocol | Wire size |
|----------|----------|
| v1 `SYNC_OK` | ~50 bytes (JSON text) |
| **v2 `SYNC_OK`** | **~30 bytes** (binary) |

A sync push with 10 resources, ~200 bytes avg Loro snapshot each:

| Protocol | Wire size |
|----------|----------|
| v1 `SYNC_DELTAS` | ~4000 bytes (JSON + base64) |
| **v2 `SYNC_PUSH`** | **~2500 bytes** (binary) |

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
- **Streaming large resources**: A Loro snapshot for a large document could be megabytes. Should we support chunked UPDATE messages, or is the WebSocket frame limit (typically 64MB+) sufficient?
- **Text fallback**: Should v2 support a text-mode fallback for debugging (e.g. browser devtools)? Or is the binary protocol always binary?
- **Query updates**: The current QUERY_UPDATE (resources added/removed from a collection) is useful for sidebar updates. Should this become part of the SUB/UPDATE flow, or stay as a separate notification?
