# Atomic Lib Runtime: HTTP-Optional Local Node

## Status

Proposal. This document describes the target architecture for making
`atomic_lib` able to run a complete Atomic node by itself. HTTP remains a
supported adapter for hosted servers and interoperability, but local app
runtime behavior must not depend on HTTP endpoints or a loopback server.

Related design docs:

- `docs/src/websockets.md` describes the binary resource protocol. In this
  architecture those frames become the Atomic peer protocol, not just a
  WebSocket protocol.
- `planning/unified-data-layer.md` describes the browser-facing data layer.
  In this architecture that data layer talks to an `atomic_lib` node surface,
  either through WASM/OPFS, native bindings, or a remote transport.
- `planning/s3-blob-storage.md` describes pluggable blob storage. In this
  architecture the blob backend belongs under the node runtime, not under an
  HTTP handler.

## Problem

Atomic already has most of the local-first pieces, but the ownership boundary
is blurry.

`atomic_lib` owns the durable graph store, Loro materialization, commit
validation/application, redb/OPFS storage, blobs, query indexes, and Iroh sync
protocol pieces. `atomic-server` still owns too much product behavior through
HTTP handlers: `/commit`, `/query`, `/search`, `/upload`, `/download`, `/ws`,
`/iroh-sync`, setup, and static serving.

The desktop and Android runtime currently starts a full Actix server and points
the frontend at `http://localhost:9883`. That works, but it means the app's
local runtime depends on a network endpoint, port binding, server startup
timing, cleartext-network permissions on Android, and server-shaped frontend
assumptions. It also makes it harder to use the same core from Flutter, embedded
native apps, tests, or non-HTTP transports.

The desired end state is:

```text
atomic_lib can run the node.

HTTP can expose the node.
WebSocket can stream the node.
Iroh can sync the node.
WASM can host the node in OPFS.
Tauri and Flutter can call the node directly.
```

No local app should need `localhost` to read, write, query, upload, download, or
sync its own data.

## Goals

- Make `atomic_lib` the owner of node/runtime semantics.
- Keep HTTP as an optional adapter, not an architectural dependency.
- Support full local operation: resources, commits, queries, blobs, events,
  outbox, and sync.
- Allow multiple carriers for the same semantics: in-process, WASM worker,
  Tauri IPC, Flutter Rust bridge, WebSocket, Iroh, WebRTC, or future transports.
- Keep `Db` as the durable graph/index store, but wrap it in a higher-level
  runtime that owns agent state, blobs, events, sync, and outbound work.
- Make server handlers thin adapters around the runtime.
- Make tests able to run two local nodes in process with no Actix server.

## Non-goals

- Removing HTTP from Atomic Data. HTTP remains important for public hosting,
  web interoperability, JSON-AD consumers, search URLs, and deployment.
- Rewriting `Db`. The first step is a runtime wrapper around the existing store.
- Making every feature available in WASM on day one. Some features may remain
  native-only or server-only until bindings and storage support catch up.
- Solving plugin sandboxing, S3 blobs, or search indexing in the same first PR.
  Those should move behind runtime services incrementally.

## Current Shape

### What already belongs to `atomic_lib`

- `Storelike::apply_commit` verifies/builds/applies commit responses and writes
  changed resources.
- `Db::init_redb`, `Db::init_redb_file`, and `Db::init_redb_opfs` already cover
  in-memory, native file, and browser OPFS storage.
- `Resource::save_locally` can sign and apply changes locally.
- `lib/src/sync/protocol.rs` contains binary frame encoding for resource updates,
  sync, and blob transfer.
- `lib/src/sync/engine.rs` compares Loro version vectors, computes diffs, imports
  sync pushes, and requests missing blobs.
- `wasm/src/lib.rs` already exposes local get, put, query, apply-commit, blob,
  version-vector, import, and export operations over `Db`.

### What is still endpoint-shaped

- `Resource::save_remote` means "sign then POST to `/commit`".
- `Storelike::fetch_resource` fetches through client helpers and saves the
  response.
- `Storelike::search` builds a `/search` subject and fetches it.
- Upload/download/blob handling is partly implemented in server handlers and
  partly as direct `Tree::Blobs` access.
- Desktop and Android start `atomic-server` locally and make the frontend talk
  to `localhost`.
- WebSocket code is an actor adapter around protocol pieces, not a generic node
  transport.

## Target Architecture

```text
                              external clients
                                    |
                       HTTP / WS / Iroh / future transport
                                    |
                              adapter layer
                                    |
┌───────────────────────────────────▼──────────────────────────────────┐
│                              AtomicNode                              │
│                                                                      │
│  get/query/search   mutate/apply_commit   blobs   outbox   sync      │
│        │                   │               │       │        │        │
│        ▼                   ▼               ▼       ▼        ▼        │
│  ResourceService     CommitService    BlobBackend Outbox SyncService │
│        │                   │               │       │        │        │
│        └───────────────────┴───────────────┴───────┴────────┘        │
│                                │                                     │
│                                ▼                                     │
│                               Db                                     │
│             redb native / redb OPFS / in-memory / tests              │
└──────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    |
                    Tauri IPC / Flutter bridge / WASM binding
                                    |
                              local frontend
```

`Db` remains the durable graph/index. `AtomicNode` is the runtime boundary that
applications use. It coordinates write semantics, events, blobs, sync, default
agent state, and optional services like search/plugins.

## `AtomicNode`

Initial API sketch:

```rust
pub struct AtomicNode {
    db: Db,
    events: NodeEventBus,
    blobs: Arc<dyn BlobBackend>,
    outbox: LocalOutbox,
    sync: SyncService,
    search: Option<SearchService>,
}

pub struct NodeConfig {
    pub storage: StorageConfig,
    pub base_domain: Option<String>,
    pub default_agent: Option<AgentConfig>,
    pub blobs: BlobConfig,
    pub search: SearchConfig,
    pub plugins: PluginConfig,
    pub discovery: DiscoveryConfig,
}

impl AtomicNode {
    pub async fn open(config: NodeConfig) -> AtomicResult<Self>;

    pub async fn get(&self, subject: &Subject, opts: GetOpts)
        -> AtomicResult<Resource>;

    pub async fn query(&self, query: Query)
        -> AtomicResult<QueryResult>;

    pub async fn search(&self, query: SearchQuery)
        -> AtomicResult<Vec<Resource>>;

    pub async fn apply_commit(&self, commit: Commit, opts: CommitOpts)
        -> AtomicResult<CommitResponse>;

    pub async fn mutate(&self, edit: ResourceEdit)
        -> AtomicResult<CommitResponse>;

    pub async fn put_blob(&self, bytes: &[u8])
        -> AtomicResult<BlobRef>;

    pub async fn get_blob(&self, hash: &[u8; 32])
        -> AtomicResult<Option<Vec<u8>>>;

    pub fn subscribe(&self, sub: Subscription)
        -> NodeEventStream;
}
```

The first implementation can mostly delegate to existing `Db` and `Storelike`
methods. The value is the stable boundary: all adapters call this surface.

## Runtime Services

### ResourceService

Owns resource reads and dynamic resource construction.

Important split:

```rust
pub struct GetOpts {
    pub dynamic: bool,
    pub for_agent: ForAgent,
    pub include_referenced: bool,
}
```

Stored reads and dynamic reads must stay explicit. Dynamic endpoint-like
resources are useful, but they must not make an empty store look seeded, and
they must not blur local cache state with computed responses.

### CommitService

Owns commit validation and application.

HTTP auth extraction stays in `atomic-server`; rights checking and commit
validation belong in `atomic_lib`.

The current split should become:

- `Resource::save_locally`: compatibility helper for local signing/application.
- `AtomicNode::mutate`: preferred high-level local edit API.
- `AtomicNode::apply_commit`: canonical apply path for signed commits.
- `AtomicNode::enqueue_outbound`: durable intent to sync with other peers.
- `Resource::save_remote`: compatibility helper only. New internal code should
  avoid it.

This removes "save means HTTP POST" from the core model.

### BlobService

Owns content-addressed bytes.

The `BlobBackend` proposed in `s3-blob-storage.md` should live under this
runtime layer. HTTP `/upload`, `/download`, `BLOB_REQUEST`, `BLOB_RESPONSE`,
Tauri file import, Flutter attachment import, and browser offline blobs should
all use the same blob semantics.

```rust
#[async_trait]
pub trait BlobBackend: Send + Sync {
    async fn get(&self, hash: &[u8; 32]) -> AtomicResult<Option<Vec<u8>>>;
    async fn put(&self, hash: &[u8; 32], bytes: &[u8]) -> AtomicResult<()>;
    async fn has(&self, hash: &[u8; 32]) -> AtomicResult<bool>;
    async fn delete(&self, hash: &[u8; 32]) -> AtomicResult<()>;
}
```

The default implementation can wrap today's `Tree::Blobs`.

### Outbox

Owns local-first outbound work.

There should be one durable outbox per node, not one per runtime. Browser
`dirtyForSync`, resource pending commits, localStorage offline entries, and
native pending sync work should converge into this service.

```rust
pub enum OutboxEntry {
    Commit {
        subject: Subject,
        commit: Commit,
        blobs: Vec<[u8; 32]>,
    },
    Blob {
        hash: [u8; 32],
    },
}

pub struct LocalOutbox;

impl LocalOutbox {
    pub async fn enqueue(&self, entry: OutboxEntry) -> AtomicResult<()>;
    pub async fn drain<T: AtomicTransport>(&self, peer: T) -> AtomicResult<DrainReport>;
    pub async fn pending(&self) -> AtomicResult<Vec<OutboxEntry>>;
}
```

Draining must be idempotent. Re-entrance should return or join the in-flight
drain rather than running a second drain.

### EventBus

All adapters should observe the same event vocabulary.

```rust
pub enum NodeEvent {
    ResourceChanged {
        subject: Subject,
        commit_id: Option<String>,
        source: ChangeSource,
    },
    ResourceDestroyed {
        subject: Subject,
        source: ChangeSource,
    },
    QueryChanged {
        filter: QueryFilter,
        added: Vec<Subject>,
        removed: Vec<Subject>,
    },
    BlobAvailable {
        hash: [u8; 32],
    },
    SyncStateChanged {
        drive: Subject,
        state: SyncState,
    },
}

pub enum ChangeSource {
    LocalMutation,
    LocalReplay,
    RemoteUpdate,
    SyncPush,
    Import,
    HttpAdapter,
}
```

Server WebSocket pushes, browser OPFS notifications, Tauri UI refreshes, and
Flutter streams should all be projections of these events.

### SyncService

Owns peer sync independently of any one transport.

The binary protocol currently documented as WebSocket v2 should become the
transport-neutral Atomic peer protocol. WebSocket is one carrier.

```rust
#[async_trait]
pub trait AtomicTransport {
    async fn send(&mut self, frame: Vec<u8>) -> AtomicResult<()>;
    async fn recv(&mut self) -> AtomicResult<Vec<u8>>;
}

impl AtomicNode {
    pub async fn sync_with<T: AtomicTransport>(
        &self,
        transport: T,
        drive: Subject,
        opts: SyncOpts,
    ) -> AtomicResult<SyncReport>;
}
```

Adapters:

- In-process channel transport for tests.
- WebSocket transport for browsers and hosted servers.
- Iroh transport for device-to-device sync.
- Tauri IPC transport if needed.
- Flutter bridge stream transport if needed.

## Adapters

### `atomic-server`

Server should become an adapter around `AtomicNode`.

```text
HTTP /commit      -> node.apply_commit(...)
HTTP /query       -> node.query(...)
HTTP /search      -> node.search(...)
HTTP /upload      -> node.put_blob(...) + node.mutate(file resource)
HTTP /download    -> node.get_blob(...)
HTTP /blob        -> node.get_blob(...)
WS GET            -> node.get(...)
WS UPDATE         -> node.apply_commit or node.import_update
WS SYNC_PUSH      -> node.sync.import_push(...)
WS BLOB_REQUEST   -> node.get_blob(...)
```

The server should still own:

- HTTP routing.
- Header/cookie extraction.
- Content negotiation.
- CORS.
- Static assets and SPA fallback.
- Public setup/admin endpoints.
- Public-hosting concerns such as TLS, domains, and federation UX.

It should not own core commit, blob, query, sync, or local runtime semantics.

### Browser WASM / OPFS

The existing `ClientDb` binding is already close to a local runtime binding. It
should evolve from "OPFS cache API" toward "WASM `AtomicNode` API".

Target shape:

```ts
const node = await AtomicNode.open({ storage: 'opfs' });

await node.get(subject);
await node.query(query);
await node.mutate(edit);
await node.putBlob(bytes);
node.subscribe(filter, event => ...);
await node.syncWith(remote);
```

The browser data layer in `planning/unified-data-layer.md` then becomes the
JS cache/reactivity layer around this node surface, not a separate authority
with its own parallel write paths.

### Tauri Desktop / Android

Current runtime:

```text
Tauri webview -> http://localhost:9883 -> Actix server -> atomic_lib
```

Target runtime:

```text
Tauri webview -> Tauri commands / event streams -> atomic_lib::AtomicNode
```

Optional "Expose local HTTP server" can remain as a feature. The app itself
should not need it.

Android-specific benefits:

- No cleartext `localhost` network permission for the app's own data path.
- No port binding or startup race.
- No ambiguity about whether the embedded server is reachable from other
  devices.
- Better fit for native key storage and app data directories.

### Flutter

Flutter should call the same runtime through `flutter_rust_bridge`, not a
separate mobile database API. **Sync strategy:** same as the browser — WS session
to a configured server, live query/resource subscriptions, outbox drained via
`COMMIT`. Do not treat manual Iroh `peer_sync` after QR pairing as the primary
multi-device path. See [`unified-sync.md`](./unified-sync.md).

The bridge should expose node-level commands and streams:

- `open_node`
- `get_resource`
- `query`
- `mutate`
- `put_blob`
- `subscribe_events`
- `open_sync_session` / `close_sync_session` (WS or other `AtomicTransport`)

`sync_with_peer` / bulk `peer_sync` are legacy; fold into `SyncSession` with
`IrohTransport` only if serverless P2P remains a product requirement.

Flutter should not need to know whether the node is backed by native redb, OPFS,
or a hosted server adapter.

## Protocol Direction

The binary protocol documented in `docs/src/websockets.md` should be treated
conceptually as "Atomic peer protocol over WebSocket": WebSocket is one carrier,
not the owner of the resource semantics.

Important consequences:

- `GET`, `UPDATE`, `DESTROY`, `SUB`, `SYNC`, `SYNC_PUSH`, `BLOB_REQUEST`, and
  `BLOB_RESPONSE` are node operations, not server operations.
- WebSocket actors encode/decode frames and call `AtomicNode`.
- Iroh can use the same frame semantics.
- Tests can use the same frames in memory.
- Future transports should not need new resource semantics.

The protocol document currently describes a cleaner end state than the
implementation in a few places. Track these as migration items:

- `SYNC_DIFF` is documented as msgpack but currently encoded as JSON.
- Some text/hybrid paths still exist.
- Query subscriptions are not fully folded into binary drive/query semantics.
- `QUERY_UPDATE` currently carries membership only; inlining snapshots for added
  subjects would remove follow-up `GET` races.

## Search And Plugins

Search and plugins are the hardest pieces to keep portable.

Search should be an optional runtime service:

```rust
pub trait SearchBackend: Send + Sync {
    async fn index_commit(&self, response: &CommitResponse) -> AtomicResult<()>;
    async fn search(&self, query: SearchQuery) -> AtomicResult<Vec<Subject>>;
}
```

Initial implementations:

- No-op/local indexed search for small runtimes.
- Tantivy backend for server/native.

Plugins should remain explicitly optional in `NodeConfig`. A runtime can support
core resources, commits, blobs, queries, and sync without supporting plugin UI or
plugin execution.

## Authorization

Transport authentication and authorization must be separated.

Adapters authenticate the caller:

- HTTP extracts headers/cookies.
- WebSocket authenticates the connection.
- Iroh authenticates peer/session identity.
- Tauri/Flutter local calls may use the local default agent.

`atomic_lib` checks rights:

- Read checks for `get`, `query`, and `sync` pushes.
- Write checks for `apply_commit`, `mutate`, and imported remote updates.
- Sudo remains an explicit mode, not an accidental default.

This lets a local node safely receive commits from untrusted peers without
needing an HTTP server in front of it.

## Migration Plan

### Phase 1: Introduce `AtomicNode` Without Behavior Change

- Add `lib/src/runtime/`.
- Add `AtomicNode`, `NodeConfig`, and simple constructors around existing `Db`
  initialization.
- Add `get`, `query`, `apply_commit`, `put_blob`, and `get_blob` by delegating to
  existing code.
- Keep server using `AppState`, but allow `AppState` to hold an `AtomicNode`.

Tests:

- Existing `atomic_lib` tests still pass.
- New smoke test opens an in-memory `AtomicNode`, creates an agent, mutates a
  resource, queries it, and reads it back.

### Phase 2: Thin Server Handlers

- Refactor `/commit` to call `node.apply_commit`.
- Refactor `/query` to call `node.query`.
- Refactor `/download` and `/blob` to call `node.get_blob`.
- Refactor `/upload` to call `node.put_blob` and then node-level file resource
  mutation.

Tests:

- Existing server handler tests remain behaviorally unchanged.
- Add tests that call the node API directly and compare with HTTP handler
  behavior.

### Phase 3: Runtime Events

- Add `NodeEvent`.
- Emit `ResourceChanged`, `ResourceDestroyed`, `QueryChanged`, and
  `BlobAvailable` from node-level operations.
- Rebase server commit monitor / WS push logic on node events where possible.

Tests:

- Applying a commit emits exactly one resource event.
- Query membership changes emit query events.
- Blob writes emit blob events.

### Phase 4: Transport-Neutral Sync

- Add `AtomicTransport`.
- Move frame handling that is not Actix-specific into `atomic_lib`.
- Add in-process transport tests with two `AtomicNode`s and no HTTP server.
- Keep WebSocket and Iroh adapters as wrappers.

Tests:

- Two in-memory nodes sync a drive with resources and blobs.
- Same test runs through Iroh where feature-gated.
- No Actix server required for the core sync test.

### Phase 5: Durable Outbox

- Add one node-level outbox.
- Move browser/local pending write concepts toward this model.
- Make drain re-entrant/idempotent.
- Track blobs and commits together so file metadata cannot sync without bytes.

Tests:

- Offline mutation persists in outbox.
- Restart/reopen drains once.
- Re-entrant drain does not double-submit.
- Blob + file resource drain together.

### Phase 6: WASM Binding Over `AtomicNode`

- Expose a WASM `AtomicNode` binding beside or beneath existing `ClientDb`.
- Move JS OPFS worker calls toward node-level methods.
- Make browser data layer consume node events and one local outbox.

Tests:

- Existing OPFS/browser tests continue to pass.
- New tests use node-level WASM calls without HTTP for local get/query/mutate.

### Phase 7: Tauri / Android Without Loopback

- Add Tauri commands for node get/query/mutate/blob operations.
- Add an event stream from node events to the webview.
- Point Tauri frontend at native node commands for local data.
- Keep optional embedded HTTP server for "serve this node" mode.

Tests:

- Desktop/Android smoke path works with no local server bound.
- Release build does not require cleartext localhost for core app behavior.

### Phase 8: Clean Up Endpoint-Shaped APIs

- Mark `Resource::save_remote` as compatibility-focused in docs.
- Prefer `AtomicNode::mutate` and `AtomicNode::apply_commit` in new code.
- Remove internal server assumptions from `Storelike::search` and similar helper
  methods where practical.
- Update docs and examples to show node-first APIs for embedded/local use.

## First PR Series

1. Add `AtomicNode` wrapper and direct in-memory tests.
2. Move blob get/put behind `BlobBackend` with a redb implementation.
3. Refactor `/commit` to call `AtomicNode::apply_commit`.
4. Refactor `/download`/`/blob` to call `AtomicNode::get_blob`.
5. Add `NodeEvent` and emit from commit/blob operations.
6. Add in-process transport and two-node sync test.

This order keeps blast radius small: first create the boundary, then move one
server endpoint at a time.

## Open Questions

- Should `AtomicNode` own the default agent directly, or should agent storage be
  a separate trait so native keychains and browser crypto storage can differ?
- Should search be in `atomic_lib` behind a feature, or remain a native-only
  service crate consumed by both server and desktop?
- How should plugin execution be represented for runtimes that can store plugin
  resources but cannot execute them?
- Should `QUERY_UPDATE` inline snapshots before or after the node event model is
  introduced?
- How much of JSON-AD parsing/serialization belongs in hot local APIs versus
  adapter APIs only?

## Decision Record

- `Db` remains the durable store. `AtomicNode` wraps it.
- HTTP is an adapter. It must not be required for local app runtime behavior.
- The binary resource protocol is transport-neutral. WebSocket is one carrier.
- Authorization checks belong in `atomic_lib`; transport authentication belongs
  in adapters.
- Browser OPFS and native redb should converge on the same node semantics.
