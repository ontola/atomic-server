{{#title Atomic Data WebSocket Protocol — sync, real-time collaboration, and offline-first}}

# WebSocket Protocol

The WebSocket protocol is the primary communication channel for Atomic Data synchronization. It handles authentication, real-time updates, collaborative editing, drive synchronization, and blob storage.

Because the protocol is binary-first and transport-agnostic, it works identically across:

- **Client ↔ Server** (WebSocket)
- **Peer ↔ Peer** (Iroh QUIC streams)
- **Browser ↔ WASM Worker** (Web Worker messages)

## Protocol Versions

The server supports two protocols, negotiated via the `Sec-WebSocket-Protocol` header:

1.  **`atomicdata-ws.v2` (Binary, Preferred)**: A binary-first protocol designed for efficiency and zero-copy parsing. All resource data travels as raw binary Loro bytes.
2.  **`atomicdata-ws.v0.1` (Legacy)**: A text-based protocol using UTF-8 JSON frames.

This document describes the **v2 Binary Protocol**.

## Connection

A connection is established over a WebSocket (typically to a responder's `/ws` endpoint) or a native QUIC stream.

- **Protocol**: `atomicdata-ws.v2`
- **Binary Type**: `arraybuffer`
- **Frame Format**: `[type: u8] [payload...]`

## Message Tags (v2)

| Tag    | Name            | Role        | Payload                                                                                                                             |
| ------ | --------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `0x01` | `AUTH`          | Init → Resp | UTF-8 JSON (Agent credentials)                                                                                                      |
| `0x02` | `AUTH_OK`       | Resp → Init | (empty)                                                                                                                             |
| `0x03` | `ERROR`         | either      | `[request_id: u16] [message: string]`                                                                                               |
| `0x10` | `GET`           | either      | `[request_id: u16] [subject: string]`                                                                                               |
| `0x11` | `UPDATE`        | either      | `[flags: u8] [request_id: u16] [subject_len: u16] [subject] [commit_id_len: u16 (optional)] [commit_id (optional)] [loro_bytes...]` |
| `0x12` | `DESTROY`       | either      | `[request_id: u16] [subject: string]`                                                                                               |
| `0x13` | `COMMIT`        | Init → Resp | `[request_id: u16] [commit_json_utf8]`                                                                                              |
| `0x14` | `COMMIT_OK`     | Resp → Init | `[request_id: u16] [server_commit_json_utf8]`                                                                                       |
| `0x20` | `SUB`           | either      | UTF-8 String (Subject)                                                                                                              |
| `0x21` | `UNSUB`         | either      | UTF-8 String (Subject)                                                                                                              |
| `0x30` | `SYNC`          | either      | `[drive_len: u16] [drive] [hash_len: u16] [hash] [json_vv]`                                                                         |
| `0x31` | `SYNC_OK`       | either      | `[drive_len: u16] [drive]`                                                                                                          |
| `0x32` | `SYNC_DIFF`     | either      | `[drive_len: u16] [drive] [json_diff]`                                                                                              |
| `0x33` | `SYNC_PUSH`     | either      | `[drive_len: u16] [drive] [flags: u8] [count: u16] entries...` (chunked; bit 0 = LAST)                                              |
| `0x34` | `BLOB_REQUEST`  | either      | `[blake3_hash: 32 bytes]`                                                                                                           |
| `0x35` | `BLOB_RESPONSE` | either      | `[blake3_hash: 32 bytes] [bytes...]`                                                                                                |
| `0x36` | `QUERY_UPDATE`  | Resp → Init | `[property_len: u16] [property] [value_len: u16] [value] [added_count: u16] entries... [removed_count: u16] entries...`             |
| `0x40` | `EPHEMERAL`     | either      | (Protocol-specific transient data)                                                                                                  |

## UPDATE (0x11) Payload Layout and Flags

The `UPDATE` message payload (after the `0x11` type tag) is laid out as follows:

1. **`flags: u8`** - A bitfield containing options:
   - **`0x01` (`SNAPSHOT`)**: The update contains a full Loro snapshot. If `0`, it is a Loro delta (incremental update).
   - **`0x02` (`HAS_COMMIT_ID`)**: A commit ID is present on the wire.
   - **`0x04` (`PUSH`)**: The update is a subscription-driven push from the server, not a response to a `GET` request.
2. **`request_id: u16`** - Network request ID (in big-endian).
3. **`subject_len: u16`** - Length of the subject string (in big-endian).
4. **`subject: UTF-8 String`** - The subject of the resource being updated.
5. **`commit_id_len: u16`** (Conditional) - Only present if the `HAS_COMMIT_ID (0x02)` flag bit is set. The length of the commit ID string (in big-endian).
6. **`commit_id: UTF-8 String`** (Conditional) - Only present if the `HAS_COMMIT_ID (0x02)` flag bit is set. The subject of the commit that produced this update.
7. **`loro_bytes: Binary`** - The remaining bytes of the payload contain the raw Loro snapshot or delta bytes.

## Authentication

Before sending any other messages, the initiator must authenticate:

1. The initiator sends `AUTH (0x01)` with a JSON payload containing signed credentials.
2. The responder responds with `AUTH_OK (0x02)` or `ERROR (0x03)`.

## Resource Fetching

```
-> GET (0x10) [request_id] [subject]
<- UPDATE (0x11) [flags] [request_id] [subject] [loro_snapshot_bytes]
```

A peer fetches the current state of a resource as a binary Loro snapshot.

## Persisted Commits

Persisted writes can travel over the WebSocket instead of the HTTP `/commit`
endpoint. The on-wire commit payload is the same signed JSON-AD body the HTTP
endpoint accepts — only the transport changes, so deterministic signing and
commit parsing are unaffected.

```
-> COMMIT (0x13) [request_id] [commit_json]
<- COMMIT_OK (0x14) [request_id] [server_commit_json]
<- UPDATE (0x11) ...     # sent to OTHER subscribers, not the origin connection
```

`server_commit_json` is the same created commit resource HTTP `/commit` returns
today (JSON-AD `did:ad:commit:<sig>`). On failure, the responder emits
`ERROR (0x03)` with the matching `request_id`.

Each WebSocket connection has a per-process identifier. The responder tags the
emitted database events with that id and skips broadcasting follow-up `UPDATE`,
`DESTROY`, or `QUERY_UPDATE` frames back to the connection that originated the
commit — the client never sees its own change return as a subscription push.
Other subscribers, including additional tabs/devices owned by the same agent,
do receive the update on their own connections.

HTTP `POST /commit` continues to work and remains the fallback path; HTTP
commits have no connection id and are broadcast to every matching subscriber.

## Subscriptions

Two subscription shapes exist, sharing the same notification path on the server:

- **Drive-wide** — `SUB (0x20)` with a drive subject. Every change in that drive produces a `QUERY_UPDATE (0x36)` (and, for resource-level subscribers, an `UPDATE (0x11)` for the changed resource itself).
- **Filter** — registered via the text frame `SUBSCRIBE_QUERY <json>` carrying `{ property, value, drive }`. The server registers the filter in `Tree::WatchedQueries`; whenever a resource enters or leaves the result set, the server emits `QUERY_UPDATE (0x36)` carrying the property/value the client subscribed with so it can dispatch.

Both subscription kinds require an authorized drive — the server runs `check_read` on the drive at registration time and rejects subscriptions whose filter doesn't name a drive the agent can read.

## Query Update Notifications

`QUERY_UPDATE (0x36)` carries a list of subjects added to or removed from a watched query's result set:

```
[0x36]
[property_len: u16] [property]    ← may be empty (drive-wide subscription)
[value_len: u16] [value]          ← may be empty (drive-wide subscription)
[added_count: u16] {[subject_len: u16] [subject]}*
[removed_count: u16] {[subject_len: u16] [subject]}*
```

Empty `property` and `value` signal a drive-wide notification. The client follows up with `GET (0x10)` (or relies on a parallel `SUB`-driven `UPDATE` push) to fetch the bytes for newly-added subjects.

## Drive Synchronization

Drive sync ensures two peers have the same set of resources. It uses Loro CRDT version vectors for efficient diffing.

1. **`SYNC (0x30)`**: Peers exchange drive-level hashes and version vectors.
2. **`SYNC_DIFF (0x32)`**: A peer determines which resources to `pull`, `push`, and `remove`.
3. **`SYNC_PUSH (0x33)`**: Peers exchange binary Loro deltas for missing resources, **chunked**. Each chunk carries `[drive] [flags: u8] [count: u16] [entries...]`; bit 0 of `flags` is `LAST`. Senders cap chunks at 100 entries or 1 MiB (whichever fills first); receivers loop reading `SYNC_PUSH` frames until they see a chunk with `LAST` set. An empty push still emits a single `LAST`-flagged frame so the receiver doesn't hang.

### `SYNC_DIFF` payload

After the drive subject, the payload is UTF-8 JSON:

```json
{ "pull": ["subject", "..."], "push": ["subject", "..."], "remove": ["subject", "..."] }
```

- **`pull`**: Subjects the *initiator* should send to the *responder* (initiator has newer or missing data).
- **`push`**: Subjects the *responder* will send via `SYNC_PUSH` (initiator is behind or missing data).
- **`remove`**: Subjects the *initiator* should delete locally. The responder destroyed these (or has tombstoned them) and they are absent from its version vectors; without `remove`, bulk sync could resurrect deleted resources.

`remove` is optional for backward compatibility (`[]` if omitted). Receivers apply removals the same way as `DESTROY (0x12)` or `QUERY_UPDATE` `removed` entries.

**Live deletes** still use `COMMIT` (destroy) → `DESTROY` / `QUERY_UPDATE` subscriptions; `remove` is for **bulk reconcile** after offline or Iroh pairing.

## Content-Addressed Blob Syncing

When a peer receives a `File` resource via sync that contains a `blake3` hash it doesn't have locally, it initiates a blob fetch:

```
-> BLOB_REQUEST (0x34) [blake3_hash (32 bytes)]
<- BLOB_RESPONSE (0x35) [blake3_hash (32 bytes)] [binary_file_bytes...]
```

This allows binary files to sync across the mesh network independently of the Loro metadata, supporting offline-first uploads and content-addressed deduplication.

## Text Messages (Legacy/Hybrid)

A few low-volume or registration-side messages still use text frames (prefixed by keyword) during the transition to v2:

- `SUBSCRIBE_QUERY <json>` (Init → Resp): register a filter subscription. JSON shape: `{ property, value, drive, sort_by? }`. Drive is required.
- `LORO_SYNC_UPDATE <json>`: Collaborative editing deltas.
- `LORO_EPHEMERAL_UPDATE <json>`: Cursors and presence.

`QUERY_UPDATE` was a text frame in earlier drafts; it now ships as binary tag `0x36` (see above).

## Typical Session Flow

```
Peer A                              Peer B
  |                                    |
  |-- AUTH (0x01) {credentials} ------>|
  |<------------- AUTH_OK (0x02) ------|
  |                                    |
  |-- SYNC (0x30) {drive, hash, vvs} ->|
  |<------------- SYNC_OK (0x31) ------|  (fast path: hashes match)
  |                                    |
  |  OR if hashes differ:              |
  |<----------- SYNC_DIFF (0x32) ------|
  |<----------- SYNC_PUSH (0x33) ------|
  |-- SYNC_PUSH (0x33) {deltas} ------>|
  |                                    |
  |  If a File blob is missing:        |
  |-- BLOB_REQUEST (0x34) {hash} ----->|
  |<----------- BLOB_RESPONSE (0x35) --|
  |                                    |
  |<----- UPDATE (0x11) {subject,delta}|  (subscription push)
  |                                    |
  |-- COMMIT (0x13) {commit_json} ---->|
  |<----------- COMMIT_OK (0x14) ------|  (no echo back to Peer A)
  |                                    |
  |-- GET (0x10) {subject} ----------->|
  |<----------- UPDATE (0x11) ---------|
```

## Implementation

- [Client implementation (TypeScript)](https://github.com/atomicdata-dev/atomic-server/blob/master/browser/lib/src/websockets.ts)
- [Server implementation (Rust/Actix)](https://github.com/atomicdata-dev/atomic-server/blob/master/server/src/handlers/web_sockets.rs)
- [Binary Protocol Encoding (TypeScript)](https://github.com/atomicdata-dev/atomic-server/blob/master/browser/lib/src/ws-v2.ts)
