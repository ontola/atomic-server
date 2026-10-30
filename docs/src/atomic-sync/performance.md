{{#title Atomic Sync performance: measurements and remaining work}}
# Sync performance

Sync performance depends on the workload, storage backend, indexing and proof
handling as well as transport. The measurements below concern initial sync into
a fresh native redb receiver. They are diagnostic observations on a shared
machine, not latency guarantees for the browser, SyncD or a deployed service.

## Batching within the existing protocol

A `SYNC_PUSH` can already carry multiple resource entries and multiple signed
envelopes. Each ordinary envelope contains a signed commit for one resource.
Batching their database writes does not require changing this wire format or
the public Atomic Lib API.

[PR #2381](https://github.com/ontola/atomic-server/pull/2381) combines verified
envelope writes and retention deletes with the frame's resource, snapshot and
index transaction. In its matched 10,000-issue experiment, receiver sync fell
from 42.907–43.314 seconds to 33.718 seconds. This was one optimized run between
two controls; all used the same sender and wire bytes. The change is included
in candidate25, but the PR remains open as of 2026-10-30.

**Sharing one signature across multiple resources is a separate proposal. It
requires a protocol extension. The shared-signature results below cannot be
obtained by configuring the current envelope format.**

## Experimental shared signatures: 2026-10-29

The local prototype signs a group of up to 50 independent resource snapshots.
Every resource keeps its own Loro document and identity. A shared proof binds
the drive, signer, timestamp, ordered subjects and exact snapshot bytes. The
receiver retains that proof once, with a reference from each member, in the
same database transaction as the imported projections.

The experiment used candidate25
[`f570405eb`](https://github.com/ontola/atomic-server/commit/f570405eb2ff14570ca26d4e91e82e5dafd338b5),
10,000 issues with 30,900 embedded comments, and 18 supporting resources. The
fixture was 44,560,516 bytes. All runs shared a prepared sender, signing key,
exact snapshot bytes and order, 50-entry transport chunks, and uncompressed
binary WebSocket transport over loopback. All modes used 201 data chunks.

| Envelope format | Receiver sync | Title-search readiness | Application bytes received |
| --- | ---: | ---: | ---: |
| Existing per-resource envelopes, one control run | 38.748 s | 45.373 s | 253.602 MB |
| Experimental format, one resource per signature, two runs | 27.570–30.501 s | 31.871–34.936 s | 214.484 MB |
| Experimental format, up to 50 resources per signature, two runs | 23.057–23.530 s | 27.290–27.633 s | 211.597 MB |

The experimental runs were ordered one/50/50/one. Their median receiver times
were 29.036 and 23.294 seconds: approximately **20% lower with groups of 50**.
This comparison includes the cost of verifying and retaining differently
grouped proofs; it does not isolate cryptographic verification alone.
Batch-signature count fell from 10,018 to 201. The resources' 10,018 identity
certificates remain separate and were verified outside the timed import.

The existing-envelope control is a broader comparison: the prototype also
changes JSON/base64 encoding, proof semantics and storage. Experimental proofs
are uncompressed `PluginMeta` rows, whereas ordinary envelopes use their
existing compact/compressed storage. Receiver database file size was about
1.078 GB for the prototype versus 0.539 GB for the control; these are file
allocation sizes, not logical payload sizes. Do not attribute the entire
38.748-to-23-second difference to sharing signatures.

Receiver timing starts at the initial sync request and ends when native LAST
import/flush returns. Source preparation, signing/framing and verification are
excluded. Title-search readiness is measured separately after import. Normal
close/reopen verified complete fixture values, CRDT state, version vectors,
table membership, search indexes, identity certificates and retained batch
proofs. It does not independently establish syscall completion or crash/power-loss
durability. Two samples per experimental mode are not a statistical guarantee.

The [measurement data](performance/signed-batch-2026-10-29.json) records every
run, host conditions, hashes and verification counts.

### Why this is not a current-protocol optimization

The prototype uses an experiment-only wrapper which existing peers cannot
verify as ordinary envelopes. It attests full resource state and does not
preserve the existing per-commit envelope audit interface. Comparisons exclude
derived `lastCommit` and ordinary envelope identity in experimental modes;
full underlying CRDT state and vectors remain checked.

Production adoption would require capability negotiation and an older-peer
fallback, defined history/retention semantics, proof garbage collection, and
handling of incremental updates and divergent receivers. Forwarding a whole
batch also discloses its other members, so selective resource sharing requires
an explicit disclosure design. The experiment leaves production mutation
authorization and tombstones unchanged. It is not enabled in candidate25 and
does not change SyncD's source-side creation path.

## Joep's initial-sync investigation: 2026-10-29

Joep reported a separate in-process, single-threaded benchmark on four
2.1 GHz Xeon cores using a release build. His notes describe the source as
`develop` after envelope batching, but do not provide an exact commit SHA.
The harness, `lib/benches/sync_import_bench.rs`, had not been pushed with the
report and is not included in this documentation PR. These are reported
measurements, not independently reproduced results. They exclude network,
WebSocket/TLS, client-side SYNC hashing and browser/OPFS costs.

### Reported flat-drive timings

All values below are milliseconds. Import phases are reported separately;
the search check follows import.

| Resources | Sender reconcile | Total import | Per-entry loop | Persist/index | Envelope import | Search |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 670 | 3,344 | 381 | 634 | 2,294 | 48 |
| 5,000 | 4,150 | 22,872 | 2,055 | 4,497 | 16,142 | 203 |
| 10,000 | 8,719 | 53,369 | 4,958 | 10,426 | 37,602 | 384 |

Reconcile plus import plus search totals approximately 4.1, 27 and 62 seconds.
A nested layout with N resources in one folder and roughly 50 elsewhere was
reported to be about 13% slower. At 1,000 resources, Joep's wire-size comparison
reports 6.2 MB versus 2.3 MB of snapshots and identifies envelopes as duplicated
payload; the notes do not give a complete byte accounting. Equal-state resync still
cost roughly 0.5 seconds per 1,000 resources in per-resource VV comparison.

Envelope import accounts for about 70% of the 10k import time and grows about
16.4 times for a tenfold resource increase. Joep suspects a repeated scan in
`envelopes_checked` or `resolve_retention`; that cause is **not confirmed**.
Persist/index work accounts for about 20% and the per-entry loop about 9%.
Sender reconciliation costs about 0.9 ms per resource at 10k, with
`build_drive_vvs`, resource reads and per-subject read checks identified as
investigation targets. Joep did not identify per-entry tracing or Loro loads
as the dominant cost in this workload.

To reproduce once the harness and exact source revision are available, his
reported command is:

```sh
BENCH_N=1000,5000,10000 BENCH_LAYOUT=flat,nested cargo bench -p atomic_lib --bench sync_import_bench --features db-redb
```

The different fixtures, hardware, revisions and timing boundaries prevent a
direct speed ratio against the WebSocket measurements above. Recover the
harness, source SHA and envelope-batching implementation before combining
these profiles or attributing the scaling to a particular function.

### Proposed follow-ups, in Joep's priority order

| Proposal | Protocol/storage boundary and validation |
| --- | --- |
| Make envelopes opt-in during sync | Joep reports this as a decided direction being built, with a request flag and no envelopes by default. It changes sync behavior and requires protocol/compatibility work; this PR does not implement or establish its availability. Define older-peer behavior and which provenance/history guarantees remain when envelopes are omitted. |
| Fix superlinear envelope work, then batch verification with cached signer lookups | A candidate within the existing protocol and storage format. First isolate prefix scans, ancestor walks, parsing, verification and transactions at 1k/5k/10k on a pinned revision. Preserve signature rejection, inherited audit retention, unreadable rows and exact retained proofs. Scope signer caches to a batch and preserve key-resolution rules. Existing write batching is tracked separately in #2381. |
| Cold-start fast path | Potentially internal, but an apparently empty receiver does not establish exclusive ownership. Avoid redundant reads/merges only when their absence is proven; preserve concurrent-write locking, admission/authorization, identity validation and the final durable acknowledgment. Compare bounded batches with a single transaction, including memory and writer contention. |
| Defer derived rows and indexes until after bulk writing, possibly in parallel | Scheduling may be internal, but rows, query indexes and search results become available at different times. Define readiness and persist resumable rebuild work; test restart, concurrent edits, notifications and complete query/search results. Do not silently weaken the current transaction or acknowledgment contract. |
| Stream a compressed pack from the `LoroSnapshots` tree with drive-level authorization | Requires a transport/protocol and authorization design; it is not an existing-protocol optimization. Prove access equivalence before replacing per-resource read checks. Joep's approximately 1 s estimate for 10k issues (23 MB, roughly 5 MB with zstd) is a theoretical target, not a measured implementation. |
| Merkle/nested hashing and top-layer-first nested sync | A protocol/manifest design for comparing roots and transferring differing branches. Define hash inputs, invalidation, filtered access and compatibility; the equal-state resync measurement motivates it but does not establish a gain. |

Joep estimates roughly threefold faster import without envelopes and suggests
later steps could approach a reported 3.5 s Jazz result. Those are projections,
not matched measurements. Omitting provenance verification/retention changes
the work performed; the notes do not establish that Anytype or Jazz never
performs equivalent work. Keep those comparisons separate from improvements
that preserve Atomic's current protocol and guarantees.

## Remaining candidates without a wire-format change

The optimized importer profile at `8ffbc40b9` provides concrete leads, but it
predates candidate25's flush correctness fix. Its instrumented run took
34.774 seconds while controls took 39.458 and 46.216 seconds. Category timings
are foreground elapsed time, including waits; they are not isolated CPU costs
or promised savings. Re-profile the intended shipping revision before changing
these paths.

| Candidate | Evidence | Decision and required validation |
| --- | --- | --- |
| Profile envelope scaling and reuse batch-local validation work | Joep reports envelope import at 37.602 s of 53.369 s for 10k resources and superlinear growth; the cause remains unconfirmed. | Highest-priority investigation in his workload. Separate scans, ancestry, schema/signer reads, verification and writes on the intended revision; preserve inherited retention, signatures and exact proofs. See his follow-ups above. |
| Reuse Loro state during import, envelope staging and full-text extraction | 50,240 snapshot loads took 2.725 s and 50,133 exports took 2.329 s. Full-text extraction accounted for 20,036 loads and 1.015 s; envelope staging for 10,061 loads and 0.576 s. | A bounded implementation experiment alongside envelope profiling. Pass already loaded state or extracted text through the pipeline where ownership permits. Deferred because no matched implementation trial has established a gain; preserve rich text, full state/history, signatures and every query/search result. |
| Coordinate the importer with periodic durable flushing | Database work and waits totaled 16.279 s, including 7.324 s beginning writes. A separate stack sample observed importer lock waits alongside a flushing thread. | Investigate scheduling/coalescing on the newer flush implementation. The sample does not attribute all waiting to flushing. Deferred pending a current profile and concurrency/error tests; retain the covering durable acknowledgment and retry behavior. |
| Avoid redundant storage encoding or tune existing compression | 30,054 deflate calls took 4.444 s in the profile. | Potential internal optimization, independent of wire envelopes. Deferred pending CPU, file-size and memory measurements; preserve codec readability, stored data and crash recovery. |
| Evaluate initial Loro export choices | New-resource envelopes currently carry full snapshots, including history and current state. | An operations-only export might trade fewer bytes for more replay work. Unmeasured; verify existing receiver compatibility and history/identity behavior before treating it as an available optimization. |

These are investigation candidates, not implemented performance improvements.
No benchmark in this work establishes a protocol-compatible route to a
12-second initial sync.

## Findings and disposition

Status checked on 2026-10-30. This records completed work and deferred work so
that stopping the experiment does not imply that every proposal shipped.

| Finding | Disposition |
| --- | --- |
| Resource/index transaction batching and per-envelope transaction overhead | Prepared projection batching was reused; envelope batching was implemented and tested in [#2381](https://github.com/ontola/atomic-server/pull/2381), included in candidate25. The PR is still open. Public API and wire format remain unchanged. |
| Source-inferred concurrent-flush acknowledgment race [#2378](https://github.com/ontola/atomic-server/issues/2378) | The fix proposed in [#2380](https://github.com/ontola/atomic-server/pull/2380) landed through batch commit [`49d21e08f`](https://github.com/ontola/atomic-server/commit/49d21e08f7a0851c7db18af404b9be318d311030). Candidate25 and develop serialize flush attempts and restore dirty state on errors. The issue remains open administratively; this is not an outstanding implementation proposal. Early-error fault injection was not included in that fix's coverage. |
| Repeated Loro work, writer waits and compression cost | Profiled and documented above; deferred, with correctness gates and no claimed speedup. |
| Repeated snapshot payload on the wire | 10,017 of 10,018 decoded envelope updates matched separately transmitted snapshots byte-for-byte in the optimized profile. A representation that transmits the bytes once while reconstructing exact signed bytes needs a separate protocol/compatibility design; deferred. No signatures or history were removed to claim a current-protocol gain. |
| Shared signatures for 50 resources | Locally prototyped and measured above; deferred from production because protocol negotiation, historical proof semantics and selective forwarding remain unresolved. |
| Raw redb dump/restore as a shortcut | A 198.321 MB dump of 432,954 already-built rows restored in 3.984–4.662 s using 245 non-durable batches and a final durable commit; one large transaction took 8.027–9.364 s. This bypasses CRDT/schema/proof processing, compression and index construction. It is a diagnostic, not a replacement sync path; the slower large commit's cause was not established. |
| Making every batch durable | 245 Immediate transactions took 5.229 s versus 4.655–4.836 s for controls with one final durable barrier. This raw-row experiment does not explain the importer's full database cost or justify weakening durability; no production policy change was made. |
| Any-sync comparison | The approximately 12 s title-search result belongs to the native `record_trees` adapter, not the complete Anytype application. It is not directly comparable to Atomic's import-only timer; no claim of application-level parity is made. |
| Candidate25 release readiness | Branch `claude/atomic-plugins-pin-candidate25` was published at `f570405eb`. Its [exact-commit CI run](https://github.com/ontola/atomic-server/actions/runs/40885424999) failed; it must not be described as CI-green or release-ready. See the release follow-up below. |

### Release follow-up

The candidate25 run failed in the main Dagger CI job at
`tests::version_endpoints`: `/all-versions` returned HTTP 404. Its fail-fast
summary reports 1,092 of 1,766 tests not run. The downstream log reports
`profile.dev` differing between Server and SaaS. These failures concern the
version endpoint and cross-repository build alignment; they were not repaired
as part of the sync-performance experiment. Their exact causes and fixes need
separate release validation, rather than assuming that rerunning or the local
benchmark establishes readiness. No merge, live pin advancement, or production
deployment is implied by this performance report.

For protocol details, see [drive reconciliation](drive-reconciliation.md) and
the [wire reference](../websockets.md#sync_push-chunking-and-acknowledgement).
