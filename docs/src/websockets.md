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
| `0x36` | *reserved*      | —           | Previously `QUERY_UPDATE`. Retired in `planning/drop-query-update.md`; the `SUBSCRIBE_QUERY` text-frame registrar is still supported, but membership changes are now delivered as plain `UPDATE` (0x11) / `DESTROY` (0x12) frames. |
| `0x37` | `HELLO`         | either      | `[name_len: u16] [name_utf8]` — peer-stream only (Iroh / QUIC). Browser WS connections do not use this frame.                        |
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

## Peer Handshake (HELLO, Iroh streams only)

On Iroh peer-to-peer streams (not browser WS), each side announces a
human-readable device name immediately after `AUTH_OK`:

```
-> HELLO (0x37) [name_len: u16] [name_utf8]
<- HELLO (0x37) [name_len: u16] [name_utf8]
```

Display-only. The name is capped at `HELLO_MAX_CHARS` Unicode scalar values
(see `lib/src/sync/protocol.rs`); over-long frames are rejected rather than
truncated so receivers can show the literal value safely. Peers that don't
implement `HELLO` simply skip it — receivers treat the absence as "unknown
peer".

## Resource Fetching

```
-> GET (0x10) [request_id] [subject]
<- UPDATE (0x11) [flags=SNAPSHOT|HAS_COMMIT_ID] [request_id] [subject_len] [subject]
                 [commit_id_len] [commit_id] [loro_snapshot_bytes]
```

A peer fetches the current state of a resource as a binary Loro snapshot. The
responder should set `HAS_COMMIT_ID` and include the resource's current
`lastCommit` subject so the requester can build follow-up commits with a
correct `previousCommit` pointer. Without this field a client that received
state only over WS has no way to know which commit produced the state and may
incorrectly mark its next save as a genesis commit (the resource exists, so
the server rejects it).

> Implementation note: subscription pushes (`PUSH` flag) carry the commit id
> today; direct GET responses currently omit it. Tracked in
> [`planning/fix-canvas-genesis-save.md`](../../planning/fix-canvas-genesis-save.md).

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
emitted database events with that id and skips broadcasting follow-up `UPDATE`
or `DESTROY` frames back to the connection that originated the commit — the
client never sees its own change return as a subscription push. Other
subscribers, including additional tabs/devices owned by the same agent, do
receive the update on their own connections.

HTTP `POST /commit` continues to work and remains the fallback path; HTTP
commits have no connection id and are broadcast to every matching subscriber.

## Subscriptions

The server offers three subscription shapes, all delivered through the
same response channel (`UPDATE (0x11)` / `DESTROY (0x12)`):

- **`SUB (0x20)` on a drive subject.** Every commit on a resource that
  lives under that drive is delivered to the subscriber as `UPDATE`
  (with full snapshot + commit id) or `DESTROY`. Carries creates, edits,
  and destroys. Drive subscribers are a strict superset of resource
  subscribers (which still exist for finer-grained subscriptions on
  individual subjects).
- **`SUBSCRIBE <subject>` (text frame).** Per-resource subscription —
  receive `UPDATE` / `DESTROY` only for commits targeting that exact
  subject.
- **`SUBSCRIBE_QUERY <json>` (text frame).** Filter subscription —
  receive `UPDATE` / `DESTROY` whenever a resource enters or leaves the
  result set of a watched filter. JSON shape:
  `{ property, value, drive, sort_by? }`; the property+value pair and
  the drive scope are required. When a resource joins the filter the
  subscriber gets an `UPDATE` carrying the full snapshot; when it leaves
  (or is destroyed) the subscriber gets a `DESTROY`. Useful for table /
  collection views that watch "all resources where `parent` = X" or
  similar without binding to a whole drive.

All three require authorization at registration time — `check_read` on
the drive (for `SUB` and `SUBSCRIBE_QUERY`) or on the resource (for
`SUBSCRIBE`).

> Historical: an earlier protocol revision included a dedicated
> `QUERY_UPDATE (0x36)` membership-notification frame carrying just the
> subject string, requiring the client to follow up with a `GET`. Retired
> in `planning/drop-query-update.md` because the same information arrives
> with one fewer round-trip as a regular `UPDATE` carrying the snapshot.
> Tag `0x36` is reserved.

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

`remove` is optional for backward compatibility (`[]` if omitted). Receivers apply removals the same way as `DESTROY (0x12)` frames.

**Live deletes** use `COMMIT` (destroy) → `DESTROY` to each subscriber of the destroyed subject and to each drive-wide subscriber of the drive it lived under; `remove` is for **bulk reconcile** after offline or Iroh pairing.

## Content-Addressed Blob Syncing

When a peer receives a `File` resource via sync that contains a `blake3` hash it doesn't have locally, it initiates a blob fetch:

```
-> BLOB_REQUEST (0x34) [blake3_hash (32 bytes)]
<- BLOB_RESPONSE (0x35) [blake3_hash (32 bytes)] [binary_file_bytes...]
```

This allows binary files to sync across the mesh network independently of the Loro metadata, supporting offline-first uploads and content-addressed deduplication.

## Text Messages (Legacy/Hybrid)

A few low-volume or registration-side messages still use text frames (prefixed by keyword) during the transition to v2:

- `SUBSCRIBE <subject>`: per-resource subscription (resource subs are surfaced as `UPDATE` / `DESTROY` on the binary path).
- `SUBSCRIBE_QUERY <json>`: filter subscription — `{ property, value, drive, sort_by? }`. Property + value + drive are required. Membership changes arrive as `UPDATE` / `DESTROY` (no dedicated response frame); see Subscriptions above.
- `LORO_SYNC_SUBSCRIBE <json>` / `LORO_SYNC_UNSUBSCRIBE <json>`: register/unregister live collaborative-editing fanout for a Loro subject.
- `LORO_SYNC_UPDATE <json>`: Collaborative editing deltas.
- `LORO_EPHEMERAL_UPDATE <json>`: Cursors and presence.

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

This page is the canonical wire-format spec. Every implementation file below
links back here in its module header; keep this doc in sync when you touch any
of them.

**Browser / TypeScript**

- [`browser/lib/src/ws-v2.ts`](https://github.com/atomicdata-dev/atomic-server/blob/master/browser/lib/src/ws-v2.ts) — frame encode/decode (tags, flags, `Frame*` helpers).
- [`browser/lib/src/websockets.ts`](https://github.com/atomicdata-dev/atomic-server/blob/master/browser/lib/src/websockets.ts) — high-level client (auth, pending requests, subscriptions, commit-over-WS).

**Server / Rust**

- [`server/src/handlers/web_sockets.rs`](https://github.com/atomicdata-dev/atomic-server/blob/master/server/src/handlers/web_sockets.rs) — Actix WebSocket handler (browser-facing).
- [`lib/src/sync/protocol.rs`](https://github.com/atomicdata-dev/atomic-server/blob/master/lib/src/sync/protocol.rs) — shared tag constants, flag bits, encode/decode helpers used by both transports.
- [`lib/src/sync/engine.rs`](https://github.com/atomicdata-dev/atomic-server/blob/master/lib/src/sync/engine.rs) — transport-agnostic drive sync engine (`SYNC`, `SYNC_DIFF`, `SYNC_PUSH`).
- [`lib/src/sync/peer.rs`](https://github.com/atomicdata-dev/atomic-server/blob/master/lib/src/sync/peer.rs) — Iroh QUIC peer transport (HELLO handshake, peer streams).
- [`lib/src/client/ws.rs`](https://github.com/atomicdata-dev/atomic-server/blob/master/lib/src/client/ws.rs) — Rust WebSocket client (used by CLI and tests).
