# Loro CRDT Migration Plan

## Overview

Replace Yjs with Loro as the CRDT engine for Atomic Data. Extend Loro from rich-text-only to backing **all** resource properties, enabling true multi-writer conflict resolution, efficient sync, and built-in history/time-travel.

## Architecture: Before & After

### Before (Current)
```
Resource = PropVals (HashMap<String, Value>)
Commit = { set, remove, push, yUpdate, previousCommit, ... }
History = linear chain of commits, replayed sequentially
Sync = POST commit + WebSocket broadcast (COMMIT + Y_SYNC_UPDATE)
```

### After (Loro)
```
Resource = LoroDoc (CRDT document) + materialized PropVals (read cache)
Commit = { loroUpdate (binary blob), signature, signer, createdAt, subject }
History = Loro OpLog with time-travel (checkout any version)
Sync = POST commit + WebSocket broadcast (COMMIT + LORO_SYNC_UPDATE)
```

---

## Phase 1: Dual-Mode Foundation (Rust)

Goal: Resources can optionally be backed by a LoroDoc. Old commits still work. New `loroUpdate` commits work alongside.

### 1.1 Add Loro to Resource storage

**Files:** `lib/src/resources.rs`, `lib/src/values.rs`, `lib/src/db.rs`

- Add `Value::LoroDoc(Vec<u8>)` variant to `Value` enum (or reuse `YDoc` and rename later)
- Add optional `loro_snapshot: Option<Vec<u8>>` field to `Resource` struct
- When persisting a Resource (`add_resource_tx`), store the Loro snapshot alongside PropVals in the `resources` sled tree
- When loading a Resource (`get_propvals`), also load the Loro snapshot if present
- The `AtomicLoroDoc` wrapper (already in `lib/src/loro.rs`) handles conversion between Loro state and PropVals

### 1.2 Add `loroUpdate` to Commit

**Files:** `lib/src/commit.rs`, `lib/src/urls.rs`, `lib/src/parse.rs`, `lib/src/serialize.rs`

- Add `loro_update: Option<Vec<u8>>` field to `Commit` struct
- Add URL constant `LORO_UPDATE` in `urls.rs`
- Add serialization: base64-encode the binary, include in JSON-AD as `{ type: "lorodoc", data: "<base64>" }`
- Add parsing: decode base64 from JSON-AD commit body
- Include `loroUpdate` in deterministic serialization (same rules as `yUpdate` — sorted key, base64 string value)

### 1.3 Handle `loroUpdate` in `apply_changes()`

**File:** `lib/src/commit.rs` (the `apply_changes` method, ~line 496)

- After existing `y_update` handling block, add a `loro_update` block:
  1. Load or create the resource's `AtomicLoroDoc`
  2. Subscribe to Loro diff events before import
  3. Import the update bytes
  4. Collect diff events → generate `add_atoms` / `remove_atoms` for Map property changes
  5. Materialize updated properties into `resource.propvals`
  6. Store updated Loro snapshot back on the resource

### 1.4 Update `CommitBuilder`

**File:** `lib/src/commit.rs` (~line 830)

- Add `loro_update: Option<Vec<u8>>` to `CommitBuilder`
- Add `set_loro_update(update: Vec<u8>)` method
- Include in `sign()` serialization

### 1.5 Tests

**File:** `lib/src/loro.rs` (extend existing tests), `lib/src/commit.rs` (new test)

- Test: create Resource with LoroDoc → make changes → export update → build Commit with `loroUpdate` → apply via `Store::apply_commit()` → verify PropVals updated & atoms correct
- Test: two concurrent `loroUpdate` commits merge without conflict
- Test: `loroUpdate` commit round-trips through `serialize_deterministically_json_ad`

---

## Phase 2: History via Loro Time-Travel (Rust + Browser)

Goal: Replace the "replay all commits sequentially" history model with Loro's built-in OpLog and `checkout()`.

### 2.1 Loro-backed history on server

**File:** `lib/src/db.rs`, `lib/src/resources.rs`

- Store full Loro snapshots (with history) rather than state-only snapshots
- Add endpoint or query parameter to export Loro OpLog for a resource
- Expose version vector / frontiers in resource metadata (e.g. as a property or response header)

### 2.2 Replace `resource.getHistory()` in browser

**Files:** `browser/lib/src/resource.ts` (the `getHistory` method)

Current flow:
1. Query all commits for resource
2. Fetch each commit
3. Apply sequentially, building `Version[]` with snapshots

New flow:
1. Fetch the resource's full Loro snapshot (includes OpLog)
2. Use `doc.getAllChanges()` to enumerate changes
3. Use `doc.checkout(frontiers)` to materialize any version
4. Build `Version[]` from Loro change metadata + checkout snapshots

This eliminates the O(n) sequential replay and network round-trips per commit.

### 2.3 Update History UI

**Files:** `browser/data-browser/src/routes/History/useVersions.ts`, `versionHelpers.ts`, `HistoryRoute.tsx`

- `useVersions` hook: fetch Loro snapshot instead of commit chain
- `Version` type: add `frontiers` field for Loro checkout
- Restore version: `doc.checkout(frontiers)` → export state → create commit with `loroUpdate` setting resource to that state
- Progress tracking: no longer needed (single fetch instead of N fetches)
- `groupVersionsByMonth`: derive from Loro change timestamps
- `dedupeVersions`: derive from Loro change grouping (changes by same peer within short window)

### 2.4 `resource.setVersion()` update

**File:** `browser/lib/src/resource.ts` (`setVersion` method)

- Instead of manually computing set/remove diffs + Yjs undo updates:
  1. Checkout the target version in the LoroDoc
  2. Export the resulting state as a Loro update
  3. Create and save a commit with that `loroUpdate`

---

## Phase 3: Browser Loro Integration

Goal: Replace Yjs with Loro in the browser client library.

### 3.1 Replace YLoader with LoroLoader

**File:** `browser/lib/src/yjs.ts` → rename/replace with `browser/lib/src/loro-loader.ts`

- Lazy-load `loro-crdt` WASM module (same pattern as YLoader)
- Export `LoroLoader.initializeLoro()`, `LoroLoader.isLoaded()`, `LoroLoader.loro`

### 3.2 Update Resource to use LoroDoc

**File:** `browser/lib/src/resource.ts`

- Replace `Y.Doc` property handling with `LoroDoc`
- `getYDoc(property)` → `getLoroDoc()` (one LoroDoc per resource, not per property)
- Properties accessed via `doc.getMap("properties").get(propUrl)`
- Rich text via `doc.getText(propUrl)` 
- `setUnsafe` with LoroDoc: register Loro event subscription instead of Yjs `updateV2`
- `clone()`: export/import Loro snapshot instead of Yjs state
- `merge()`: import remote Loro update instead of Yjs state merge

### 3.3 Update CommitBuilder (browser)

**File:** `browser/lib/src/commit.ts`

- Add `_loroUpdate: Uint8Array | undefined` field
- Add `addLoroUpdateAction(update: Uint8Array)` method
- `toPlainObject()`: include `loroUpdate` as base64
- `serializeDeterministically()`: include `loroUpdate` key
- `hasUnsavedChanges()`: check `_loroUpdate`
- Eventually: `set`/`remove`/`push` operations produce Loro operations on the resource's LoroDoc, and `signChanges()` exports the Loro delta as the commit payload

### 3.4 Update `applyCommitToResource` (browser)

**File:** `browser/lib/src/commit.ts`

- Add `execLoroUpdateCommit()` function (parallel to existing `execYUpdateCommit`)
- Import Loro update into resource's LoroDoc
- Materialize changed properties into resource's propvals

### 3.5 Update Store sync

**File:** `browser/lib/src/store.ts`

- `broadcastYSyncUpdate()` → `broadcastLoroSyncUpdate(subject, update)`
  - No longer per-property; one update per resource
- `subscribeYSync()` → `subscribeLoroSync(subject, callback)`
- `__handleAwarenessUpdateMessage()` → `__handleLoroSyncMessage()`
- WebSocket message: `LORO_SYNC_UPDATE { subject, update: "<base64>" }`

### 3.6 Update WebSocket client

**File:** `browser/lib/src/websockets.ts`

- Add `LORO_SYNC_SUBSCRIBE`, `LORO_SYNC_UNSUBSCRIBE`, `LORO_SYNC_UPDATE` message types
- Parse incoming `LORO_SYNC_UPDATE` messages → forward to store

---

## Phase 4: Rich Text Editor Migration

Goal: Replace Yjs Tiptap integration with Loro Tiptap integration.

### 4.1 Switch to loro-prosemirror

**Files:** `browser/data-browser/src/chunks/RTE/CollaborativeEditor.tsx`, `useYSync.ts`

- Replace `@tiptap/extension-collaboration` (Yjs-based) with `loro-prosemirror` plugins:
  - `LoroSyncPlugin` (replaces `Collaboration`)
  - `LoroUndoPlugin` (replaces `History` extension)
  - `LoroEphemeralCursorPlugin` (replaces `CollaborationCaret`)
- The LoroDoc's `getText("documentContent")` or similar container feeds the editor
- Install: `npm install loro-prosemirror loro-crdt`

### 4.2 Replace useYSync with useLoroSync

**File:** `browser/data-browser/src/chunks/RTE/useYSync.ts` → `useLoroSync.ts`

- Subscribe to local Loro updates via `doc.subscribeLocalUpdates(callback)`
- Broadcast via `store.broadcastLoroSyncUpdate()`
- Receive remote updates via `store.subscribeLoroSync()`
- Apply remote updates via `doc.import(update)`
- Awareness/presence: use Loro's `EphemeralStore` (from loro-prosemirror) instead of Yjs Awareness protocol

### 4.3 Update document text extraction

**File:** `browser/data-browser/src/hooks/useDocumentText.ts`

- Replace `Y.Doc` tree walking with Loro Text `.toString()` for plain text extraction
- Much simpler — Loro Text has a direct string representation

---

## Phase 5: Server-Side Sync Updates

Goal: Update server WebSocket handler and broadcaster for Loro.

### 5.1 Replace YSyncBroadcaster with LoroSyncBroadcaster

**File:** `server/src/y_sync_broadcaster.rs` → `server/src/loro_sync_broadcaster.rs`

- Subscriptions keyed by `Subject` (not `(Subject, Property)` — Loro is per-document)
- Same authorization model: check read/write rights
- Same broadcast pattern: relay binary updates to subscribers, exclude sender
- Optionally: server can merge updates into its LoroDoc before broadcasting (ensures consistency)

### 5.2 Update WebSocket handler

**File:** `server/src/handlers/web_sockets.rs`

- Add `LORO_SYNC_SUBSCRIBE`, `LORO_SYNC_UNSUBSCRIBE`, `LORO_SYNC_UPDATE` handlers
- Keep `Y_SYNC_*` handlers during transition period
- `LORO_SYNC_UPDATE`: forward to LoroSyncBroadcaster, which broadcasts to other clients

### 5.3 Update Commit handler

**File:** `server/src/handlers/commit.rs`

- After applying a `loroUpdate` commit, broadcast the Loro update to connected Loro sync subscribers
- This ensures clients doing real-time Loro sync also get persistent commit updates

---

## Phase 6: Migration & Cleanup

### 6.1 Migrate existing Yjs documents

- Write a migration script/command that:
  1. Finds all resources with `Value::YDoc` properties
  2. For each, reads the Yjs binary state
  3. Reconstructs the text content from Yjs state
  4. Creates a new LoroDoc with that content in the equivalent Loro Text container
  5. Saves as a new commit with `loroUpdate`

### 6.2 Migrate non-Yjs resources to Loro

- For existing resources that only have PropVals (no CRDT backing):
  - On first `loroUpdate` commit, auto-initialize a LoroDoc from current PropVals
  - Alternatively: run a batch migration to create LoroDoc snapshots for all resources

### 6.3 Remove Yjs dependencies

**Rust:** Remove `yrs` from `lib/Cargo.toml`
**Browser:** Remove `yjs`, `@tiptap/extension-collaboration`, `y-prosemirror` from package.json

**Files to remove/replace:**
- `browser/lib/src/yjs.ts` → `loro-loader.ts`
- `server/src/y_sync_broadcaster.rs` → `loro_sync_broadcaster.rs`
- All `Y_SYNC_*` WebSocket message handling
- `Value::YDoc` variant → `Value::LoroDoc` (or just remove if everything is in the Loro snapshot)
- `DataType::YDoc` → `DataType::LoroDoc`
- `execYUpdateCommit()` in browser commit.ts

### 6.4 Update `previousCommit` handling

- With Loro handling merge/causality, `previousCommit` becomes optional metadata
- Server no longer needs to reject commits with mismatched `previousCommit`
- Keep the field for audit trail purposes but don't enforce it
- `validate_previous_commit` option already exists and is already `false` in production (commit.rs handler)

---

## File Impact Summary

### Rust files to modify

| File | Changes |
|------|---------|
| `lib/Cargo.toml` | Add `loro` (done), eventually remove `yrs` |
| `lib/src/loro.rs` | Expand `AtomicLoroDoc` wrapper (done, extend) |
| `lib/src/values.rs` | Add `Value::LoroDoc` or rename `YDoc` |
| `lib/src/datatype.rs` | Add `DataType::LoroDoc` |
| `lib/src/commit.rs` | Add `loro_update` field, handle in `apply_changes()` |
| `lib/src/resources.rs` | Add `loro_snapshot` to Resource, integrate with save/load |
| `lib/src/db.rs` | Store/load Loro snapshots alongside PropVals |
| `lib/src/parse.rs` | Parse `loroUpdate` from JSON-AD |
| `lib/src/serialize.rs` | Serialize `loroUpdate` to JSON-AD |
| `lib/src/urls.rs` | Add `LORO_UPDATE` constant |
| `lib/src/store.rs` | Handle `loro_update` in in-memory apply_commit |
| `server/src/handlers/commit.rs` | No structural changes (commit handling is generic) |
| `server/src/handlers/web_sockets.rs` | Add LORO_SYNC_* message types |
| `server/src/y_sync_broadcaster.rs` | Replace with `loro_sync_broadcaster.rs` |
| `server/src/actor_messages.rs` | Add LoroSync message types |

### Browser files to modify

| File | Changes |
|------|---------|
| `browser/lib/src/commit.ts` | Add `loroUpdate`, `execLoroUpdateCommit()`, update serialization |
| `browser/lib/src/resource.ts` | Replace YDoc with LoroDoc, update `getHistory()`, `setVersion()`, `clone()`, `merge()` |
| `browser/lib/src/store.ts` | Replace `broadcastYSyncUpdate`/`subscribeYSync` with Loro equivalents |
| `browser/lib/src/websockets.ts` | Add LORO_SYNC_* message types |
| `browser/lib/src/yjs.ts` | Replace with `loro-loader.ts` |
| `browser/lib/src/parse.ts` | Parse `loroUpdate` values |
| `browser/lib/src/value.ts` | Handle LoroDoc value type |
| `browser/lib/src/datatypes.ts` | Add LoroDoc datatype |
| `browser/react/src/hooks.ts` | Minor: Version type changes |
| `browser/data-browser/src/chunks/RTE/CollaborativeEditor.tsx` | Replace Yjs extensions with loro-prosemirror |
| `browser/data-browser/src/chunks/RTE/useYSync.ts` | Replace with `useLoroSync.ts` |
| `browser/data-browser/src/routes/History/useVersions.ts` | Fetch Loro snapshot, use checkout |
| `browser/data-browser/src/routes/History/versionHelpers.ts` | Derive from Loro changes |
| `browser/data-browser/src/routes/History/HistoryRoute.tsx` | Remove progress bar (single fetch), update restore logic |
| `browser/data-browser/src/hooks/useDocumentText.ts` | Replace Yjs tree walk with Loro text |
| `browser/data-browser/src/components/YDocValue.tsx` | Replace with LoroDocValue |
| `browser/data-browser/src/components/forms/InputYDoc.tsx` | Replace with InputLoroDoc |

---

## Implementation Order

```
Phase 1 ─── Dual-mode foundation (Rust)
  │          ~1-2 weeks, no breaking changes
  │
Phase 2 ─── History via Loro time-travel  
  │          ~1 week, improves history UX significantly
  │
Phase 3 ─── Browser Loro integration
  │          ~2 weeks, biggest change surface
  │
Phase 4 ─── Rich text editor migration
  │          ~1 week, swap Yjs→Loro in Tiptap
  │
Phase 5 ─── Server sync updates
  │          ~1 week, WebSocket protocol changes
  │
Phase 6 ─── Migration & cleanup
             ~1 week, remove Yjs, migrate data
```

Phases 1-2 can ship independently (backward compatible).
Phases 3-5 are a coordinated browser+server release.
Phase 6 is cleanup after the transition period.

---

## Key Decisions to Make

1. **One LoroDoc per Resource vs per Property?**
   - Recommendation: one per Resource. Properties are named containers within it. Simpler model, matches Loro's design.

2. **Store Loro snapshot format?**
   - Option A: Full snapshot with history (enables time-travel without extra fetches)
   - Option B: State-only snapshot + separate OpLog (saves disk space for resources with long histories)
   - Recommendation: Start with A (full snapshot). Optimize to B later with shallow snapshots for large resources.

3. **When to auto-initialize LoroDoc for legacy resources?**
   - On first `loroUpdate` commit (lazy migration)
   - Or batch-migrate all resources on server upgrade
   - Recommendation: Lazy migration. Create LoroDoc from PropVals on first Loro commit.

4. **Transition period: support both `y_update` and `loroUpdate`?**
   - Yes, during Phases 1-5. Server handles both. Browser sends `loroUpdate` for new edits, can still receive `y_update` from old clients.
   - Phase 6 removes `y_update` support.

5. **PeerId ↔ Agent mapping?**
   - Loro PeerIds are u64, one per editing session (browser tab, device, server instance).
   - A single agent DID may have multiple concurrent PeerIds (e.g. two tabs open).
   - Let Loro assign random PeerIds per session (its default behavior). Do NOT derive from agent DID.
   - Use `subscribeFirstCommitFromPeer` to store `peerId → agentDID` mapping inside the LoroDoc as metadata.
   - The commit signature already authenticates which agent authored each batch of operations.
   - For "who wrote this text?" attribution: look up peerId in the mapping stored in the doc.
