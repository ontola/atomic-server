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
- Remove `propvals` Map from Resource
- `resource.get()` reads from Loro map
- `resource.set()` writes to Loro map only
- Every resource gets a Loro doc on hydration (not lazy)
- Use native `LoroList` for arrays
- Remove `setUnsafe()`, `execSetCommit`, `execRemoveCommit`, `execPushCommit`
- JSON-AD from server/WASM DB is imported into a Loro doc on arrival

**Status**
- In progress.
- `Resource` no longer uses `propvals` as the primary browser-side read path. It now reads from a derived cache object plus a small aux map for binary values.
- Hydration paths (`parse.ts`, `store.ts`) now initialize the Loro doc when available, so fetched resources are no longer "Loro-less until first edit".
- The browser runtime no longer applies legacy `set` / `push` / `remove` commit payloads when ingesting commits. The hot path is now `loroUpdate` plus destroy.
- `setUnsafe()` still exists as a migration helper for binary values and some compatibility paths, so the client is not yet fully "Loro only".
- `propvals` is still the canonical Rust-side resource store. The full "drop propvals" milestone has only been reached partially in the browser client.

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

### Phase 5: Mesh transport
- Add a Reticulum/WebRTC Backend implementation
- Same protocol, same subscription model
- Peer discovery and routing are transport-specific details hidden behind the Backend interface
- Loro deltas as the wire format — compact, deduplicatable, order-independent

**Status**
- Not started.

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

`loroSetProperty()` (line 331) serializes arrays as JSON strings:
```typescript
// Arrays and objects: serialize to JSON string
map.set(prop, JSON.stringify(value));
```

This means `isA: ["https://atomicdata.dev/classes/Folder"]` becomes the string `"[\"https://atomicdata.dev/classes/Folder\"]"` in the Loro map. Reading it back requires JSON.parse. This prevents per-element CRDT merging and makes the Loro state subtly different from propvals.

**Status**
- Still true.
- This is the next major structural cleanup. We have not yet switched browser or Rust Loro storage to native list / map containers for Atomic arrays and nested resources.

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
| `lib/src/loro.rs` | Still needed. Handle `LoroList` / `LoroMap` ↔ Atomic arrays / nested values natively. |
| `lib/src/resources.rs` | Partially done. Serialization now includes the freshest in-memory `loroUpdate` snapshot, and Loro state can now be rebuilt from existing materialized props when no stored snapshot exists. Rust still keeps `propvals` as the canonical field store. |
| `server/src/handlers/commit.rs` | Already Loro-primary for writes, no structural change needed. |
| `server/src/handlers/get_resource.rs` | No direct handler change was needed, but the read path now benefits from fresher `Resource` serialization. |
| `browser/data-browser/src/helpers/initClientDb.ts` | Still needs cleanup so seeding and local persistence align with a Loro-primary model rather than propval-first JSON blobs. |

## Unifying the Rust stores

### The problem: three different store APIs

The Rust side has three store implementations that should be one:

**`Store` (lib/src/store.rs)** — in-memory HashMap
- Implements `Storelike`
- No persistence, no indexing
- Used for tests and simple use cases
- ~300 lines

**`Db` (lib/src/db.rs)** — KV-backed (sled/redb)
- Implements `Storelike`
- Full indexing (prop-val-sub, val-prop-sub, query members)
- Endpoints, class extenders, commit handling
- Drive mappings, DID resolution
- ~1600 lines

**`ClientDb` (wasm/src/lib.rs)** — JS-facing wrapper around `Db`
- Does NOT implement `Storelike`
- Re-invents its own API: `getResource`, `putResource`, `query`, `putLoroSnapshot`
- The JS `ClientDbWorker` class wraps this with ANOTHER message-passing layer
- ~250 lines

The JS browser `Store` (browser/lib/src/store.ts) then has custom code for each backend:
- `fetchResourceFromServer()` — HTTP to the Rust server's `Storelike`
- `fetchResourceFromClientDb()` — worker message to `ClientDb`
- `queryLocalDb()` — worker message to `ClientDb.query()`
- `fetchResourceWithLocalFallback()` — tries WASM DB, then server

Each path has its own serialization, error handling, and response parsing.

### The goal: one interface everywhere

```
Storelike (Rust trait)
├── Db (sled/redb, server-side)
├── Db (redb/OPFS, client-side WASM)     ← same code!
└── Store (in-memory, tests)

JS Store ←→ Storelike (via worker messages or HTTP)
```

The WASM `ClientDb` should expose `Storelike` methods directly, not a custom API. The worker message types should mirror `Storelike`:

| Storelike method | Worker message | HTTP equivalent |
|-----------------|----------------|-----------------|
| `get_resource(subject)` | `GET_RESOURCE subject` | `GET /resource?subject=X` |
| `query(q)` | `QUERY property value ...` | `GET /query?property=X&value=Y` |
| `add_resource(resource)` | `PUT_RESOURCE json-ad` | (via commit) |
| `apply_commit(commit)` | `APPLY_COMMIT json-ad` | `POST /commit` |
| `remove_resource(subject)` | `REMOVE_RESOURCE subject` | (via commit with destroy) |

The JS `Store` doesn't need separate code paths for "talk to WASM DB" vs "talk to server". It talks to a `Backend` that implements the same interface, regardless of whether it's backed by a worker or HTTP.

### What changes

**wasm/src/lib.rs**: Instead of custom methods, expose `Storelike` methods directly. The `ClientDb` wrapper becomes almost trivial — it's just `Db` with wasm-bindgen annotations. The `putLoroSnapshot`/`getLoroSnapshot` can stay as additional methods (they're storage-specific, not part of the query/resource interface).

**browser/lib/src/client-db.worker.ts + client-db.ts**: The worker message types align with `Storelike`. No more custom `putResource`/`getResource` that differ from the server API.

**browser/lib/src/store.ts**: Replace `fetchResourceFromServer`, `fetchResourceFromClientDb`, `fetchResourceWithLocalFallback`, `queryLocalDb` with a single `backend.getResource()` / `backend.query()` that tries local first, then remote.

### The `Storelike` trait itself

The current `Storelike` trait (lib/src/storelike.rs) has some baggage:
- `add_atoms()` — atom-level API, could be removed in favor of resource-level
- `get_path()` — path traversal, more of a utility than a store operation
- `search()` — full-text search, implementation-specific
- `export()` / `import()` — bulk operations
- `fetch_resource()` — HTTP fetch, shouldn't be on the store trait

A cleaned-up `Storelike` for the unified model:

```rust
trait Storelike {
    // Core CRUD
    async fn get_resource(&self, subject: &Subject) -> AtomicResult<Resource>;
    async fn add_resource(&self, resource: &Resource) -> AtomicResult<()>;
    async fn remove_resource(&self, subject: &Subject) -> AtomicResult<()>;
    
    // Queries
    async fn query(&self, q: &Query) -> AtomicResult<QueryResult>;
    
    // Commits (the write path)
    async fn apply_commit(&self, commit: Commit, opts: &CommitOpts) -> AtomicResult<()>;
    
    // Subscriptions (for live queries and real-time updates)
    fn subscribe(&self, subject: &Subject) -> Stream<Resource>;
    fn subscribe_query(&self, q: &Query) -> Stream<QueryResult>;
    
    // Metadata
    fn get_base_domain(&self) -> Option<String>;
    fn get_default_agent(&self) -> AtomicResult<Agent>;
}
```

The HTTP-specific stuff (`fetch_resource`, `post_resource`) moves to a `RemoteBackend` implementation. The WASM-specific stuff (`putLoroSnapshot`) stays on `Db` directly. The trait is clean and backend-agnostic.

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

- **`syncDirtyResources()`** (store.ts): exists but has no ordering, no dependency tracking, no version vector comparison. Just retries dirty resources on reconnect.
- **`SYNC_DRIVE`** (websockets.ts → server): exists but uses timestamp-based delta, not version vectors. Sends full JSON-AD resources, not Loro deltas.
- **Genesis commits**: supported in the commit handler. Agent auto-creation works. Drive genesis works if the agent exists.
- **Drive hash / version vector exchange**: not implemented.
- **Merkle tree**: not implemented.

## Open Questions

- **Local push notifications**: Should the WASM DB proactively push updates (like WebSocket COMMIT messages) when a local write happens? Or should it be pull-only? Push would make the subscription model symmetric — local writes and remote writes notify through the same channel.
- **Schema bootstrap**: The WASM DB needs property definitions to parse resources and build indexes. Currently seeded from the in-memory Store. With Loro-primary, the schema (properties, classes) would also be Loro docs. How do we bootstrap — ship a built-in vocabulary snapshot?
- **Mesh peer discovery**: How do peers find each other and negotiate which resources to sync? This is transport-specific (Reticulum has its own addressing) but affects what the Backend interface needs to expose.
- **Freshness**: Show local data immediately, update when server/peer responds. But what if local data is weeks old and the server has a much newer version? Should there be a staleness indicator?
- **Loro version compatibility**: What happens when peers run different Loro versions? Snapshots and deltas need to be compatible across versions. This may require versioning the wire format.
- **Large resources**: Loro snapshots grow with edit history. For long-lived documents, snapshots could be megabytes. Should we use shallow snapshots (trim old history) and archive the rest? How does this interact with mesh peers that might need the full history?
- **Query indexing from Loro**: Currently the JSON-AD index is built by the Rust parser which understands property datatypes. If Loro becomes primary, the index must be derived from Loro doc state. The Loro map stores values as primitives/strings — is that sufficient for type-aware indexing?
