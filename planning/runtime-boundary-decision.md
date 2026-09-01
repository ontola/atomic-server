# Runtime boundary: Rust-only vs twinned-by-design

**Status:** Accepted 2026-09-01 — option C. `AtomicNode` in `lib/src/runtime/` is the binding runtime; #1277 and #1241 must bind it, no parallel `simple.rs` / `ffi/` surface. A first slice is being built on branch `feat/atomic-node-slice`.

> **Decision needed by maintainer**
>
> Question: Which logic may exist twice (Rust `atomic_lib` and TS `@tomic/lib`), and what do new SDKs bind to?
> Options: (A) Twinned-by-design — both libraries are full peers, parity by golden tests. (B) Rust-only — TS becomes a thin WASM binding, protocol logic leaves JS. (C) Rust-authoritative core, TS owns cache/reactivity/UI, twins only for pure functions bound by a shared fixture and the #1273 gate.
> Recommendation: **C** — Rust already owns every ingest/verify/authorize path and the crossing cost (#1278) rules out B for reads; A has no gate and is already drifting (commit canonical bytes, RBSR vector).
> Blocked PRs: #1277, #1241 (follow-up), #1307 (applier), #1313, #1311.

## Context

There is no runtime boundary today. `AtomicNode` and `lib/src/runtime/` from
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md) do not exist: `git grep AtomicNode`
matches only `planning/*.md`; `lib/src/runtime` is absent. Instead there are
**five hand-rolled wrappers of `Db`**, none in `atomic_lib`:

| Wrapper | Where | Size |
| --- | --- | --- |
| WASM `ClientDb` | `wasm/src/lib.rs` | 992 lines; `applyCommit` builds its own `CommitOpts` with every `validate_*` off (`wasm/src/lib.rs:195-204`) |
| Flutter FRB | `flutter/rust/src/api/simple.rs` | 1444 lines, ~60 `pub fn` mixing store, canvas, WS, Iroh |
| Python PyO3 | `python/src/store.rs` (PR #1277) | 420 added lines |
| Kotlin UniFFI | `ffi/src/store.rs` (PR #1277) | 266 added lines; same method list as Python |
| Actix handlers | `server/src/handlers/commit.rs`, `server/src/commit_monitor.rs` | third commit-ingest path per #1273 |

#1277's own `planning/kotlin-sdk.md` calls `ffi/` "a thin slice of `atomic-lib-runtime.md`
`AtomicNode`" and lists Flutter `simple.rs` as a fourth caller to fold in later. #1241 lists
"split generic node API out of `simple.rs` → toward `AtomicNode`" as its next step. Both PRs
are building the node surface outside `lib/` because it does not exist inside it.

### What the TS library actually does

`@tomic/lib` **signs but never verifies**. `browser/lib/src/commit.ts` exports
`serializeDeterministically` and `CommitBuilder.signAt`; there is no signature check in the
file. Incoming commits go through `applyCommitToResource` → `execLoroUpdateCommit`
(`commit.ts:469-545`), a bare `resource.importLoroUpdate`. Rights checks in TS are
`Resource.canWrite` (`browser/lib/src/resource.ts:1328`), used only by the React hook
(`browser/react/src/hooks.ts:715`) to grey out UI. The authority for all of these is Rust:
`Commit::validate_signature` (`lib/src/commit.rs:363`), `validate_and_build_response`
(`:513`), `hierarchy::check_write/check_read/check_rights` (`lib/src/hierarchy.rs:93-214`).

The WASM node already carries the browser's persisted copy: `ClientDb.applyCommit` parses
JSON-AD with `parse_json_ad_resource` and calls `Db::apply_commit`
(`wasm/src/lib.rs:178-210`). The JS `Resource`/`Store` is a cache + outbox + TipTap
`LoroDoc` on top of it. #1278 measured the crossing: JS `Resource.get(name)` ~0.07 µs vs
WASM `getResource` → JSON-AD ~75 µs, "~1000×"; native Ed25519 sign 24 µs vs noble JS 284 µs.
Its recommendation: "do not move `Resource.get` / the JS cache into WASM".

### The twins, verified

| Job | Rust | TS | Shared fixture | Verdict |
| --- | --- | --- | --- | --- |
| Commit canonical JSON + Ed25519 sign | `lib/src/commit.rs` `serialize_deterministically_json_ad` (:1181), `sign` (:1299) | `browser/lib/src/commit.ts` `serializeDeterministically` (:368), `signAt` (:213) | **None.** `sign.test.ts:24-39` pins an inline legacy `set` vector; Rust `signature_matches` (`commit.rs:1625`) no longer asserts bytes, only `validate_signature`. One-sided. | Keep twin (sign only). Add `testdata/commit-canonical.json` consumed by both. |
| Commit verify + apply | `commit.rs` `validate_signature`, `apply_changes` (:1014); `lib/src/sync/engine.rs` `ingest_commit_json` (:327); `wasm/src/lib.rs` `applyCommit` | `commit.ts` `applyCommitToResource` — import only, no verify | n/a | **Rust-only.** TS keeps in-memory Loro import for the UI doc; persistence and verification go through the WASM node. |
| Genesis cert encode/sign/verify | `lib/src/genesis.rs` `GenesisCert::{encode,decode,sign,verify}` (:67-226) | `browser/lib/src/genesis.ts` `encodeGenesisCert`, `signGenesisCert`, `verifyGenesisCert` (:79-234) | **Yes.** `lib/src/genesis_test_vectors.json`, loaded by `genesis.rs:545` (`matches_the_golden_vectors`), `genesis.test.ts:184`, and `flutter/test/atomic/signing_golden_vectors_test.dart:19`. | Keep twin. This is the model every other twin must copy. |
| RBSR item/range fingerprint + reconcile | `lib/src/sync/rbsr.rs` `item_fingerprint` (:44), `range_fingerprint` (:67), `reconcile` (:117); server side `server/src/handlers/web_sockets.rs:552` | `browser/lib/src/rbsr.ts` same three; client side runs `reconcile` in `websockets.ts:1085` | **Inline only.** Same hex in `rbsr.rs:414` and `rbsr.test.ts:37-40`; not a shared file. | Keep twin until `AtomicNode::sync_with` reaches WASM; promote vector to `testdata/`. |
| Canonical drive hash (SYNC_VV probe) | `lib/src/sync/engine.rs` `compute_drive_hash` (:570) | `browser/lib/src/canonical-drive-hash.ts` (40 lines) | **Inline only.** `lib/src/sync/tests.rs:2302` and `canonical-drive-hash.test.ts:11-14` pin the same hex. | Keep twin; [`drive-reconciliation.md`](./drive-reconciliation.md) calls byte-parity "the load-bearing task". Promote to `testdata/`. |
| Authorization / hierarchy | `lib/src/hierarchy.rs` (917 lines) | `resource.ts` `canWrite` (60 lines, UI hint) | None | **Rust-only.** `canWrite` stays as a hint; it is never a gate. |
| Loro materialize + datatype tags | `lib/src/loro.rs` `loro_value_to_atomic_value_tagged` (:848), `datatype_tag` (:828) | `resource.ts` `rebuildCacheFromLoro` (:739), `writeDatatypeTags` (:807); `datatypes.ts` `datatypeTag` (:69) | None | Keep twin for tags (pure) with a fixture. Materialization stays twinned because TipTap needs a main-thread `LoroDoc` (#1278). |
| JSON-AD parse / serialize | `lib/src/parse.rs` (1552), `lib/src/serialize.rs` (490) | `browser/lib/src/parse.ts` `JSONADParser` (133) | None | Keep twin; adapter format, not authority. |
| WS v2 frames | `lib/src/sync/protocol.rs` `encode_*` (:220-321) | `browser/lib/src/ws-v2.ts` `encode*` (:121-226) | Unverified (no `testdata/` entry) | Keep twin; add frame fixture. |
| Auth header signing | `lib/src/authentication.rs` | `browser/lib/src/authentication.ts` `signRequest` (:38) | None | Keep twin; tiny. Fixture. |
| Search escape / server URL | `lib/src/client/search.rs` | `browser/lib/src/search.ts`, `flutter/lib/atomic/server_url.dart` | **Yes in #1274**: `testdata/search-query.json`, `testdata/server-url.json` | Keep twin, bound by #1274. |
| Plugin planner / applier (#1307) | `server/src/plugins/plan.rs` (783), `apply.rs` (879) | `browser/lib/src/plugin-plan.ts` (450), `plugin-apply.ts` (487) | **Yes**: `testdata/plugin-plans/*.json`, run by `plugin-plan.fixtures.test.ts` and `plugins::plan::fixture_tests` | Planner: keep twin (pure, fixtured). Applier: writes commits — not pure; see Consequences. |
| Query / filter evaluation | `lib/src/db/query_index.rs` `QueryFilter`, `query_id` (:33-141); `Storelike::query` | none — `client-db.ts` calls WASM `query` | n/a | Already Rust-only. Keep it that way. |

Pattern: every must-match twin that has a *shared file* fixture (genesis) is stable; the ones
with inline copies (commit bytes, RBSR, drive hash) have already drifted or gone one-sided.
The Rust `Db` already emits `DbEvent` (`lib/src/db.rs:104`, `subscribe_events` :1829) and
has a policy struct for ingest (`CommitIngestOpts`, `lib/src/sync/engine.rs:294`); the
missing piece is a named surface over them.

## Options

| | A. Twinned-by-design | B. Rust-only | C. Rust-authoritative + gated pure twins |
| --- | --- | --- | --- |
| What | Both libs implement protocol, verify, authorize; parity by golden tests | All protocol/verify/apply/sync in `atomic_lib`; TS is `ClientDb` glue + React cache | Rust owns verify/authorize/ingest/sync/hash/genesis; TS owns cache, reactivity, TipTap doc, signing UX; twins only for pure byte-producing functions with a `testdata/` fixture |
| Cost vs shipped code | Must add verify + hierarchy + ingest to TS (~2k lines that Rust already has); no gate exists, drift already observed | Every `Resource.get` crosses WASM: ~1000× slower (#1278); TipTap still needs a second `loro-crdt` heap; Ed25519 sign must move into a Worker | Matches what is shipped: TS already never verifies; WASM already applies. Work is a named `AtomicNode` slice + 4 fixture files |
| SDK story | Python/Kotlin/Flutter each re-wrap `Db` (status quo, 3 surfaces) | One surface | One surface |
| Verdict | Reject: doubles the trusted computing base and has no gate | Reject for reads; correct for writes/sync | **Adopt** |

## Recommendation

Adopt **C**. The rule, quotable:

> **Rust decides; TS displays. Anything that verifies, authorizes, persists, or syncs lives once in `atomic_lib`. A TS copy is allowed only for a pure function whose output is pinned by a shared `testdata/` fixture and that passes the #1273 bind-twins gate. New SDKs bind `AtomicNode`, never `Db`.**

Ownership:

- **Rust (`lib/`)**: commit ingest and signature/timestamp/previous-commit verification
  (`lib/src/commit.rs`, `lib/src/sync/engine.rs`), authorization (`lib/src/hierarchy.rs`),
  sync/RBSR (`lib/src/sync/`), canonical hashing (`engine.rs::compute_drive_hash`,
  `rbsr.rs`), genesis certs (`lib/src/genesis.rs`), query evaluation
  (`lib/src/db/query_index.rs`), Loro persistence.
- **TS (`browser/lib/`)**: `Store`/`Resource` cache, subscriptions, outbox scheduling, React
  reactivity, TipTap `LoroDoc`, key custody + signing via `SubtleCrypto`, JSON-AD adapter
  parsing. `canWrite` is a hint.
- **Twins (pure, fixtured)**: commit canonical bytes, genesis cert bytes, RBSR fingerprint,
  drive hash, datatype tag, WS frame encoding, auth header string, search escape, plugin
  planner. Each needs one file under `testdata/` loaded by both test suites, the way
  `lib/src/genesis_test_vectors.json` and `testdata/pairing-request.json` already do.
- **Not twins**: applying/verifying commits, rights, sync state machines, query planners,
  anything that writes.

### First `AtomicNode` slice

Module `lib/src/runtime/node.rs` (`pub mod runtime` in `lib/src/lib.rs`). No behavior change:
every method delegates to code that exists today.

```rust
pub struct AtomicNode { db: Db, agent: Option<Agent> }

pub enum IngestPolicy { Hub, Peer, Replica, LocalCache }   // LocalCache = today's WASM opts

impl AtomicNode {
    /// Db::init_redb / init_redb_file / init_redb_opfs (lib/src/db.rs:474, :506, :714)
    pub async fn open(cfg: NodeConfig) -> AtomicResult<Self>;
    /// Storelike::get_resource_extended (lib/src/storelike.rs:489) with ForAgent
    pub async fn get(&self, subject: &Subject, for_agent: &ForAgent) -> AtomicResult<ResourceResponse>;
    /// Storelike::query (lib/src/storelike.rs:651)
    pub async fn query(&self, q: &Query) -> AtomicResult<QueryResult>;
    /// sync::engine::ingest_commit_json (lib/src/sync/engine.rs:327) + CommitIngestOpts (:294)
    pub async fn apply_commit(&self, commit_json: &str, policy: IngestPolicy) -> AtomicResult<CommitResponse>;
    /// CommitBuilder::sign (lib/src/commit.rs:1299) then apply_commit(Hub) — replaces Resource::save_locally (lib/src/resources.rs:1178)
    pub async fn mutate(&self, edit: ResourceEdit) -> AtomicResult<CommitResponse>;
    /// Db::subscribe_events (lib/src/db.rs:1829); DbEvent (lib/src/db.rs:104)
    pub fn subscribe(&self) -> broadcast::Receiver<DbEvent>;
    /// sync::peer::sync_drive_with_peer_outcome (lib/src/sync/peer.rs:1343)
    pub async fn sync_with_peer(&self, node_id: &str, drive: &Subject) -> AtomicResult<PeerSyncOutcome>;
}
```

`IngestPolicy::LocalCache` gives the WASM path a name instead of the ad-hoc `CommitOpts` in
`wasm/src/lib.rs:195`; #1274 says "WASM `applyCommit` is **not** folded in (signature off — a
fourth policy)". Naming it is the fold. Deliverable includes one in-memory smoke test
(open, mutate, query, get, subscribe) and the #1273 measure script over `wasm/src/lib.rs`
showing `ClientDb` shrinking.

### Sequencing

1. Merge #1273 (contract) and #1274 (ingest policies). Add the "pure function" clause to
   `consolidation-contract.md` kind 3.
2. Land `lib/src/runtime/node.rs` as above. `wasm/src/lib.rs` `ClientDb::applyCommit` calls
   `node.apply_commit(_, LocalCache)`.
3. Fixtures: `testdata/commit-canonical.json`, `testdata/rbsr-fingerprint.json`,
   `testdata/drive-hash.json`, `testdata/datatype-tags.json`. Move the inline hex in
   `rbsr.test.ts`, `canonical-drive-hash.test.ts`, `sign.test.ts` and the Rust twins onto them.
4. `ffi/` (#1277) and `python/` call `AtomicNode`; `flutter/rust/src/api/simple.rs` store
   group calls `AtomicNode`, canvas functions stay FRB-specific.
5. `server/src/handlers/commit.rs` → `node.apply_commit(_, Hub)`
   ([`atomic-lib-runtime.md`](./atomic-lib-runtime.md) Phase 2).
6. Only then: `AtomicNode::sync_with(transport)` in WASM, after which `rbsr.ts` and
   `canonical-drive-hash.ts` become deletable (kind 1, lines must drop).

## Consequences for open PRs

- **#1278** (duplication analysis): merge-as-is. Its "must-match ~1.5–2.5k lines stays JS" and
  "do not move `Resource.get` into WASM" are adopted here; link
  `planning/ts-wasm-duplication.md` to this decision.
- **#1273** (contract + measure script): merge-as-is, then add one sentence to kind 3:
  twins must be pure functions (no I/O, no verification, no writes).
- **#1274** (ingest policies, bind-twin fixtures): merge-as-is. `CommitIngestOpts::{hub,peer,replica}`
  becomes `IngestPolicy`; add `LocalCache` in the `AtomicNode` PR, not here.
- **#1277** (Python + Kotlin SDKs): change. Do not ship two more `Db` wrappers
  (`python/src/store.rs`, `ffi/src/store.rs`). Rebase after sequencing step 2: `ffi/`
  becomes UniFFI over `atomic_lib::runtime::AtomicNode`; Python is a PyO3 skin over the
  same. Its `planning/kotlin-sdk.md` already states this target. No `simple.rs` in the diff
  (verified); the `ffi/` surface is the concern.
- **#1241** (Flutter SDK packaging): merge-as-is (packaging, CI, docs). Its follow-up
  "generic query/blobs bridge APIs" must be `AtomicNode` bindings, not new `simple.rs`
  functions; `simple.rs` is already 1444 lines.
- **#1307** (plugins, two planners): planner twin passes the rule (`testdata/plugin-plans/`,
  both suites load it). Applier does not: `plugin-apply.ts` (487) and `apply.rs` (879)
  are two write paths. Change: the TS applier must reduce to ordinary `Resource.save()` calls
  (unverified whether it already does) or be dropped in favour of the server applier via
  `apply_commit(Hub)`. `store_host.rs` writes must go through `ingest_commit_json`, so
  rebase-after-#1274.
- **#1313** (commits as envelopes): touches `lib/src/commit.rs` and `browser/lib/src/commit.ts`
  together. Change: it must ship `testdata/commit-canonical.json` (sequencing step 3),
  since the commit-bytes twin currently has no shared pin.
- **#1311** (CRDT list append/remove/move): touches `lib/src/loro.rs` and `resource.ts`
  list semantics with no fixture. Change: add a `testdata/` fixture for list-merge results
  or make TS delegate to the WASM node for these operations.
- **#1262** (`did:ad:frozen` + `jcs.ts`): a new canonical-bytes twin (`browser/lib/src/jcs.ts`
  vs `lib/src/frozen.rs`) with fixtures under `test-vectors/`. Change: move fixtures to
  `testdata/` so there is one fixture home for the #1273 gate.
- **#1250** (commit perf, Rust-only): merge-as-is; no TS twin needed.
- **#1254** (ACL zones): Rust-only authorization (`hierarchy.rs`, `zones.rs`) — consistent
  with this decision; review on its own merits. Do not add a TS zone evaluator.
