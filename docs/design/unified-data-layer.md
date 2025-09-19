# Unified Data Layer: Local WASM DB ↔ Server ↔ Mesh

## Problem

The browser app currently has separate code paths for talking to:

1. **The server** — HTTP fetches, WebSocket subscriptions, commit POSTs
2. **The local WASM DB** — custom worker messages, custom hydration, manual index queries
3. **localStorage** — (being removed) offline resource persistence

Each path has its own serialization, error handling, subscription model, and response parsing. This duplication makes the codebase fragile and hard to extend. Adding a new transport (mesh/Reticulum) would require yet another parallel implementation.

## Goal

A single protocol that works identically across:

- **Local WASM DB** (OPFS-backed, ~0.1ms latency)
- **Server** (HTTP/WebSocket, ~10-100ms latency)
- **Mesh peers** (Reticulum/WebRTC, ~100ms-10s latency, unreliable)

The Store shouldn't know or care which backend it's talking to. It subscribes to resources and queries, receives notifications, and sends commits — the transport is abstracted away.

## Considerations

### Reads vs Writes are fundamentally different

**Reads** (GET resource, QUERY) can be served by any backend that has the data. The response format (JSON-AD) is identical regardless of source. The Store should try the fastest source first (WASM DB), then fall back to slower sources (server, mesh peers).

**Writes** (Commits) are different per backend:
- **Server**: POST commit → server validates signature, checks authorization, applies, returns commit ID
- **WASM DB**: sign locally → apply locally → queue for sync
- **Mesh**: broadcast signed commit → peers validate and apply independently (CRDT convergence)

The write path can't be fully unified because validation and authority differ. But the commit format itself (JSON-AD with signature) is the same everywhere.

### Authorization

**Server**: checks `for_agent` on every request. Resources have explicit read/write rights. The server is the authority.

**WASM DB**: everything stored locally was either created by or fetched for the current user. No authorization needed — it's your own data. The WASM DB uses `ForAgent::Sudo`.

**Multi-user on shared computer**: if multiple users share a browser profile, they share the same OPFS. Options:
1. **Don't support it** — each user should use their own browser profile. This is the simplest and most secure approach. OPFS is scoped to the origin, not the user.
2. **Namespace by agent** — prefix OPFS filenames with the agent's public key. Each agent gets their own redb database. Switching agents means switching databases.
3. **Encrypt at rest** — encrypt the OPFS data with a key derived from the agent's private key. Other users can't read it even if they access the same OPFS. This is more complex but provides real isolation.

Recommendation: start with (1), plan for (2) if needed. Multi-user on shared computer is an edge case — most people have their own browser profile.

**Mesh**: peers may not be trusted. Authorization must be checked on the receiving side. A peer sends a signed commit; the receiver verifies the signature and checks if the signer has write access before applying. This is the same check the server does, but done locally.

### Subscriptions and Live Queries

**Current server WebSocket protocol:**
- `SUBSCRIBE subject` — watch a resource, receive `COMMIT` messages when it changes
- `QUERY property value sort_by ...` — subscribe to a query, receive updates when matching resources change

**Proposed unified subscription model:**

```
SUBSCRIBE resource <subject>
  → RESOURCE <subject> <json-ad>        (initial value)
  → RESOURCE <subject> <json-ad>        (on change)

SUBSCRIBE query <property> <value> <sort_by> <page_size> ...
  → COLLECTION <query-id> <json-ad>     (initial results)
  → COLLECTION <query-id> <json-ad>     (on change)

COMMIT <json-ad-commit>
  → COMMIT_APPLIED <commit-id>          (success)
  → COMMIT_ERROR <message>              (failure)
```

The WASM DB, server, and mesh peers all speak this same protocol. The Store registers subscriptions on all available backends. Responses arrive as they come — local is instant, server is fast, mesh is slow.

### Latency and Efficiency (Mesh/Reticulum)

High-latency networks require:

1. **Optimistic local-first** — apply changes locally immediately, sync in the background. The user never waits for a round-trip. This is already how the offline save path works.

2. **Delta updates, not full snapshots** — don't send entire resources over slow links. Loro CRDT updates are already deltas. Commits are deltas (set/push/remove). The protocol should prefer deltas.

3. **Batching** — on slow links, batch multiple commits into a single message. The receiver applies them in order.

4. **Deduplication** — commits have signatures. A peer that receives the same commit twice (from different paths in the mesh) should ignore the duplicate. This is already handled by `appliedCommitSignatures`.

5. **Partial sync** — don't sync everything. Subscribe to specific resources and queries. Only receive data you've asked for. This maps naturally to the subscription model above.

6. **Conflict resolution** — CRDTs (Loro) handle concurrent edits. The protocol doesn't need to coordinate — peers apply updates independently and converge. This is the key advantage of the Loro-based approach.

### Binary efficiency

JSON-AD is human-readable but not bandwidth-efficient. For mesh networks:

- **Commits** could be sent as signed binary (the commit's serialized form before JSON encoding). The signature is over the canonical byte representation anyway.
- **Loro updates** are already binary (`Uint8Array`). They should be sent as-is, not base64-encoded.
- **Resource snapshots** could use a compact binary format (CBOR, MessagePack) instead of JSON-AD for transport, while keeping JSON-AD as the canonical storage format.

This is a future optimization — start with JSON-AD everywhere for simplicity.

## Architecture Sketch

```
┌─────────────────────────────────────────────┐
│                   Store                      │
│                                              │
│  subscribe(subject)  query(filter)  commit() │
│         │                │             │     │
│         ▼                ▼             ▼     │
│   ┌──────────────────────────────────────┐   │
│   │          Backend Manager             │   │
│   │  Routes subscriptions & commits to   │   │
│   │  all available backends. Merges      │   │
│   │  responses. Deduplicates.            │   │
│   └──┬──────────┬──────────┬─────────────┘   │
│      │          │          │                 │
│      ▼          ▼          ▼                 │
│  ┌───────┐ ┌────────┐ ┌──────────┐          │
│  │ Local  │ │ Server │ │  Mesh    │          │
│  │ WASM   │ │ WS/HTTP│ │ Peer(s)  │          │
│  │ Worker │ │        │ │          │          │
│  └───────┘ └────────┘ └──────────┘          │
│   ~0.1ms    ~10-100ms   ~100ms-10s           │
└─────────────────────────────────────────────┘
```

Each backend implements the same interface:
- `subscribe(subject)` → stream of resource updates
- `query(filter)` → stream of collection updates  
- `commit(commit)` → success/error

The Backend Manager:
- Registers subscriptions on all backends
- Returns the first response (usually local)
- Merges later responses (server/mesh may have newer data)
- Deduplicates by commit signature
- Handles reconnection and resubscription

## Loro Snapshots as the Canonical Representation

### The redundancy problem

Currently, a resource's state is stored in multiple forms:
1. **JSON-AD properties** in the `Resources` redb table (for indexing/queries)
2. **Loro snapshot** in the `LoroSnapshots` redb table (for CRDT state)
3. **In-memory propvals Map** on the Resource object (for rendering)
4. **Server-side JSON-AD** (the "authoritative" version)

These must all stay in sync. When a Loro update arrives, properties are extracted from the Loro map and written to propvals. When a resource is fetched from the server, properties are parsed from JSON-AD and also written into the Loro doc. This is fragile and redundant.

### Concrete example of the divergence

Inspecting a Folder resource's data view reveals the problem. The **Loro snapshot** (771 bytes) contains:

```json
{
  "https://atomicdata.dev/properties/parent": "did:ad:8ZEtla...",
  "https://atomicdata.dev/properties/name": "dawaad",
  "https://atomicdata.dev/properties/isA": "[\"https://atomicdata.dev/classes/Folder\"]",
  "https://atomicdata.dev/property/display-style": "https://atomicdata.dev/display-style/list"
}
```

But the **resource propvals** (shown in the data view) contain additional properties that the Loro doc doesn't have:
- `created-at` — set by `applyPendingCommitsLocally`, bypassing the Loro map
- `last-commit` — set directly on propvals after commit signing

And the Loro doc has its own issues:
- `isA` is stored as a JSON string (`"[\"...\"]"`) rather than an actual array, because `loroSetProperty` serializes arrays with `JSON.stringify()`. This means reading `isA` from the Loro doc requires an extra parse step that reading from propvals doesn't.

So the same resource has **three subtly different representations** of its state:
1. The Loro map (missing `created-at`, `last-commit`; arrays are JSON strings)
2. The propvals Map (has everything, but `Uint8Array` values like `loroUpdate` don't round-trip through JSON-AD)
3. The WASM DB JSON-AD index (missing `Uint8Array` values, may be stale)

Any code that reads from the wrong source gets wrong answers. The sidebar's `hideChildren` check was broken for exactly this reason — it read `isA` from propvals, but after an OPFS round-trip the value was missing because the WASM DB index didn't preserve it correctly.

### The solution: Loro is the single store, toJSON() is the read cache

The Loro doc is the only store. But **direct Loro reads are too slow for the render path**.

Benchmarks (Node.js, vitest bench, 10 properties per resource):

| Operation | Speed | Absolute time |
|-----------|-------|---------------|
| `LoroMap.get()` x10 props | 155K ops/sec | 0.006ms |
| `Map.get()` x10 props | 24M ops/sec | 0.00004ms |
| **`cachedObject[key]` x10 props** | **18M ops/sec** | **0.00006ms** |
| Direct Loro reads from 200 docs | 1.4K ops/sec | 0.7ms |
| **Cached object reads from 200 docs** | **107K ops/sec** | **0.009ms** |
| `loroMap.toJSON()` once | 315K ops/sec | 0.003ms |
| `toJSON()` for 200 docs (bulk rebuild) | 1.3K ops/sec | 0.78ms |
| Import 200 snapshots (page reload) | 128 ops/sec | 7.8ms |

**Key finding:** `loroMap.toJSON()` produces a plain JS object. Reading properties from that object is nearly as fast as `Map.get()` — only 6x slower, vs 560x for direct Loro reads. And `toJSON()` itself costs only 0.003ms per call.

**Architecture: write to Loro, cache with toJSON()**

```
resource.set("name", "foo")  →  loroMap.set("name", "foo")
                                 this._cache = loroMap.toJSON()  ← 0.003ms

resource.get("name")         →  this._cache["name"]             ← plain object lookup
```

No propvals Map. No dual-write. No sync. The cache is rebuilt from `toJSON()` after each write — a single 0.003ms call. Reads are plain object property lookups.

For 200 resources on screen, each reading 10 props:
- **Direct Loro:** 0.7ms per render — too slow
- **Cached objects:** 0.009ms per render — negligible
- **Bulk cache rebuild (page load):** 0.78ms — acceptable

This means:
- Loro is the single source of truth for all property data
- The cache is a plain object derived from `toJSON()` — can be rebuilt at any time
- No divergence is possible because there's only one write path
- No `setUnsafe()` — every property write goes through the Loro map
- `get()` is fast (plain object lookup, nearly as fast as Map)

**What doesn't go in the Loro doc:**
- The Loro snapshot binary itself (circular — can't store a doc inside itself). Stored separately in the `LoroSnapshots` redb table.
- Internal commit chain state (`_lastLocalSignature`). Stays as a private field on Resource, not a property.
- The `@id` subject. Stays as `resource.subject`.

**Everything else is a Loro map entry:**
- `isA`, `parent`, `name`, `description` — all properties
- `createdAt`, `lastCommit` — written through the Loro map, not bypassing it
- Arrays use native `LoroList` instead of `JSON.stringify`

**Storage:**
- The `LoroSnapshots` table stores the canonical resource state (binary)
- The `Resources` table stores a derived JSON-AD index (for property-value queries). This is a read-only projection, rebuilt from the Loro doc when needed.

**Transport:**
- Server sends Loro snapshots (binary) instead of JSON-AD when the client supports it
- Updates are Loro deltas — small binary diffs, not full resource snapshots
- Same binary format for WASM DB, server WebSocket, and mesh transport

**Sync protocol:**
```
SUBSCRIBE resource <subject>
  → SNAPSHOT <subject> <loro-binary>           (full state)
  → UPDATE <subject> <loro-delta-binary>       (incremental change)

LOCAL_EDIT <subject> <loro-delta-binary>
  → broadcast to server/peers
  → peers import delta, converge automatically
```

No commits needed for the data sync path — Loro handles convergence. Commits become an audit/authorization mechanism:
- Commits prove that a specific agent made a specific change at a specific time
- The server validates commits for authorization (does this agent have write access?)
- But the actual data merge is done by Loro, not by commit application

### Benefits

- **One format everywhere** — WASM DB, server, mesh all speak Loro binary
- **Smaller payloads** — binary snapshots are more compact than JSON-AD
- **No parse/reconcile step** — import the snapshot, read properties from the Loro map
- **Instant offline** — the WASM DB has the Loro snapshot, the client imports it, done
- **Efficient sync** — deltas are tiny (just the changed operations), not full resource re-sends
- **Conflict-free** — Loro CRDTs merge automatically, no matter the order or timing of updates

### JSON-AD's role changes

JSON-AD doesn't go away — it remains the query index format and the human-readable representation. But it becomes a derived view:
- When a Loro snapshot is imported, properties are extracted and written to the JSON-AD index
- The index enables property-value queries (find all resources where `parent = X`)
- External APIs can still serve JSON-AD for compatibility
- But the wire protocol between peers prefers Loro binary

## Compact Loro Documents

### The size problem

Currently the Loro map stores full Atomic Data property URLs as keys:

```json
{
  "https://atomicdata.dev/properties/parent": "did:ad:8ZEtla...",
  "https://atomicdata.dev/properties/name": "dawaad",
  "https://atomicdata.dev/properties/isA": "[\"https://atomicdata.dev/classes/Folder\"]"
}
```

Issues:
- **Bloated keys** — every key is 40+ bytes of URL. A resource with 10 properties wastes 400+ bytes on keys alone. These keys are repeated in every Loro operation in the history.
- **Double-encoded arrays** — arrays are stored as `JSON.stringify(["..."])` strings because `loroSetProperty` doesn't use native Loro types. This prevents per-element CRDT merging and wastes bytes.
- **Full history accumulates** — Loro snapshots grow with every edit. A document edited 1000 times carries all 1000 operations.

### Compactness strategies

#### 1. Native Loro types for arrays and nested data

Instead of `JSON.stringify(["https://..."])`, use `LoroList`:

```
Before: map.set("isA", "[\"https://atomicdata.dev/classes/Folder\"]")  // opaque string
After:  map.set("isA", LoroList(["https://atomicdata.dev/classes/Folder"]))  // native list
```

Benefits:
- **Per-element CRDT merging** — adding/removing array items merges without conflict
- **No double-encoding** — the list is stored natively, no JSON parse/stringify overhead
- **Smaller deltas** — changing one array element generates a tiny delta, not a full array replacement

This applies to `ResourceArray` properties (tags, classes, sub-resources) which are common.

#### 2. Delta-only transport

Never send full snapshots over the wire after the initial sync:

```
Initial:  SNAPSHOT <subject> <loro-binary>              (full state, once)
Updates:  UPDATE <subject> <loro-delta-binary>          (tiny deltas, frequent)
```

Loro deltas are just the operations since a given version. Changing a resource's `name` from "foo" to "bar" produces a delta of ~50 bytes, regardless of how large the full snapshot is.

The server/WASM DB stores full snapshots for persistence. The wire protocol sends deltas for efficiency.

#### 3. Shallow snapshots for long-lived resources

Loro can export "shallow snapshots" that trim operations older than a given version. This caps snapshot size regardless of how many edits a resource has had. See the [History and Time Travel](#history-and-time-travel) section for how this interacts with history navigation.

#### Size: Loro snapshots vs JSON-AD

Loro snapshots are ~1.5x larger than JSON-AD for a fresh resource (CRDT metadata overhead). With 100 edits to a property, the snapshot grows to ~2x JSON-AD — the history is compact. Shallow snapshots can trim this.

The big win is **deltas**: a single property change is ~143 bytes as a Loro delta vs ~742 bytes to re-send the full JSON-AD. For real-time sync, deltas are 5x smaller.

Tradeoff: slightly more disk for CRDT history, dramatically less bandwidth for sync.

#### Note on key shortening

Property URLs as Loro map keys (e.g. `"https://atomicdata.dev/properties/name"`) look wasteful, but Loro internally stores each key string once in a registry and references it by integer ID in operations. The full URL is only materialized in snapshot exports, not in deltas. For a typical resource with 10 properties, the key overhead is ~400 bytes — a small fraction of the total snapshot. Key shortening (using shortnames or integer IDs) is a possible future optimization but not a priority. It also becomes more complex if properties themselves use DIDs in the future.

## History and Time Travel

### Requirements

- Users can browse the full edit history of a resource
- Users can view the resource at any point in time
- Users can see who made each change and when
- History should be efficient to store and navigate

### How Loro handles history

Loro's oplog (operation log) records every operation with:
- **Peer ID** — which peer made the change (maps to our Agent/signer)
- **Counter** — monotonic per-peer, establishes causal order
- **Timestamp** — when the operation was created (optional, set by the client)
- **Content** — the actual change (insert, delete, set)

`LoroDoc.checkout(version)` reconstructs the document state at any version by replaying operations up to that point. This is already used in the existing `resource.getHistory()` method.

### Tiered history storage

The tension: **compact snapshots** (trim old history) vs **full time travel** (keep everything).

Resolution: tiered storage with on-demand loading.

```
┌─────────────────────────────────────────────────┐
│                Resource History                  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Hot Tier: Loro Snapshot                   │  │
│  │  Contains: recent N operations             │  │
│  │  Stored in: LoroSnapshots redb table       │  │
│  │  Available: instantly, always loaded        │  │
│  │  Time travel: within recent window          │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Cold Tier: Archived Commits               │  │
│  │  Contains: older operations as commits     │  │
│  │  Stored in: server / OPFS / mesh peers     │  │
│  │  Available: on demand (fetch when needed)   │  │
│  │  Time travel: extends range on request      │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Frozen Tier: Shallow Snapshot boundary     │  │
│  │  History before this point is summarized    │  │
│  │  Only the resulting state is kept           │  │
│  │  Individual operations are discarded        │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**Hot tier** — the Loro snapshot contains recent history. Users can navigate freely within this window. This is what's stored in the `LoroSnapshots` redb table. Size is bounded by periodically creating shallow snapshots.

**Cold tier** — older commits are stored as separate resources (they already are — `did:ad:commit:...`). When the user wants to see history beyond the hot tier, these are fetched from the server, OPFS, or mesh peers and imported into the Loro doc to extend the time travel range.

**Frozen tier** — below the shallow snapshot boundary, individual operations are gone. Only the aggregate state at that point is preserved. This is acceptable for very old history — users rarely need operation-level granularity for changes made months ago.

### History UI flow

1. User opens history view → Loro doc already has recent operations → show timeline immediately
2. User scrolls back to older history → fetch archived commits from cold tier → import into Loro → extend timeline
3. User hits the frozen boundary → show "history before this date is summarized" → display the snapshot state at that point

### Commits as history metadata

Commits carry metadata that Loro operations don't:
- **Signer** — the agent's DID (Loro only has a peer ID, which is opaque)
- **Authorization proof** — the signature proves the agent had write access
- **Semantic grouping** — a commit bundles related changes (e.g. "renamed and moved resource")
- **Human timestamp** — when the change was made (Loro timestamps are optional and untrusted)

So commits remain valuable for the history UI even when Loro handles the data merge. The history view shows commits (who, when, what) while Loro provides the "view at this point in time" capability.

The mapping between commits and Loro versions:
- Each commit corresponds to a Loro version range (the operations included in that commit)
- The commit's signature can be stored as metadata on the Loro operations (via Loro's `PeerID` → Agent mapping)
- Navigating to a commit means checking out the Loro doc at that version

## Migration Path

### Phase 1: Drop propvals, Loro is the only store (client)
- ~~Remove `propvals` Map from Resource~~ (done — `PropVals` type and `getPropVals()` removed, replaced by `getEntries()`)
- ~~`resource.get()` reads from Loro map~~ (done — reads from `_cache` derived from Loro)
- ~~`resource.set()` writes to Loro map only~~ (done)
- ~~Every resource gets a Loro doc on hydration (not lazy)~~ (done)
- ~~Use native `LoroList` for arrays~~ (done — browser + Rust)
- ~~Remove `setUnsafe()`, `execSetCommit`, `execRemoveCommit`, `execPushCommit`~~ (done — all removed)
- ~~JSON-AD from server/WASM DB is imported into a Loro doc on arrival~~ (done)

**Status: Complete** (browser side). Rust `propvals` is still the server-side canonical store.

### Phase 2: Loro-native transport
- Server sends Loro snapshots/deltas over WebSocket instead of JSON-AD
- Client imports directly — no JSON-AD parsing on the hot path
- Commits carry Loro deltas (already the case) but authorization is checked separately from data merge
- JSON-AD remains available as an HTTP content type for external consumers

**Status**
- Partially complete.
- Commits already carry `loroUpdate`, and the server already rejects legacy `set` / `push` / `remove` commit writes.
- The server now serializes the freshest in-memory Loro snapshot into normal JSON-AD resource responses when Loro state is present, so clients can bootstrap from server-side Loro state more reliably.
- The transport is still JSON-AD-first on normal reads and WebSocket resource updates. We have not yet introduced a snapshot-first or delta-first resource transport.

### Phase 3: Unify WASM DB and server communication
- WASM DB worker speaks the same SUBSCRIBE/QUERY protocol as the server WebSocket
- Store registers subscriptions on both WASM worker and server WebSocket
- Remove separate `queryLocalDb`, `fetchResourceFromClientDb` code paths
- One fetch/subscribe path that tries local backend first, then server

**Status**
- Not started.
- The browser store still has explicit local-db and server code paths.

### Phase 4: Backend abstraction
- Extract a `Backend` interface
- Server WebSocket becomes one Backend implementation
- WASM worker becomes another
- Store talks to Backend Manager, not individual backends

**Status**
- Not started.

### Phase 5: Iroh peer-to-peer transport
- Add `iroh-net` as a transport backend — zero-config NAT traversal, no port forwarding
- Same binary v2 protocol frames, running over QUIC streams instead of WebSocket
- Server publishes a NodeID (public key) that clients connect to directly
- Browser clients still use WebSocket; native/desktop clients can use Iroh directly

**Status**
- Not started. Design below.

## Implementation Analysis: Current Loro Integration

### Progress snapshot

This section started as a description of the pre-migration system. It is now partially outdated. The current codebase is in a mixed state:

- **Browser reads**: moved from `propvals` as the primary read source to a derived cache object plus aux binary state.
- **Browser hydration**: JSON-AD parsing and store hydration now create / initialize a Loro doc when Loro is available.
- **Browser commit application**: `loroUpdate` imports rebuild the cache directly, and the runtime no longer applies legacy `set` / `push` / `remove` payloads.
- **Browser compatibility surface**: internal `resource.ts` paths are gradually moving off `getPropVals()` / fake propval replay and onto cache + Loro state directly.
- **Browser store/parsing glue**: common hydration and storage paths now use narrower `Resource` helpers instead of reaching into the compatibility `Map` view for serialization and diagnostics.
- **Browser metadata writes**: commit-driven `lastCommit` updates are starting to move behind explicit `Resource` helpers instead of generic raw writes.
- **Browser raw-write escape hatch**: `Resource` internals now route hydration/metadata writes through private helpers first, with `setUnsafe()` increasingly becoming a compatibility wrapper instead of the primary internal path.
- **Server writes**: already Loro-primary.
- **Server reads**: still JSON-AD based, but now include the latest server-side `loroUpdate` snapshot when a resource has Loro state.
- **Server Loro materialization**: commit application now needs to seed from existing materialized state when no snapshot exists and rebuild the full materialized state after import, so deletes and older no-snapshot resources do not drift.
- **Server unsafe replacement paths**: direct full-propval replacement now needs to invalidate stale Loro state so parser/import paths do not keep an old CRDT snapshot alive behind newer materialized data.
- **Rust local resource state after remote save**: when a snapshot is rebuilt for signing/posting, the in-memory Loro doc and materialized props should both retain that snapshot so follow-up reads and edits stay on the same base state.
- **Sync protocol**: VV-based drive sync (SYNC_VV → SYNC_DIFF → SYNC_DELTAS) is implemented end-to-end over WebSocket. Dirty resources are synced in dependency order on reconnect.
- **Agent persistence**: fixed — the server's agent DID fallback no longer blocks genesis commits, so agent properties (personalDrive, sharedWithMe, drives) persist across page refreshes.
- **Dead code cleanup**: started, but incomplete. The design should now be read as "target + progress log", not as a fully current description of the implementation.

### The dual-store architecture

The system still maintains two parallel stores in important parts of the system, but the browser client is partway through migration:

1. **Derived cache / propvals-like view** — the read layer used by rendering and serialization.
2. **Loro Doc** — the CRDT layer, used for deltas, history, and merge logic.

On the Rust side, `Resource.propvals` is still the canonical field store, with Loro snapshots persisted alongside it.

### Where they stay in sync

- `resource.set(prop, value)` writes to the browser cache and the Loro doc
- `resource.remove(prop)` deletes from the browser cache and the Loro doc
- `resource.push(prop, values)` updates the browser cache and the Loro doc
- Rust commit application still materializes Loro state back into `propvals`

### Where they diverge (the problem)

| Code path | propvals | Loro | Consequence |
|-----------|----------|------|-------------|
| Browser `setUnsafe()` | cache / aux updated | sometimes skipped | Remaining migration helper, still a source of bypasses |
| Rust `Resource.propvals` | authoritative | derived / persisted separately | Rust still has a true dual-store architecture |
| `applyPendingCommitsLocally()` | updates metadata locally | partially mirrored | Offline metadata is not yet modeled as purely Loro state |
| Legacy commit schema in signing/parsing | still present for compatibility | not used by runtime apply path | The wire schema still accepts old fields, but live browser application is now Loro-only |

### Key insight: reads never consult Loro

This statement is no longer fully true.

In the browser client, `resource.get()` now reads from a derived cache object plus aux state, not directly from a `propvals` map. That is progress. However, the cache is still rebuilt from Loro or hydrated JSON, not read from Loro on demand.

The important remaining problem is on the Rust side: reads still fundamentally consult materialized property state, with Loro acting as the persisted CRDT representation rather than the immediate source of truth for normal reads.

### Array serialization problem

~~`loroSetProperty()` serialized arrays as JSON strings, preventing per-element CRDT merging.~~

**Status: Done.**
- Browser `loroSetProperty()` now uses native `LoroList` via `map.setContainer(prop, new LoroList())`.
- Rust `set_property()` now uses `root.insert_container(property, LoroList::new())`.
- Both sides handle legacy JSON-stringified arrays on read for compatibility.
- `rebuildCacheFromLoro()` / `normalizeLoroValue()` passes native arrays through directly.
- `loro_value_to_atomic_value()` handles `LoroValue::List` → `ResourceArray` natively.
- `get_all_properties()` uses `container.get_deep_value()` for container types (LoroList, etc.).

### Server already requires Loro-only commits

The server (`server/src/handlers/commit.rs` lines 23-32) rejects old-style `set`, `push`, `remove` fields. Only `loroUpdate` is accepted. The commit handler:
1. Loads the existing Loro snapshot from the resource
2. Imports the incoming `loroUpdate` delta
3. Materializes all properties from the merged Loro doc
4. Stores the new snapshot for future merges

This means the server is already Loro-primary for writes. The client is the one lagging behind.

**Additional current status**
- Server-side fetch serialization now includes the latest `loroUpdate` snapshot when a resource has in-memory Loro state.
- Commit application now seeds from existing materialized state when no stored snapshot exists and rebuilds the full materialized state from the merged Loro doc, so deleted properties do not remain stale in `propvals`.
- This does not yet make the transport Loro-native, but it does make server-side Loro state observable and syncable by clients.

### What this requires

**Step 1: Every resource gets a Loro doc**
- Currently the Loro doc is lazy — only created when the resource is edited
- After migration, every resource has a Loro doc from the moment it's hydrated
- When loading from JSON-AD (server fetch, WASM DB), create a Loro doc and populate it
- When loading from a Loro snapshot (OPFS, server), import it directly
- After creating/importing, call `toJSON()` to populate the read cache

**Progress**
- Partially done in the browser client.

**Step 2: Replace propvals with toJSON cache**
- `resource.get(prop)` → `this._cache[prop]` (plain object lookup)
- `resource.set(prop, value)` → `loroMap.set(prop, value)` then `this._cache = loroMap.toJSON()`
- Remove `propvals` Map entirely
- Remove `setUnsafe()` — all property writes go through the Loro map
- `createdAt`, `lastCommit` are regular Loro map entries
- Only non-property state stays outside Loro: `_lastLocalSignature`, `subject`, `loading`/`new`/`error`

**Progress**
- Partially done in the browser client.
- Not started on the Rust side.

**Step 3: Use native Loro types for arrays**
- Replace `JSON.stringify(array)` with `LoroList`
- Enables per-element CRDT merge for `isA`, `write`, `read`, tags, sub-resources
- `toJSON()` automatically converts `LoroList` to JS arrays — no manual parsing

**Progress**
- Not started.

**Step 4: Simplify commit application**
- `applyCommitToResource()` imports the Loro update, then rebuilds cache with `toJSON()`
- Remove `execSetCommit`, `execRemoveCommit`, `execPushCommit`
- The Loro import + `toJSON()` replaces all of that

**Progress**
- Partially done.
- The browser Loro update path already imports and rebuilds cache directly.
- Browser runtime application no longer replays `set` / `push` / `remove`.
- Legacy commit schema fields still exist in signing / parsing code and tests for compatibility, so this cleanup is not fully complete yet.

**Step 5: `merge()` imports Loro snapshots**
- When merging a remote resource, import its Loro snapshot
- Loro handles conflict resolution automatically
- Rebuild cache with `toJSON()` after import

**Progress**
- Partially done in the browser client.
- `Resource.merge()` now preserves unsaved local Loro edits by merging Loro state instead of replaying a fake legacy commit shape.
- The broader store-level merge strategy still needs cleanup, especially around Rust-side canonical state and backend abstraction.

### Files that need changes

| File | Change |
|------|--------|
| `browser/lib/src/resource.ts` | Partially done. Now uses `_cache` + aux values, initializes Loro on hydration, and `merge()` preserves unsaved local Loro edits. It still has migration helpers like `setUnsafe()`. |
| `browser/lib/src/commit.ts` | Partially done. Runtime commit application is now Loro-only (`loroUpdate` + destroy), and commit metadata updates are moving behind narrower `Resource` helpers. Legacy commit schema fields still remain in parsing / signing compatibility. |
| `browser/lib/src/store.ts` | Partially done. Hydration now initializes the Loro doc after JSON-AD import, and storage / diagnostics use narrower `Resource` helpers instead of `getPropVals()` directly. |
| `browser/lib/src/collection.ts` | Partially done. Synthetic collection resources now hydrate through `Resource` helpers instead of raw `setUnsafe()` calls. |
| `browser/lib/src/parse.ts` | Partially done. JSON-AD parsing now initializes the Loro doc after hydration and uses the same narrowed hydration helper path as the store. |
| `lib/src/loro.rs` | Done for arrays. `set_property()` uses native `LoroList`, `loro_value_to_atomic_value()` handles `LoroValue::List`, `get_all_properties()` resolves containers via `get_deep_value()`. Nested `LoroMap` for objects not yet done. |
| `lib/src/resources.rs` | Partially done. Serialization now includes the freshest in-memory `loroUpdate` snapshot, and Loro state can now be rebuilt from existing materialized props when no stored snapshot exists. Rust still keeps `propvals` as the canonical field store. |
| `server/src/handlers/commit.rs` | Already Loro-primary for writes, no structural change needed. |
| `server/src/handlers/get_resource.rs` | No direct handler change was needed, but the read path now benefits from fresher `Resource` serialization. |
| `browser/data-browser/src/helpers/initClientDb.ts` | Still needs cleanup so seeding and local persistence align with a Loro-primary model rather than propval-first JSON blobs. |

## One Rust Crate, Every Target

### The problem

Today we have three separate Rust implementations of the same thing:

| Crate | Compiles to | DB backend | Has validation? | Has auth? | Has queries? | Has sync? |
|-------|-------------|------------|-----------------|-----------|--------------|-----------|
| `atomic-lib` Db | native only | Sled | yes | yes | yes | no |
| `wasm/` ClientDb | WASM only | ReDB | no | no | partial | no |
| `atomic-server` | native only | (uses lib) | (uses lib) | (uses lib) | (uses lib) | yes (WS) |

The WASM client reimplements a subset of Db without validation, auth, or full queries. The sync protocol lives in the server, not the lib. Desktop/mobile apps embed the full HTTP server just to get a local database.

### The goal

One crate (`atomic-lib`) that compiles everywhere and does everything:

```
atomic-lib (compiles to native + WASM)
├── Db (ReDB everywhere — works native, WASM, mobile)
├── Commits with Loro CRDT
├── Validation, authorization, hierarchy
├── Full query indexing
├── Sync protocol (v2 binary frames, transport-agnostic)
├── Iroh transport (native only — p2p sync, NAT traversal)
├── DHT node discovery (native only — find peers without a server)
├── Class extenders + built-in plugins (chatroom, invite, etc.)
├── WASM plugin runtime (native only, wasmtime, optional)
└── Search (Tantivy on native, simple substring on WASM)

atomic-server (thin HTTP shell, native only)
├── HTTP endpoints (Actix)
├── WebSocket transport → lib sync
├── ACME/TLS, static files
└── Server config

atomic-wasm (thin shell, WASM only)
├── wasm-bindgen exports for Db
└── Worker message bridge

desktop / mobile (Tauri, native)
├── No HTTP server
└── Tauri commands → lib Db directly
```

### The key change: ReDB everywhere

The blocker today is that `Db` uses Sled, which doesn't compile to WASM. ReDB does — we already use it in the WASM client. If we switch the server from Sled to ReDB:

- **One `Db` implementation** works on server, desktop, mobile, and WASM
- **The `wasm/` crate's ClientDb becomes unnecessary** — it's just `atomic-lib::Db` with wasm-bindgen
- **Desktop/mobile don't need the HTTP server** — they use `Db` directly + Iroh for sync

### Sync, Iroh, and DHT move to the lib

Today the sync protocol lives in `server/src/handlers/web_sockets.rs`, Iroh in `server/src/iroh_transport.rs`, and DHT in server config. All three are peer capabilities — any device with data should be able to sync, connect via Iroh, and discover peers via DHT. They belong in `atomic-lib`, gated by feature flags.

```rust
// In atomic-lib — transport-agnostic sync engine
pub struct SyncEngine {
    db: Db,
}

impl SyncEngine {
    /// Process an incoming v2 binary frame, return response frames.
    pub async fn handle_frame(&self, frame: &[u8]) -> Vec<Vec<u8>> { ... }

    /// Compute drive sync state for outgoing SYNC request.
    pub fn compute_drive_state(&self, drive: &str) -> DriveSyncState { ... }

    /// Import sync deltas from a peer.
    pub async fn import_deltas(&self, deltas: &[SyncDelta]) -> Result<()> { ... }
}

// In atomic-lib — Iroh peer node (feature = "iroh", native only)
pub struct PeerNode {
    db: Db,
    sync_engine: SyncEngine,
    endpoint: iroh::Endpoint,
}

impl PeerNode {
    /// Start listening for incoming peer connections.
    pub async fn start(&self) -> Result<NodeId> { ... }

    /// Connect to another peer and sync a drive.
    pub async fn sync_with(&self, peer: NodeId, drive: &str) -> Result<()> { ... }
}
```

Every target uses the same `SyncEngine`. The transport is just plumbing:

```rust
// atomic-server: WebSocket → SyncEngine
fn handle_ws_binary(frame: &[u8], ctx: &mut WsContext) {
    for r in self.sync_engine.handle_frame(frame).await {
        ctx.binary(r);
    }
}

// atomic-lib PeerNode: Iroh QUIC stream → SyncEngine (same code!)
async fn handle_iroh_stream(stream: BiStream, engine: &SyncEngine) {
    loop {
        let frame = read_frame(&mut stream).await?;
        for r in engine.handle_frame(&frame).await {
            write_frame(&mut stream, &r).await?;
        }
    }
}
```

DHT discovery is also a lib feature — any native `PeerNode` can announce itself and find other peers. The server doesn't need special DHT code; it just uses the lib's `PeerNode` like any other device.

### The `Storelike` trait, cleaned up

```rust
trait Storelike {
    async fn get_resource(&self, subject: &Subject) -> AtomicResult<Resource>;
    async fn add_resource(&self, resource: &Resource) -> AtomicResult<()>;
    async fn remove_resource(&self, subject: &Subject) -> AtomicResult<()>;
    async fn query(&self, q: &Query) -> AtomicResult<QueryResult>;
    async fn apply_commit(&self, commit: Commit, opts: &CommitOpts) -> AtomicResult<CommitResponse>;
    fn get_base_domain(&self) -> Option<String>;
    fn get_default_agent(&self) -> AtomicResult<Agent>;
}
```

Remove from the trait: `add_atoms`, `get_path`, `search` (implementation-specific), `fetch_resource` (network, not storage), `export`/`import` (bulk ops).

### Migration path

1. **Switch server from Sled to ReDB** — ReDB is faster for reads, supports transactions, and compiles to WASM. This is the enabling change.
2. **Move WASM ClientDb logic into `atomic-lib` Db** — the ClientDb becomes `Db` with ReDB backend. Validation, auth, queries all come for free.
3. **Move sync protocol into `atomic-lib`** — extract `SyncEngine` from `web_sockets.rs`. Server and desktop both use it.
4. **Desktop app drops HTTP server** — uses `Db` directly + Iroh via `SyncEngine`. Tauri commands talk to `Db`, not HTTP.
5. **Clean up `Storelike`** — remove network/HTTP methods, keep it pure storage.

### What this enables

- **Desktop app is 10x smaller** — no Actix, no HTTP server, no Sled
- **Mobile app gets full validation and auth** — same code as server
- **Browser WASM DB gets full queries** — same indexing as server
- **One test suite** — tests run on native and WASM, same behavior guaranteed
- **Sync works everywhere** — `SyncEngine` doesn't care if bytes come from WebSocket, Iroh, or a pipe
- **Any language can use it** — via FFI, any app (Flutter, Swift, Kotlin, C++) gets the full Atomic Data stack

## Developer SDK: atomic-lib as a library

### The vision

`atomic-lib` is not just an internal implementation detail — it's the **developer SDK** for building apps with Atomic Data. Any app, in any language, should be able to:

```
1. Create a local database
2. Create an agent (identity)
3. Create a drive
4. Create resources, edit them, query them
5. Sync with other peers — no server setup required
```

The Flutter/Dart canvas app (`atomiccanvas_flutter`) is the reference consumer. It should validate that the API is intuitive and complete. If a Flutter developer can't do something simple in 3 lines of code, the API needs work.

### FFI bindings (Flutter, Swift, Kotlin, C++)

`atomic-lib` compiles to a native shared library (`.so` / `.dylib` / `.dll`). Language bindings expose it via FFI:

```
atomic-lib (Rust)
├── atomic-ffi (C ABI via cbindgen / flutter_rust_bridge)
│   ├── Flutter/Dart — dart:ffi
│   ├── Swift — direct C interop
│   ├── Kotlin/JNI — Android NDK
│   └── C/C++ — direct linking
└── atomic-wasm (wasm-bindgen)
    └── Browser JS/TS
```

### The API surface

The SDK should feel like a local database with superpowers. No HTTP, no URLs, no server config — just data:

```dart
// Flutter example — the API we're designing for

// 1. Open a local database
final db = AtomicDb.open('~/my-app/data');

// 2. Create an identity
final agent = db.createAgent(name: 'Alice');

// 3. Create a drive (a container for resources)
final drive = db.createDrive(name: 'My Canvas', agent: agent);

// 4. Create and edit resources
final doc = drive.createResource(
  class: 'https://atomicdata.dev/classes/DocumentV2',
  props: {'name': 'Sketch 1'},
);
doc.set('description', 'A quick sketch');
await doc.save();

// 5. Query
final sketches = db.query(
  parent: drive.subject,
  class: 'DocumentV2',
  sortBy: 'createdAt',
);

// 6. Sync with a peer — that's it, no server setup
final peer = db.startPeer(); // starts Iroh
print('Share this ID: ${peer.nodeId}');
await peer.syncWith(otherNodeId, drive: drive.subject);

// 7. Sync with a server (if you have one)
await db.syncWithServer('https://my-server.com', drive: drive.subject);
```

### What the Flutter app validates

The `atomiccanvas_flutter` app is the proving ground. Every friction point in that app reveals an API gap:

- **Agent creation** — should be one call, not a multi-step process
- **Drive creation** — should auto-configure permissions for the creating agent
- **Resource CRUD** — get/set/save should be obvious, typed when possible
- **Real-time sync** — start Iroh, share a NodeID, done
- **Offline-first** — everything works without a server; sync is opt-in
- **Conflict resolution** — Loro handles it; the developer never sees merge conflicts
- **Schema validation** — create a Property, create a Class, resources validate automatically

### Implementation: `atomic-ffi` crate

A new crate in the workspace:

```
atomic-ffi/
├── Cargo.toml          # depends on atomic-lib with features = ["db-redb", "iroh"]
├── src/
│   └── lib.rs          # C-ABI functions wrapping atomic-lib
└── bridge/
    └── flutter/        # flutter_rust_bridge generated bindings
```

The FFI layer is thin — it wraps `Db`, `SyncEngine`, `PeerNode` with C-compatible types and handles memory management. `flutter_rust_bridge` auto-generates the Dart bindings from the Rust types.

### Why not WASM for Flutter?

Flutter can use WASM, but native FFI is better:

- **Performance** — no WASM interpreter overhead, direct memory access
- **Iroh works** — QUIC/UDP sockets are available natively, not in WASM
- **File I/O** — ReDB can use the real filesystem, not a virtual one
- **Threading** — real OS threads for sync, not WASM single-threaded

WASM is for the browser. Everything else uses native FFI.

## Sync Protocol

### The bootstrap problem

A local-first client creates resources entirely offline: agent, drive, child resources. When it later connects to a server (or mesh peer), the remote side knows nothing — no agent, no drive, no permissions context. The current `syncDirtyResources()` implementation iterates dirty resources in arbitrary order and posts commits, which the server rejects because it can't verify write permissions on resources it has never seen.

This is a protocol gap. The system needs a defined handshake for introducing a new drive to a remote peer.

### Genesis commits

A genesis commit establishes that a resource exists and who created it. It should be **minimal** — just enough to prove authorship:

```
genesis = sign({ signer, timestamp, isGenesis: true })
         → signature
         → subject = did:ad:{signature}
```

The genesis commit does NOT contain the Loro snapshot. This is intentional:

- The genesis signature (and thus the DID) must never change. If it contained a snapshot, the DID would be tied to the initial content.
- The genesis is stored forever for identity verification. Keeping it small (< 100 bytes) is important.
- The actual resource content arrives as a separate signed commit carrying the Loro snapshot.

For **agents** (`did:ad:agent:{pubkey}`), genesis is implicit — the public key IS the identity. No genesis commit needed. The server auto-creates agent resources when it first sees an unknown agent DID as a commit signer.

For **drives and other resources**, genesis establishes ownership. The chain is:

1. **Genesis** (tiny, permanent): proves who created this resource and when
2. **Content commits** (signed, compactable): each carries a Loro delta, proves the signer approved that change
3. **Current snapshot** (the full Loro state): can be re-signed by the owner periodically

The commit history between genesis and now is **disposable**. For sync, you only need the genesis (for identity) and the current Loro snapshot (for state). This aligns with the tiered history model — the frozen tier discards individual operations and keeps only the aggregate state.

### Drive-level sync

Sync operates at the **drive level**. A drive is the unit of sharing and permissions. If you want to share a subset of resources, put them in their own drive. Sub-drive sync adds complexity (partial trees, permission boundaries mid-hierarchy) for a use case that separate drives already solve.

Each peer (client, server, mesh node) maintains a **version vector list** for every drive it knows about. The version vector comes from Loro — `doc.oplogVersion()` returns a `{ peerId: counter }` map for each resource.

### The sync handshake

**Step 1: Drive hash comparison (1 round trip, 32 bytes)**

Each side computes a drive-level hash: `hash(sorted(subject1 + vv1 || subject2 + vv2 || ...))` where `vv` is the serialized version vector. This single hash summarizes the entire drive state.

```
Client → Server: SYNC { drive: "did:ad:...", drive_hash: "a3f8..." }
Server → Client: SYNC_OK   // hashes match, everything in sync
```

If hashes match, sync is done. This is the **fast path** — 32 bytes, one round trip. Covers 99% of "nothing changed" checks.

**Step 2: Version vector exchange (1 round trip, ~2-3 KB for 200 resources)**

If hashes differ, both sides exchange the full version vector list. Peer IDs are factored out to avoid repetition:

```json
{
  "drive": "did:ad:drive123",
  "peers": ["4a2F", "9bC1"],
  "resources": {
    "did:ad:drive123":  [12, 0],
    "did:ad:readme":    [91, 55],
    "did:ad:table1":    [47, 12],
    "did:ad:table2":    [3,  0],
    "did:ad:chat":      [20, 84],
    "did:ad:task1":     [5,  0],
    "did:ad:task2":     [8,  3],
    "did:ad:design":    [14, 22]
  }
}
```

The `peers` array maps indices to Loro peer IDs (short opaque identifiers, not full DIDs). Each resource's array is `[counter_for_peer_0, counter_for_peer_1]`. Zero means that peer never touched that resource.

The receiving side compares element by element:

```
              Client          Server          Action
readme:       [91, 55]   vs   [91, 58]    →  server ahead on peer 9bC1, pull
table1:       [47, 12]   vs   [47, 12]    →  identical, skip
task2:        [8,  3]    vs   [5,  3]     →  client ahead on peer 4a2F, push
task3:        [2,  0]    vs   (missing)    →  new resource, push genesis + snapshot
```

**Step 3: Delta exchange (1 round trip)**

For each differing resource, both sides use Loro's built-in delta export:

```
doc.export({ mode: 'update', from: otherSideVersionVector })
```

Loro computes exactly the missing operations — nothing custom needed. New resources (unknown to the other side) send the genesis commit plus a full Loro snapshot.

```
Client → Server: SYNC_PUSH {
  genesis: [{ subject: "did:ad:task3", signer: "did:ad:agent:alice", timestamp: 1744200000, signature: "..." }],
  updates: [
    { subject: "did:ad:task2", delta: <loro_delta_bytes> },
    { subject: "did:ad:task3", snapshot: <loro_snapshot_bytes> }
  ]
}
Server → Client: SYNC_PUSH {
  updates: [
    { subject: "did:ad:readme", delta: <loro_delta_bytes> },
    { subject: "did:ad:design", delta: <loro_delta_bytes> }
  ]
}
```

### New drive bootstrap

When a client introduces a completely new drive to a server:

1. Server has never seen the drive → drive hash comparison fails → version vector exchange shows server has nothing
2. Client sends: drive genesis + drive snapshot + all child geneses + all child snapshots
3. Server verifies the agent (public key embedded in the DID), verifies genesis signatures, imports all snapshots
4. Server now has the full drive state

This is the same protocol — no special case. The version vector exchange reveals "server has nothing," and the delta exchange degrades to "send everything."

### Authorization during sync

The server validates each incoming resource:

- **Genesis commits**: accepted if the signature is valid. No prior permissions check needed — you're creating something new.
- **Content commits / deltas**: accepted if the signer has `write` permission on the resource. The server checks the resource's `write` array (which was established by the genesis or a prior commit).
- **Agent resources**: auto-created from DID. The public key is the identity — no trust bootstrapping needed.

For **mesh peers**, the same checks apply on the receiving side. A peer verifies signatures and checks write permissions locally before importing.

### Scaling: merkle tree for large drives

For drives with tens of thousands of resources, the version vector list becomes large. In that case, a merkle tree over `(subject, version_vector_hash)` pairs enables logarithmic comparison:

- Leaf buckets contain ~50 resources each
- Internal nodes are `hash(left_child || right_child)`
- Peers walk the tree top-down, comparing hashes at each level
- Only descend into subtrees that differ

This adds round trips (O(log n)) but avoids sending the full list. For most drives (< 5000 resources), the flat version vector list is small enough (~50 KB) that the merkle tree isn't needed.

### What Loro handles vs what we build

| Layer | Responsibility | Implementation |
|-------|---------------|----------------|
| Resource sync | Given two versions of the same resource, compute and apply the minimal delta | **Loro** — `doc.export()` / `doc.import()` with version vectors |
| Drive sync | Given two peers, figure out which resources in a drive differ | **Ours** — drive hash + version vector list exchange |
| Authorization | Verify that the signer of a commit has write access | **Server/peer** — check `write` array, verify signature |
| Identity | Establish who an agent is | **DID** — public key embedded in `did:ad:agent:{pubkey}` |
| Transport | Move bytes between peers | **Backend** — WebSocket, HTTP, Reticulum, WebRTC |

### Current implementation status

- **`syncDirtyResources()`** (store.ts): implemented with dependency-ordered sync via `sortDirtyForSync()` — agents first, then drives, then children sorted by parent depth. Pushes pending commits to the server in correct order on reconnect.
- **VV-based sync** (websockets.ts → server): implemented as SYNC_VV → SYNC_DIFF → SYNC_DELTAS. Client sends per-resource version vectors for the current drive. Server compares, returns a diff (resources to push/pull) and Loro deltas for resources it's ahead on. Client responds with Loro deltas for resources it's ahead on.
- **Genesis commits**: supported. Agent DIDs use the public key as identity (no genesis commit needed for the agent itself, but the server now correctly handles agent genesis commits that set initial properties). Drive and resource genesis commits work.
- **Agent persistence**: fixed — the server's "just-in-time" agent fallback in `get_resource()` no longer interferes with genesis commit processing. Agent properties (personalDrive, sharedWithMe, drives, name) now survive server restart.
- **Drive hash comparison**: implemented. Server computes SHA-256 of sorted VV entries and compares before falling back to full VV exchange.
- **Iroh P2P transport**: implemented (`lib/src/sync/peer.rs`). Persistent QUIC connections via Iroh relay. QR code pairing (`did:ad:node:<nodeId>`). Auto-reconnect on startup. Live push of changes via persistent bi-directional streams.
- **Live sync**: implemented but **unauthenticated**. Pushes raw Loro snapshots, not signed commits. Works for single-agent multi-device but not for shared drives or relay scenarios.
- **Merkle tree**: not implemented.

### Live sync architecture (current)

The Flutter canvas app implements real-time P2P sync via Iroh QUIC:

1. **Initial sync**: VV-based handshake (AUTH → SYNC → SYNC_DIFF → SYNC_PUSH) establishes baseline state
2. **Live mode**: the same bi-directional QUIC stream transitions to a push-based channel after initial sync
3. **Push loop**: watches `resource_changed` broadcast on the local DB, sends UPDATE frames (raw Loro snapshots) to all connected peers
4. **Receive loop**: imports incoming UPDATE frames via Loro CRDT merge, materializes propvals, updates indexes
5. **Auto-connect**: on startup, the device with the smaller NodeID initiates connection to known peers; retries every 5s on failure, checks every 30s for disconnects
6. **Reactive UI**: `watchResource` and `watchChildren` bridge commands block in Rust on a `tokio::sync::broadcast` channel until matching changes arrive — no polling

**Known limitations:**

- No authentication on live UPDATE frames — anyone on the QUIC connection can push arbitrary state
- Deletions don't sync (no destroy commit propagation)
- No commit history transfer — peers get state but not the audit trail
- Snapshot-based push (full Loro snapshot per change) is bandwidth-inefficient for large resources

### Authenticated live sync (design — not yet implemented)

The current live sync sends raw Loro snapshots. The proper design uses **signed commits** for live push and **signed snapshot attestations** for catch-up:

**Two message types for sync:**

- **COMMIT** (live, real-time): a signed delta. Created locally when a change happens. Streamed to connected peers. The receiver runs `apply_commit` which validates the signature and checks write permissions. Small (just the delta), fast (no round trip). Multiple concurrent commits from different peers merge via Loro CRDT — the commit DAG is a graph, not a chain.

- **SIGNED UPDATE** (catch-up, reconnection): a signed snapshot attestation. When peers reconnect after a gap, they exchange full Loro snapshots signed by someone with write access. The receiver verifies the signature and imports the snapshot. No need to replay intermediate commits.

**Relay-safe:** If device B receives a commit from device A and forwards it to device C, C can verify A's signature directly. B can't tamper with the commit without invalidating the signature. This enables mesh-style relay without trusting intermediaries.

**History as a separate concern:**

Commits serve dual purpose: transport (sync) and audit (history). These can be separated:

- **State** (always synced): the Loro snapshot — the current merged state. Every peer has this.
- **Recent commits** (live): streamed between connected peers. Useful for undo and real-time collaboration. Kept in memory or short-term storage.
- **Full commit history** (on-demand): the complete signed audit trail from genesis to now. Stored by nodes that care about accountability. Fetchable via `GET_HISTORY` request.
- **Loro internal history** (always available): the Loro oplog inside each snapshot contains the full operational history — who changed what, when. This is not the same as signed commits (no signature verification possible) but sufficient for undo/time-travel.

Nodes choose their own retention policy:
- Canvas app (personal): transit-only — import the Loro delta, discard the commit envelope
- Business app: keep every commit — full cryptographic audit trail
- Relay node: forward commits, don't store them

**Open design question:** Should `previous_commit` still be required? For P2P sync, it creates ordering problems (which "previous" commit when two peers edited concurrently?). Loro's version vectors already capture causality. The commit could just be `{ subject, signer, loro_update, signature, timestamp }` — no chain, no ordering. The Loro doc handles merge semantics.

## Iroh: Zero-Config Peer-to-Peer

### The problem with self-hosting

Running an Atomic Server today requires a public IP, a domain name, TLS certificates, DNS configuration, and port forwarding. This is a significant barrier for self-hosters. The entire point of local-first is that your data lives on your devices — requiring server infrastructure to sync between them defeats the purpose.

### What Iroh provides

[Iroh](https://iroh.computer) (`iroh-net`) is a Rust library that provides:

- **QUIC connections between any two nodes**, regardless of NAT/firewall. It uses relay servers for initial handshake, then upgrades to direct connections via hole punching.
- **NodeID** — each node gets a public key identity. No DNS, no IP addresses, no ports. You connect to a NodeID and Iroh figures out the routing.
- **Works everywhere** — the same code runs on servers, desktops, phones, and in WASM (with limitations).

### How it fits

The v2 binary protocol was designed to be transport-agnostic. Every message is a `[tag: u8] [payload...]` byte frame. These frames currently travel over WebSocket. With Iroh, they travel over QUIC streams instead — same encoder/decoder, different transport.

```
Browser client  ──WebSocket──►  Atomic Server
Desktop client  ──Iroh QUIC──►  Atomic Server
Phone app       ──Iroh QUIC──►  Atomic Server
Atomic Server   ──Iroh QUIC──►  Atomic Server  (federation)
```

### Server-side integration

The server starts an Iroh `Endpoint` alongside the HTTP listener:

```rust
// Simplified
let endpoint = iroh::Endpoint::builder()
    .discovery_n0()       // Use n0's relay network for NAT traversal
    .bind().await?;

let node_id = endpoint.node_id();
println!("Iroh NodeID: {node_id}");

// Accept incoming connections
while let Some(conn) = endpoint.accept().await {
    let conn = conn.await?;
    // Open a bidirectional QUIC stream
    let (send, recv) = conn.accept_bi().await?;
    // Reuse the same binary frame handler as WebSocket
    handle_v2_stream(send, recv, store.clone()).await;
}
```

The `handle_v2_stream` function reads binary frames from the QUIC stream and dispatches them using the same `ws_v2::decode_*` / `ws_v2::encode_*` functions. No new protocol — just a new transport.

### Client-side integration

A native/desktop Atomic Data client connects via Iroh:

```rust
let endpoint = iroh::Endpoint::builder().bind().await?;
let node_id: NodeId = "...".parse()?;
let conn = endpoint.connect(node_id, ATOMIC_ALPN).await?;
let (send, recv) = conn.open_bi().await?;
// Send binary v2 frames
send.write_all(&ws_v2::encode_get(1, "did:ad:my-drive")).await?;
// Read binary v2 frames
let response = read_frame(&mut recv).await?;
```

Browser clients can't use Iroh directly (no raw QUIC in browsers). They continue using WebSocket. But the server can bridge: a browser connects to a server via WebSocket, and that server syncs with other servers/peers via Iroh.

### The NodeID as server address

Today, users add a server by URL: `https://my-server.com`. With Iroh, they add by NodeID: `iroh:z6Mk...`. The sync page's "Add server" field accepts both formats.

The NodeID is stable — it's derived from the server's private key. Moving the server to a different machine, IP, or network doesn't change the NodeID. No DNS updates, no certificate renewals.

### Federation via Iroh

Two Atomic Servers can sync drives with each other over Iroh. This is the same VV-based sync protocol used between client and server, but server-to-server:

1. Server A connects to Server B via Iroh NodeID
2. They exchange drive version vectors
3. They exchange Loro deltas for differing resources
4. Both servers now have the same state

This enables:
- **Multi-server redundancy** — your data exists on multiple servers
- **Geographic distribution** — a server in each region, syncing via Iroh
- **Offline servers** — a home server syncs when it comes online, like a phone

### Desktop app as a peer

A desktop Atomic Data app is just another Iroh node. It can:
- Sync directly with other desktop apps on the same LAN (Iroh discovers local peers)
- Sync with a server for backup and sharing
- Work fully offline and sync later

No server required for two devices on the same network to sync.

### Implementation plan

1. **Add `iroh-net` dependency** to `atomic-server`
2. **Start an Iroh endpoint** alongside the HTTP server in `main.rs`
3. **Accept connections** on the Iroh endpoint, create a bidirectional stream per client
4. **Reuse `ws_v2` encode/decode** — the stream handler reads frames and dispatches the same way the WebSocket handler does
5. **Display NodeID** on the sync page and in server logs
6. **Accept `iroh:` addresses** in the client's "Add server" field
7. **Test**: two servers syncing a drive over Iroh without any port forwarding

## Open Questions

- **Local push notifications**: Resolved — the `resource_changed` broadcast channel notifies both local UI and the sync push loop. Local writes and remote writes trigger the same reactive path.
- **Schema bootstrap**: The WASM DB needs property definitions to parse resources and build indexes. Currently seeded from the in-memory Store. With Loro-primary, the schema (properties, classes) would also be Loro docs. How do we bootstrap — ship a built-in vocabulary snapshot?
- **Mesh peer discovery**: Partially resolved. QR code pairing (`did:ad:node:<nodeId>`) handles manual discovery. Pkarr relay (agent → NodeID mapping) exists but has limitations for shared drives (only maps agent public key, not drive DID). For shared drives, a server or relay is needed as a rendezvous point.
- **Freshness**: Show local data immediately, update when server/peer responds. But what if local data is weeks old and the server has a much newer version? Should there be a staleness indicator?
- **Loro version compatibility**: What happens when peers run different Loro versions? Snapshots and deltas need to be compatible across versions. This may require versioning the wire format.
- **Large resources**: Loro snapshots grow with edit history. For long-lived documents, snapshots could be megabytes. The current live sync sends full snapshots on every change — this is wasteful. Should switch to deltas for live push, snapshots for catch-up only.
- **Query indexing from Loro**: Partially resolved. `add_resource_opts` updates the query index (including watched queries) when synced resources are imported. `JsonArray` type maps to native LoroList for CRDT-friendly list operations.
- **Deletion sync**: Not implemented. Requires a signed destroy commit to be propagated through the sync protocol. The current live sync only handles updates, not deletions.
- **`previous_commit` in P2P**: The linear commit chain (`previous_commit`) doesn't work well with concurrent edits from multiple peers. Should this become optional? Loro's version vectors already capture causality. Commits could be standalone signed attestations without requiring chain ordering.
- **Snapshot vs delta efficiency**: The live sync currently sends full Loro snapshots (~8-20KB per change). For real-time drawing (many strokes per second), this is too much bandwidth. Should switch to Loro deltas for live push (typically < 1KB) and full snapshots only for catch-up sync.
- **NDK 27 llvm-strip corruption**: The NDK 27 `llvm-strip` tool corrupts large debug `.so` files. Currently worked around by disabling the `stripDebugDebugSymbols` Gradle task. Needs a proper fix (upgrade NDK, use Rust-level stripping, or file a bug).

# Temporal Data Architecture Implementation

## The Two-Tree Persistence Model
To balance the requirements of high-speed queries and collaborative CRDT power, the database maintains two distinct representations of every resource:

1. **`Tree::Resources` (Materialized View / Read Cache)**
   - **Data:** Flat Property-Value pairs (no history).
   - **Format:** MessagePack.
   - **Path:** Standard reads, search indexing, TPF queries.
   - **Performance:** Instant lookup; no Loro VM initialization required.

2. **`Tree::LoroSnapshots` (Canonical Store / History)**
   - **Data:** Full Loro binary snapshot (Operation DAG).
   - **Format:** Loro Binary.
   - **Path:** Background sync (Iroh/WebSockets), History Scrubbing, Undo/Redo.
   - **Performance:** Loaded lazily into memory only when a temporal operation is requested.

## Temporal Resource API (Rust/Dart)
The SDK exposes a "temporal-ready" Resource object.

- **Lazy Loading ("Warming"):** A Resource instance initializes its internal Loro document from bytes only when history or editing is needed.
- **In-Memory Scrubbing:** Jumps between historical versions are pure CPU pointer moves in the Loro DAG, requiring zero database I/O once the doc is warmed.
- **Detached Views:** `resource.view_at(version)` returns a new, read-only Resource instance representing the state at that moment.

## Synchronization Protocol
Sync is primarily Loro-native. 
1. Peers exchange **Version Vectors (VV)**.
2. The sender calculates the binary delta from its `LoroSnapshots` tree.
3. The receiver imports the delta, merges it locally, and then **re-materializes** the result into its `Resources` tree to update the UI and indexes.
