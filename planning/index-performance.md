# Query & Index Performance

> **Status:** Diagnosis (2026-07-24). A comparative benchmark against NextGraph
> surfaced collection queries as disproportionately slow. Root-caused to two
> independent issues in the read/query path; one fix shipped, the structural
> fix for the other is already designed in [`zones.md`](./zones.md) but not yet
> built. Related: [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md)
> (write-path / on-disk growth — this doc is the read-path counterpart) and
> [`authorization-sync.md`](./authorization-sync.md) (the rights model this
> doc's permission-check cost is part of).

## Thesis

A 1000-resource collection query costs **~100 microseconds of real server-side
work per matching resource**, and that cost scales linearly with match count —
confirmed empirically, not assumed. Two independent causes:

1. Every matching resource is **fully materialized** (a complete Loro CRDT
   decode) even when the client only asked for a bare list of subject URLs.
2. The **permission check** performed on each of those resources itself does a
   second full resource decode (the drive resource, to evaluate rights), and
   falls back to a recursive parent walk on denial.

Neither is a JSON/HTTP/pagination artifact — both were isolated and confirmed
at the Rust level, independent of the client or the network.

## Benchmark context

An external comparative benchmark (`@tomic/lib` vs. the NextGraph JS SDK,
1000 resources, create/edit/history-traversal/query, both against local
servers) flagged the asymmetry: a single query fetching all 1000 members of a
collection took ~130–160ms, vs. ~6ms for NextGraph's equivalent SPARQL query
over its "entire user site" scope. Caveat carried over from that benchmark:
NextGraph's data model is per-document CRDT branches, not one global store, so
this is not a fully apples-to-apples comparison of index architectures — but
the absolute cost on the atomic-server side turned out to be real and
independently reproducible regardless of what NextGraph is doing.

## Benchmarking methodology (how these numbers were produced)

Three different measurement layers were used, each to answer a different
question. Recording the exact method here so any of this is reproducible and
so future measurement doesn't repeat the mistake noted below.

1. **External HTTP-level harness** (outside this repo, in the sibling
   `atomic-nextgraph` project's `benchmark/atomic/bench.mjs`): drives a real
   local `atomic-server` release build over plain HTTP via `@tomic/lib`,
   timing four phases at N=1000 — sequential create, sequential edit,
   commit-history traversal for a 100-resource sample (each given 5 extra
   edits first), and a `CollectionBuilder` query fetching all matches. This is
   the layer that first surfaced the asymmetry and that produced the
   NextGraph comparison numbers. It answers "what does a real client
   observe."
2. **Rust-level Criterion benchmarks** (`lib/benches/lifecycle_bench.rs`, new
   in this pass — run with `cargo bench -p atomic_lib --bench lifecycle_bench
   --features db-redb`): the same four phases, but calling `Db`/`Resource`
   directly with no HTTP, no actix, no JSON. This isolates library-level cost
   from network/webserver overhead, and is what let finding 2's fix be
   verified independent of the HTTP layer's noise.
3. **Targeted diagnostic HTTP probes** (ad hoc, not committed — see below):
   small scripts that varied one variable at a time against a live server to
   attribute the ~130ms query cost to a specific cause rather than guessing.
   Two were used for finding 3:
   - A **zero-match query** (`.setValue('https://doesnotexist.example/nothing')`)
     to isolate fixed per-request overhead (connection, auth, JSON parsing)
     from per-member cost. Result: ~1.7ms warm — ruling out fixed overhead as
     the story.
   - A **`page_size` sweep** (30 default / 100 / 1000 / 2000) on the same
     1000-match query, to isolate pagination round-trip count from per-member
     server cost. Result: single-page (`page_size=1000`) still cost
     ~101–107ms vs. ~125ms at the default `page_size=30` — pagination is a
     ~15–20ms factor, not the ~100ms+ story.
   These two probes together are what pinned the cost to genuine O(N)
   per-member server work rather than transport or pagination artifacts.

**Methodology pitfall worth flagging for future measurement passes:** an
earlier before/after comparison (superseded, see finding 2) computed its
"before" by diffing against a *stale historical benchmark run* instead of a
freshly re-measured baseline on the same machine state — same code path,
different point in time, different system load. The deltas looked plausible
(create −14.8%, query −16.3%) but weren't a controlled comparison. Caught by
noticing the "before" JSON was byte-identical (down to floating-point noise)
to a run from hours earlier. Fixed by re-measuring both sides back-to-back
(`git stash` the change under test → build → benchmark → `git stash pop` →
build → benchmark again), on identical data-dir/config setup, same session.
**Any future before/after claim in this codebase should use that paired
protocol, not a diff against an old results file.**

## Finding 1 — vector search indexed every write by default (fixed)

Semantic search (fastembed/ONNX embeddings + LanceDB) ran on every commit,
unconditionally, before this fix. Now opt-in via `--enable-vector-index` /
`ATOMIC_ENABLE_VECTOR_INDEX` (default off). See `server/src/config.rs`
(`enable_vector_index` / `skip_vector_index`), `server/src/vector_search/enabled.rs`,
`server/src/serve.rs`. Loading embedding models and writing to a second store
on every plain edit has a real cost that most deployments don't need; it's
now a deliberate choice.

## Finding 2 — redundant Loro snapshot re-export on every read (fixed)

`Db::get_resource()` read a resource's Loro snapshot from disk, imported it
into a `LoroDoc`, then called `apply_state_doc(doc)`, which **unconditionally
re-`export_snapshot()`s** the doc it had just imported — re-serializing bytes
the caller already held, on every single read. On a collection query this was
paid once per member.

Fix: `apply_state_doc_with_snapshot(doc, snapshot)` reuses the bytes already
in hand instead of re-exporting (`lib/src/resources.rs`, `lib/src/db.rs`).
27 lines, no other call sites affected.

**Verified impact** (controlled, paired before/after per the protocol in
"Benchmarking methodology" above — the naive diff-against-an-old-run version
of this comparison overstated the effect, see that section): create sees no
measurable benefit (~0%, within noise — create is write-dominated, not
read-dominated); edit **−11%**; history traversal **−12%**; a 1000-member
collection query **−7.7%** (median 142.2ms → 131.2ms). Modest, real, but
nowhere near enough to close the gap with NextGraph — expected, since this
only removes one redundant serialization, not the per-member decode itself.

## Finding 3 — collection queries fully materialize every match, even when only subjects are requested (not fixed)

`lib/src/db/query_index.rs:546`:

```rust
pub fn should_include_resource(query: &Query) -> bool {
    query.include_nested || query.for_agent != ForAgent::Sudo
}
```

`ForAgent::Sudo` is an internal-only bypass; every real, authenticated HTTP
request is `ForAgent::Agent(...)`, so this is `true` for every real client
regardless of whether it set `include_nested`. `query_basic`
(`lib/src/db.rs:1835`) therefore calls `get_resource_extended` — a full
`get_resource` (Loro decode) plus a full permission check plus a class-extender
scan — for **every** matching subject, sequentially, in a plain `for` loop
with no concurrency, then throws the materialized resource away if the client
only wanted its URL.

**Empirical confirmation** (isolated from pagination and fixed per-request
overhead by direct measurement against a live server):

| Query shape | Result | Time |
| --- | --- | --- |
| 0 matches (isolates fixed per-request overhead) | 0 members | ~1.7ms (warm) |
| 1000 matches, single page (`page_size=1000`, one round trip) | 1000 members | ~101–107ms |
| 1000 matches, default `page_size=30` (34 round trips) | 1000 members | ~125ms |
| 1000 matches, `page_size=100` (10 round trips) | 1000 members | ~93ms |

Pagination (default client `page_size` is 30 — `browser/lib/src/collectionBuilder.ts:9`)
only accounts for ~15–20ms of the gap, not the dominant factor. The
~100–105ms remaining, even in a single round trip, is genuine O(N) per-member
server work: ~100 microseconds/member.

`Db::get_resource_shallow` (`lib/src/db.rs:1531`) already exists, is fully
built, and its own docstring says exactly this:

> \[the Loro decode\] can cost tens of milliseconds each — fine for a single
> fetch, ruinous when a directory listing reads hundreds of resources just to
> project their names and sizes.

It is **completely unused** — never wired into `query_basic` or
`query_sorted_indexed`. It wasn't adopted directly in this pass because
`Tree::Resources` (propvals) and `Tree::LoroSnapshots` are *usually* kept in
sync by `add_resource_tx`, but every write path (sync/WS merge, iroh) wasn't
fully verified to preserve that invariant, and the function's own docstring
warns "do not use this where CRDT-authoritative state matters." Query listing
is exactly the case it was built for, but wiring it in needs that invariant
confirmed first.

## Finding 4 — permission check re-fetches the drive resource per member (not fixed; `zones.md` is the designed structural fix)

`lib/src/hierarchy.rs:229-238`, inside `check_rights` (called once per member
via finding 3's `get_resource_extended`):

```rust
if let Ok(drive_val) = resource.get(urls::DRIVE_PROP) {
    let drive_subject = crate::Subject::from(drive_val.to_string());
    if let Ok(drive_res) = store.get_resource(&drive_subject).await {
        // full Loro decode of the drive resource, on every check
```

This is a second full resource decode per member (the drive, not the member
itself), with a recursive parent walk as fallback on denial. For a 1000-member
query this compounds finding 3: up to 1000 additional full decodes purely for
authorization, with no caching across the request.

This is precisely the problem [`zones.md`](./zones.md) (proposal,
2026-07-17, not yet built) is designed to remove. Its impact inventory states
it directly:

> `check_rights` becomes walk-free: preludes (sudo/server/self/commits) →
> zone lookup → ACL check. Drive fast-path, recursive walk, and 401-cascade
> warn deleted.

The zones proposal replaces today's "rights can live on any resource,
requiring a walk" model with a locally-maintained derived index
(`subject → zone`), making a permission check an index lookup instead of a
resource fetch. That's a large migration (new index in Rust + browser TS,
`lib/src/sync/engine.rs` zone-scoped BFS, `lib/src/sync/policy.rs` admission
re-keying, query index drive-scoping, share UI, invites) — see that doc's own
impact inventory and migration plan; not repeated here.

**Open question this doc adds to `zones.md`'s list:** once the zone index
exists, does it also let `query_basic` skip `get_resource` entirely for the
subjects-only case (finding 3), not just make `check_rights` cheaper (finding
4)? If a permission decision can be made from the zone index alone, without
touching the member resource at all, findings 3 and 4 collapse into a single
fix rather than two.

## Other levers noted, not pursued this pass

- **No concurrency across members.** `query_basic`'s loop `await`s
  `get_resource_extended` one member at a time. Current work is CPU-bound
  (KV reads are local, not network I/O), so async concurrency alone won't
  help without also spreading work across threads (e.g. rayon) — noted, not
  attempted.
- **Per-KV-call transaction overhead.** `KvStore::get()` opens a fresh
  `begin_read()` transaction per call (`lib/src/db/redb_store.rs:270`); a
  collection query does ~2 KV gets per member (propvals + snapshot), each in
  its own transaction. Batching reads into one shared transaction per query
  is plausible but requires a `KvStore` trait change touching all three
  backends (redb/sled/btreemap).
- **Class-extender scan per member** inside `get_resource_extended` — cheap
  when no extenders are registered, non-zero when they are; not measured in
  isolation.

## Recommendations (rough ROI order)

1. **Request-scoped drive-resource cache** (stopgap for finding 4): memoize
   the drive resource fetch for the lifetime of one query call. Small,
   contained change in `query_basic`/`hierarchy.rs`, captures a real slice of
   the N+1 cost without waiting on the zones migration.
2. **Verify the `Tree::Resources` / `Tree::LoroSnapshots` sync invariant**
   across all write paths (sync, WS merge, iroh), then wire
   `get_resource_shallow` into `query_basic`/`query_sorted_indexed` for the
   subjects-only case (finding 3). Highest single-fix ROI once the invariant
   is confirmed safe.
3. **Build the `zones.md` zone index** — the structural fix for finding 4,
   and (per the open question above) possibly for finding 3 as well.
4. **Batch KV reads per query into one transaction** instead of one per
   member (needs the `KvStore` trait change).
5. **Bounded parallelism across members**, once/if per-member cost is low
   enough that thread-spreading (not just async concurrency) is worth the
   complexity.

## Benchmark plan (next steps for measurement, not just fixes)

Each recommendation above needs its own measurement to confirm it did what it
claims, and the diagnostic probes used for finding 3 were throwaway scripts,
not committed — turning them into permanent benchmarks is itself part of the
plan, not an afterthought:

1. **Promote the finding-3 diagnostic probes into `lib/benches/lifecycle_bench.rs`.**
   A zero-match query case and a page-size/limit sweep, as committed Criterion
   benchmarks, so the O(N) per-member cost is tracked over time instead of
   re-discovered by hand each time someone asks "why is query slow."
2. **Add a permission-check-only benchmark** isolating `check_rights` cost
   in isolation from `get_resource` (e.g. query a pre-warmed resource so the
   member decode is cached/cheap, vary only the rights-check depth: root,
   1-level-nested, deeply-nested-with-parent-walk). This is what would
   validate recommendation 1 (request-scoped drive cache) and, later,
   recommendation 3 (zone index) — right now findings 3 and 4's costs are
   measured together, not separately.
3. **Add a shallow-vs-full-decode benchmark** for `get_resource_shallow` vs.
   `get_resource`, once recommendation 2's sync-invariant question is
   resolved — this is the number that would justify wiring it into
   `query_basic`, and should exist *before* that change lands, not after, so
   the improvement is measured rather than assumed.
4. **Re-run the full external HTTP benchmark (`atomic-nextgraph/benchmark`)
   and the NextGraph comparison** after each structural fix (findings 3, 4,
   and eventually the zones migration) to track whether the gap to NextGraph
   actually closes, not just whether the Rust-level micro-benchmark improves —
   a library-level win doesn't automatically mean the end-to-end number moves
   by the same amount (see finding 2, where an 11-13% Rust-level gain via
   Criterion showed as an even smaller HTTP-level gain).
5. **Test at larger N** (10k, 100k members) once any of findings 3/4 are
   fixed, to check whether the remaining per-member cost is genuinely
   constant or degrades further at scale (e.g. redb transaction contention,
   index iterator cost) — 1000 was chosen for benchmark turnaround time, not
   because it's representative of a real large collection.
6. **Consider a CI perf gate** once `lifecycle_bench.rs` covers the cases
   above: fail (or at least flag) a PR that regresses create/edit/query
   Criterion numbers by more than some threshold, so a future change doesn't
   silently reintroduce a per-write or per-read cost the way vector-search
   indexing did (finding 1) before this investigation caught it.

## Benchmark numbers (reference)

Controlled, paired, same machine, vector search off in both (finding 2's fix
isolated):

| Phase | Before | After | Δ |
| --- | --- | --- | --- |
| create (1000, HTTP) | 3.470ms/op | 3.479ms/op | ~0% |
| edit (1000, HTTP) | 3.323ms/op | 2.957ms/op | −11% |
| history (100×6 commits, HTTP) | 1.418ms/op | 1.243ms/op | −12% |
| query (1000 members, HTTP, median) | 142.2ms | 131.2ms | −7.7% |

Original baseline, for context (vector search **on** by default, pre-any-fix):
create 3.907ms/op, edit 3.723ms/op, history 1.431ms/op, query median 158.7ms.

NextGraph comparison (same 1000-resource benchmark, own local `ngd` broker,
caveats on data-model mismatch noted above): create 14.53ms/op (slower — its
own per-doc-repo creation cost), edit 2.10ms/op, history 0.277ms/op, query
median ~6.4ms (SPARQL over `entire_user_site()`).

## Open questions

- Does the `zones.md` zone index, once built, let a permission decision be
  made without *any* resource fetch — collapsing findings 3 and 4 into one
  fix? (Added to `zones.md`'s own open-questions list.)
- What's the exact per-member cost split between Loro decode, the drive
  permission fetch, and the class-extender scan? Not isolated with tracing
  spans/flamegraph in this pass — would sharpen prioritization between
  recommendations 1 and 2.
- Is ~100 microseconds/member (post finding-2 fix, pre findings 3/4 fix)
  acceptable at realistic list sizes, or does the target need to be
  materially lower even after the zones fix lands?

## Code references

- `server/src/config.rs` — `enable_vector_index` / `skip_vector_index` (finding 1).
- `server/src/vector_search/enabled.rs`, `server/src/serve.rs` — vector search
  gating and rebuild-index warning (finding 1).
- `lib/src/db.rs:2546-2560` (`get_resource`), `lib/src/resources.rs`
  (`apply_state_doc` / `apply_state_doc_with_snapshot`) — finding 2's fix.
- `lib/src/db.rs:1531` (`get_resource_shallow`, unused) — finding 3.
- `lib/src/db.rs:1835` (`query_basic`), `lib/src/db/query_index.rs:546`
  (`should_include_resource`) — finding 3.
- `lib/src/hierarchy.rs:229-238` (`check_rights` drive fast-path) — finding 4.
- `lib/src/db/redb_store.rs:270` — per-call KV transaction overhead.
- `lib/benches/lifecycle_bench.rs` — new Criterion benchmarks (create/edit/
  history/query, N=1000), for tracking regressions on this class of issue.
- `browser/lib/src/collectionBuilder.ts:9` — client default `page_size: '30'`.
