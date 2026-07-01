# Refactor UPDATE Frame Decoding to Unified Helper & Fix TS Client Delta Sync

Clean up the confusing, duplicated, and potentially buggy UPDATE frame decoding logic in `atomic_lib`, document the protocol wire format, and optimize the TypeScript client to export compact CRDT deltas instead of full snapshots on every edit.

## Proposed Changes

### Sync Protocol Documentation

#### [x] [websockets.md](file:///Users/joep/dev/atomic-server/docs/src/websockets.md)
- Detail the exact layout and flag values of the `UPDATE (0x11)` message.

---

### Sync Protocol Definition & Implementation

#### [x] [protocol.rs](file:///Users/joep/dev/atomic-server/lib/src/sync/protocol.rs)
- Add a comment referencing `docs/src/websockets.md` as the authoritative source of truth for the protocol wire format.
- Define a unified `DecodedUpdate` struct:
  ```rust
  pub struct DecodedUpdate {
      pub flag_bits: u8,
      pub request_id: u16,
      pub subject: String,
      pub commit_id: Option<String>,
      pub loro_bytes: Vec<u8>,
  }
  ```
- Implement `pub fn decode_update(data: &[u8]) -> Option<DecodedUpdate>` that parses the type tag-less payload bytes (matching standard decoding functions in `protocol.rs`).
- Update the `update_round_trip` unit test to fully round-trip through `decode_update`.

---

### Client WebSocket Decoder

#### [x] [ws.rs](file:///Users/joep/dev/atomic-server/lib/src/client/ws.rs)
- Add a comment referencing `docs/src/websockets.md` as the authoritative source of truth.
- Refactor `decode_update_frame` to use `protocol::decode_update(&payload)` rather than duplicate the byte-by-byte manual parsing of flags, subject, commit_id, and loro_bytes.

---

### Peer Sync Loop

#### [x] [peer.rs](file:///Users/joep/dev/atomic-server/lib/src/sync/peer.rs)
- Add a comment referencing `docs/src/websockets.md` as the authoritative source of truth.
- Refactor the `tag::UPDATE` match-arm in the read loop to use `protocol::decode_update(&buf[1..])`.
- This ensures correct parsing when the `HAS_COMMIT_ID` flag is set, eliminating a potential sync corruption bug.

---

### TS Client Delta Sync Optimization (Completed)

#### [x] [resource.ts](file:///Users/joep/dev/atomic-server/browser/lib/src/resource.ts)
- Modify `exportLoroDelta` to accept `isFirstCommit: boolean`. Force a full Loro snapshot for genesis commits, and export compact incremental deltas for subsequent commits.
- Bypass Loro for server-managed `lastCommit` and `createdAt` properties. Write them directly to the local cache only, eliminating Loro CRDT version vector gaps and resolving the causal delta import issues.
- Modify `removeUnsafe` to bypass Loro when clearing `lastCommit` or `createdAt` from the cache.

## Verification Plan

## Automated Tests
- [x] Run TypeScript/Svelte vitest unit tests:
  ```bash
  pnpm test --run
  ```
- [x] Run the full suite of atomic_lib Rust tests:
  ```bash
  cargo test -p atomic_lib --features iroh,db-redb
  ```
