# Plan: Fix Save Failed is_genesis Error on Canvas Stroke Appending

Fix the error where appending a stroke to a canvas results in a `Save failed: Commit for ... has is_genesis: true, but the resource already exists` error.

## Problem Analysis
When the frontend Svelte/React application loads a canvas page (a DID-based resource starting with `did:ad:`), it fetches the resource from the server. Over the WebSocket v2 protocol, the server responds to a `GET` subscription request by encoding the resource's Loro state as a binary snapshot in an `UPDATE` frame.

However, the server currently encodes this response frame with `commit_id: None` (and without the `HAS_COMMIT_ID` flag). Since `lastCommit` metadata is not part of the normal Loro CRDT state, the client is left with no information about the last commit of this resource. On a page reload or route transition (when a fresh `Resource` object is constructed), the client starts with an empty cache. When the snapshot is imported, the `lastCommit` property remains `undefined`.

When the user draws a stroke and calls `resource.save()`, the client checks if there is a `previousCommit`. Finding none, it mistakenly concludes that this is a new genesis commit for the DID resource and sets `is_genesis: true`. The server then rejects this commit because the resource already exists in its database.

## Proposed Changes

### Backend Server (`atomic-server`)

Retrieve the `lastCommit` property from the resource on the server, and if present, pass it when encoding the WebSocket `UPDATE` frame response to a client's `GET` request.

---

#### [ ] [web_sockets.rs](file:///Users/joep/dev/atomic-server/server/src/handlers/web_sockets.rs)
- Retrieve `lastCommit` from the resource using `resource.get(atomic_lib::urls::LAST_COMMIT)` and map it to a String.
- Check if it is present and, if so, set the `ws_v2::flags::HAS_COMMIT_ID` flag.
- Pass `last_commit.as_deref()` to `ws_v2::encode_update`.

#### [ ] [engine.rs](file:///Users/joep/dev/atomic-server/lib/src/sync/engine.rs)
- Retrieve `lastCommit` from the resource using `resource.get(crate::urls::LAST_COMMIT)` and map it to a String.
- Check if it is present and, if so, set the `protocol::flags::HAS_COMMIT_ID` flag.
- Pass `last_commit.as_deref()` to `protocol::encode_update`.

## Verification Plan

### Automated Tests
1. Run server integration tests:
   ```bash
   cargo test --test multi_client_sync
   ```
2. Run frontend unit tests:
   ```bash
   cd browser
   pnpm test
   ```

### Manual Verification
- Verify that a client can load an existing canvas page, append a stroke, and successfully save the update without triggering the genesis error.
