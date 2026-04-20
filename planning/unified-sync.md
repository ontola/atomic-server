# Unified sync — one API, WS or Iroh

> **Status:** Active plan (2026-05). Supersedes ad-hoc “pair then `peer_sync`” as the
> primary multi-device story for Flutter. Builds on completed WS `COMMIT` work in
> [`sync.md`](./sync.md) and the runtime boundary in
> [`atomic-lib-runtime.md`](./atomic-lib-runtime.md).

## Goal

One **transport-agnostic sync API** in `atomic_lib` that apps use the same way whether
the carrier is **WebSocket** (browser ↔ server, mobile ↔ server) or **Iroh** (optional
device-to-device). Callers subscribe to **node events** (including live queries); they
do not call `peer_sync()` after scanning a QR code.

```text
Flutter / browser UI
        │
        ▼
  AtomicNode / SyncSession          ← single API
  · subscribe(Subscription)
  · mutate / apply_commit → Outbox
  · sync_drive (optional full reconcile)
        │
        ▼
  Local Db (offline-first cache)
        │
   ┌────┴────┐
   ▼         ▼
WsTransport  IrohTransport          ← send/recv same v2 frames
```

Wire format: [`docs/src/websockets.md`](../docs/src/websockets.md) (Atomic peer
protocol). Encoding lives in `lib/src/sync/protocol.rs`; semantics in
`lib/src/sync/engine.rs`.

## Current state (honest)

| Piece | Browser | Flutter native |
| --- | --- | --- |
| Local store | OPFS (`ClientDb`) | redb (`Db` in FRB) |
| Server URL | Yes | Often empty (`serverUrl: ''`) |
| Persist commits | WS `COMMIT` + HTTP fallback ✅ | WS `COMMIT` when session open (partial outbox); else local only |
| Live updates | WS `SUB` + `QUERY_UPDATE` | WS session + `pollDbEvent` (migrating off `watch_children`) |
| Multi-device | Same account on same server | WS-first; **`peer_sync`** / QR + Iroh bulk as fallback |
| Live queries | `SUBSCRIBE_QUERY` → server push | `SUBSCRIBE_QUERY` wired in `ws_sync` (gallery still catching up) |

**Done recently:** persisted commits over WS (`COMMIT` / `COMMIT_OK`), source-aware
echo suppression per connection — see [`sync.md`](./sync.md) rollout.

**Still wrong for mobile:** two devices with the same agent do not stay live-synced
unless the user re-runs Iroh sync. Folder moves in the canvas gallery are
in-memory only (`folderId`), so they never appear on another device regardless of
transport.

## Target behavior (same as browser)

For **phone + tablet + web** on the **same drive / agent**:

1. Each client holds a **local node** (`Db`) and an **outbox** of signed commits.
2. While online, a **background WS session** to the configured server:
   - Authenticates with the agent.
   - **`SUB`** on the active drive (or `SUBSCRIBE_QUERY` for `parent = drive`).
   - Drains outbox via **`COMMIT`** (same path as browser `Store.postCommit`).
3. Incoming **`QUERY_UPDATE`** / **`UPDATE`** frames apply into local `Db` and surface
   as **`NodeEvent::QueryChanged`** / **`ResourceChanged`** (see runtime doc).
4. UI (e.g. `CanvasStore`) **subscribes to events**, not `watch_children` + manual sync.

Iroh remains useful as an **optional carrier** for offline LAN / no-server scenarios,
using the **same frames and `handle_frame`**, not a separate “sync product.”

## Trust and authority

See also [`atomic-lib-runtime.md` § Authorization](./atomic-lib-runtime.md#authorization)
(transport authentication vs `atomic_lib` rights) and [`sync.md` § Deletes over bulk sync](./sync.md#deletes-over-bulk-sync).

### Default (canvas v1): hub + signed commits

For **phone + tablet + web** on the **same agent**, the **configured server** is the
source of truth. Clients are offline-first **replicas**:

- **Trust:** commits applied on the hub (rights-checked) and pushed to subscribers.
- **Do not trust:** Iroh `NodeID` alone, QR scan alone, or bulk `SYNC_DIFF` as a second
  authority over deletes.

Same-agent multi-device needs **no share invite** for your own drive
([`virtual-drive.md`](./virtual-drive.md)). Cross-agent sharing is a separate
product — primitives and trust model in
[`authorization-sync.md`](./authorization-sync.md) (delegated A → B → C,
volunteer replicas, indexers, paired-subtree DMs, constrained append-only
inbox); UX/handshake notes in [`sync.md`](./sync.md).

### Two sync layers (do not conflate)

```text
Layer 1 — Commit log (authoritative)
  mutate → sign → outbox → COMMIT → hub apply + rights
  → other clients: UPDATE / QUERY_UPDATE (added|removed) / DESTROY

Layer 2 — Bulk reconcile (same-agent catch-up / offline gap)
  SYNC → SYNC_DIFF { pull, push, remove } → SYNC_PUSH
  Loro VV diff + local tombstones; see docs/src/websockets.md
```

| Layer | Proves identity | Proves rights | Deletes |
| --- | --- | --- | --- |
| **1 — Live / COMMIT** | WS `AUTH` or HTTP auth | Hub `apply_commit` + hierarchy | Signed destroy commit → `removed` / `DESTROY` |
| **2 — Bulk** | `AUTH` on stream before `SYNC` (required policy) | `check_read` on push; `check_write` on `import_sync_push` | `remove[]` from peer tombstones — **not** a signed commit on the wire |

**Policy:** authoritative delete = Layer 1 on the hub. Layer 2 `remove` only prevents
resurrection between honest replicas of the same agent; it must not replace hub policy
for cross-agent or adversarial peers.

### What each path guarantees today

| Check | Where |
| --- | --- |
| **Who is the peer?** | `AUTH (0x01)` — agent signs `{requestedSubject} {timestamp}`; receiver loads `ForAgent` ([`protocol.rs`](../lib/src/sync/protocol.rs)) |
| **Read access to pushed data?** | `handle_sync_vv`: `check_read` per subject before `push` |
| **Write access to imported push?** | `import_sync_push`: `check_write` on drive (skipped only if drive missing — bootstrap) |
| **QR / NodeID** | Routing / pairing only — **not** authorization |

### What we do not trust

- Peer **`remove`** without a product decision to treat tombstones as authoritative
  (malicious or mistaken peer could drop replicas if authenticated).
- **Unauthenticated `SYNC`** on private drives — must yield no `SYNC_PUSH` (tests in
  `lib/src/sync/tests.rs`).
- **UI-only mutations** (local gallery state without signed commit) — never sync.

### Outbox rule (all transports)

Every persisted mutation, including **destroy** (canvas/folder delete), must:

1. Sign a commit locally.
2. Apply to local `Db`.
3. Drain outbox via **`COMMIT`** on WS when the session is open.

Iroh `nudge_peers` / bulk sync is **fallback** when the hub is unreachable, not a
parallel sync product.

### `NodeEvent::ResourceDestroyed` sources

| Source | When |
| --- | --- |
| Local `apply_commit` (destroy) | After local apply |
| WS / Iroh `DESTROY` | Live frame |
| WS `QUERY_UPDATE.removed` | Membership left drive/query |
| Bulk `SYNC_DIFF.remove` | After `apply_destroy` on reconcile (Layer 2) |

### Engineering debt (trust-related)

- [ ] **Iroh live loop** — `handle_frame` in the read loop uses `ForAgent::Public`; carry
  authenticated agent from bulk handshake into live mode.
- [ ] **Require `AUTH` before `SYNC` / `SYNC_PUSH`** on accept paths (fail closed).
- [ ] **Bind `AUTH.requestedSubject` to `SYNC.drive`** for the session.
- [ ] **Outbox:** all destroy paths on mobile (not only strokes) → `try_push_commit`.
- [ ] **Browser:** decode/apply `SYNC_DIFF.remove` in `ws-v2` / `websockets.ts` when using bulk sync.

Option **A** (server-only multi-device) makes Layer 2 rare; Option **B** needs the
hardening above if P2P stays user-facing.

## Unified API sketch

Align with [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) (`SyncService`,
`NodeEvent`, `AtomicTransport`):

```rust
pub enum Subscription {
    Drive(Subject),
    Query { property: String, value: String, drive: Subject },
    Resource(Subject),
}

pub enum NodeEvent {
    ResourceChanged { subject: Subject, source: ChangeSource, .. },
    ResourceDestroyed { subject: Subject, source: ChangeSource },
    QueryChanged { filter: QueryFilter, added: Vec<Subject>, removed: Vec<Subject> },
    SyncStateChanged { drive: Subject, state: SyncState },
}

impl AtomicNode {
    pub fn subscribe(&self, sub: Subscription) -> NodeEventStream;
    pub async fn drain_outbox(&self, transport: &mut impl AtomicTransport) -> ..;
    pub async fn run_sync_session(&self, transport: impl AtomicTransport, drive: Subject) -> ..;
}
```

**WS adapter:** `atomic_lib::client::ws::WsClient` — connect, auth, send binary
frames, map incoming messages to `NodeEvent`.

**Iroh adapter:** existing `lib/src/sync/peer.rs` live stream — already pushes
`UPDATE`/`DESTROY` after handshake; should emit the **same** `NodeEvent`s after
import, not a separate Flutter command surface.

**Flutter bridge (FRB):** expose `subscribe_events`, `open_sync_session(server_url)`,
`close_sync_session` — **not** `peer_sync` / `watch_children` as the primary API.

## Retire manual `peer_sync`

### Remove from the default UX

- QR pair → bulk `sync_drive_with_peer` → hope live loop catches up.
- `AtomicClient.peerSync`, `discoverSync`, `connect(nodeId)` as sync entry points.
- `watch_children` blocking loop in `canvas_store.dart` (60s timeout poll).

### Replace with

- User signs in with agent + **server URL** (hosted, self-hosted, or embedded).
- App starts **WS sync session** on launch / resume.
- Gallery subscribes to `Query { parent: drive }` (canvas class filter in UI or query).
- Open canvas subscribes to `Resource(canvas)` for `UPDATE` / Loro sync as needed.

### Iroh after migration

| Option | When |
| --- | --- |
| **A. Remove bulk Iroh sync** | Same-user multi-device always via server; largest code deletion (`peer_sync` path). |
| **B. Keep Iroh under `SyncSession`** | “Sync without server” feature; same API, `IrohTransport` only. |

Default recommendation: **A for canvas v1** (phone/tablet share one server account);
**B later** if true serverless P2P is a product requirement.

### Code likely deleted or shrunk

- `peer_sync`, `peer_discover_sync` in `flutter/rust/src/api/simple.rs`
- Iroh-specific branches in `connect()` command multiplexer
- `watch_children:` bridge command
- Pair-screen “syncing…” bulk transfer as **required** step (pairing may return for share invites)
- Much of the **manual** sync UX in `lib/src/sync/peer.rs` if Option A

Reuse instead of reimplementing: `WsClient`, `apply_commit_json`, `CommitMonitor` +
`QueryMembershipChanged` on server; client-side `DbEvent` already fires query
membership on local apply.

## Net code impact

| Phase | Expectation |
| --- | --- |
| Migration | **More** code briefly (WS session task, FRB streams, outbox drain on mobile). |
| Steady state (drop manual Iroh as primary) | **Net cleanup** (~500–1k+ lines), simpler `simple.rs` and `CanvasStore`. |
| Steady state (Iroh + WS, unified API) | Similar LOC, **much** clearer boundaries. |

Not a cleanup if we **add** full WS mobile **without** removing Iroh bulk + `watch_children`.

## Mobile-specific notes

From [`virtual-drive.md`](./virtual-drive.md) and runtime doc:

- **WS does not survive background suspension** — reconnect on resume; optional push
  (APNs/FCM) is out of scope here.
- **Conflict / offline:** local `Db` + outbox must drain when back online (same as
  browser).
- **Gallery folders:** persist in the graph (`parent` on canvas resources, or Folder
  resources) so `QueryChanged` is meaningful on all transports.

## Implementation phases

### Phase 1 — WS session on mobile (primary)

- [x] Require/configure `serverUrl` for native sign-in (default `http://localhost:9883`).
- [x] Rust: background task — `WsClient::connect`, auth, `SUB` drive, handle
  `QUERY_UPDATE` / `UPDATE` → apply to `Db` (`flutter/rust/.../ws_sync.rs`, `lib/src/sync/ws_apply.rs`).
- [x] FRB: `poll_db_event` bridge (JSON); dedicated `Stream` can follow.
- [x] Wire `CanvasStore` off `pollDbEvent` instead of `watch_children`.
- [x] Outbox (partial): `push_stroke` → `try_push_commit` over WS when session open.
- [ ] Outbox: **destroy** commits (delete canvas/folder) always `try_push_commit` when WS open.

### Phase 2 — Parity with browser

- [x] `SUBSCRIBE_QUERY` for `parent = drive` (and canvas class in app layer).
- [x] Per-canvas `LORO_SYNC_SUBSCRIBE` when editor open (`ws_sync::subscribe_canvas`, `main.dart`).
- [ ] Narrow server `QUERY_UPDATE` to membership-only changes ([`sync.md`](./sync.md)).

### Phase 3 — Demote Iroh manual sync

- [x] Login: WS-first sync from server; QR pair demoted to “offline” fallback on needs-sync screen.
- [ ] Hide/remove QR bulk sync from agent settings (still available).
- [ ] Fold any remaining P2P into `SyncSession { transport: Iroh }` or delete
  `peer_sync` exports.
- [ ] Regenerate FRB; delete dead `connect("…")` commands.

### Phase 4 — Tests

- [x] `server/tests/ws_commit.rs` — COMMIT over WS + subscriber UPDATE.
- [x] `cargo test -p atomic-server --test sync --test query_subscribe`.
- [x] `push_list_item_save_locally_persists_strokes` (atomic_lib, db-redb).
- [x] `browser/lib` vitest suite (52 tests).
- [ ] Flutter integration: tablet + phone against test server (manual / headless FRB).

## Related plans

| Doc | Relationship |
| --- | --- |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | Owns `AtomicNode`, `NodeEvent`, `AtomicTransport`. |
| [`sync.md`](./sync.md) | WS `COMMIT` / echo suppression — **done**; bulk deletes (`remove`, tombstones); query semantics follow-up. |
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser cache on top of node API; converge `applyIncoming` + outbox. |
| [`virtual-drive.md`](./virtual-drive.md) | VFS should subscribe to same `QueryMembershipChanged` / watched-queries cache. |

## Open questions

1. **Embedded server on mobile** — Is every install its own server, or do phone/tablet
   point at a shared hosted instance? (Affects whether `serverUrl` is localhost vs cloud.)
2. **Share / pairing UX** — Replacing QR bulk sync with explicit share requests
   ([`sync.md`](./sync.md) handshake notes) may still be needed for *other users’*
   drives, separate from same-agent multi-device.
3. **Iroh default** — Ship Option A (server-only) or keep Iroh as silent fallback when
   `serverUrl` unreachable?
4. **P2P `remove` policy** — Accept peer tombstones as-is for same-agent reconcile, or
   only apply deletes that arrived as signed commits from the hub?
5. **Fail-closed bulk** — Require `AUTH` before any `SYNC` / `SYNC_PUSH` on incoming Iroh
   (and enforce ordering on accept)?
6. **Session binding** — Must `AUTH.requestedSubject` equal the `drive` in the following
   `SYNC` frame for that connection?
