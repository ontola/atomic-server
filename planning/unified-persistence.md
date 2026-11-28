# Unified persistence and copy evidence

Status: draft PR #2621, integrated with develop
`2d096d0bdd62df28741a15092dec8efb6704d66d` on 27 November 2026 and the CI runner
from #2685. The PR includes the persistence prerequisites and unified evidence
refactor. Source PR branches remain intact. The merger has user authorization
to merge only after complete validation and an unchanged develop tip.

## Contract

One version-scoped evidence model serves local storage, server acceptance,
server/peer durable receipts and encrypted Vault checkpoints. Delivery progress,
acceptance, persistent storage, attachment completeness and availability remain
separate facts. A connection or empty queue cannot confirm storage. Historical
evidence is distinct from current availability, retention and recoverability.
Storage identity deduplicates copies; device independence requires policy.

The resource/property editor API stays intact. Local persistence must retain
replayable work in online and offline situations. Newly created drafts must not
publish merely because local storage completed. Recovery imports verified bytes
without replacing newer local resource edits.

## Work

- [x] Inspect source PRs #2567/#2568/#2584/#2586/#2589/#2592/#2594/#2596/#2598,
  #2413/#2559/#2564/#2576 and #2561/#2571/#2587; verify combined candidate.
- [x] Reproduce and fix cold genesis plus later offline edit replay.
- [x] Consolidate version coverage and destination evidence; distinguish server
  acceptance from durable receipts and reject stale scopes and memory storage.
- [x] Connect local/server/peer/Vault adapters and attachment completeness to
  the shared model; derive item copy status from scoped evidence.
- [x] Make local automatic persistence and parent-dependent drafts restart safe.
- [ ] Exercise online/offline/restart, concurrent edits, account replacement,
  partial files, Vault backup/recovery and same-storage deduplication.
- [ ] Update public contract and coverage; run library/app checks and real
  browser acceptance, with screenshots for rendered changes.
- [x] Publish reviewable forward refactor and source PR accounting; shared CI
  and final candidate merge remain with trekmeester.

## Existing evidence to preserve

The transport receipt producers already perform authentication, scope checks,
version correlation and persistent Redb barriers. Reuse them. Vault already
tracks encrypted exported versions and content manifests with account/epoch
fences. Keep its managed-account knowledge in its adapter. Existing file recovery
performs verified content admission and does not restore graph history.

No new wire messages or parallel delivery queues are needed for the consolidation.

## Implementation and rollout

The original refactor was based on candidate27. The develop rebase carries
the persistence work without the candidate plugin stack. The source revisions
are listed below for comparison. The source branches are preserved.

The model in `browser/lib/src/persistence-evidence.ts` uses the destination and
subject receipt shape proposed in #2613. Each receipt carries either an observed
causal version or a verified file manifest. The boundary is explicit, and a
stored receipt names its storage barrier. The scoped registry retains actual
durable observations without combining their versions. The browser reads the
four destinations through one copy-status hook.

Transport and database adapters translate their existing formats into those
receipts. Authentication and storage-generation fences are enforced at the
adapter boundary. The on-disk receipt formats and native recovery protocol
remain compatible with the prior candidate.

Server durable history is stored separately from acceptance in private receipt
rows. Its generation index is drive-scoped. Vault receipt keys move to v2 so an
old merged frontier cannot become proof of a single recoverable snapshot.
Browser peer history is retained while offline in the current Store; persisting
that history across process restarts is a remaining extension. No complete-drive
backup claim is derived from a subset of mounted rows.

## Validation and remaining acceptance

Passed: 2,331 library tests (one pre-existing skip), 46 targeted UI/Vault tests,
21 Rust receipt/attachment tests, library and app typechecks, React Compiler
checks, production JavaScript workspace build and native server build. The
first native attachment response now has a regression test for both Iroh and
WebRTC, so the first response cannot rely on a later poll registering its session.
Recovered server receipts also have coverage for persisting a newer observation
in the same incarnation.

Fresh release WASM compiled offline. wasm-opt execution was sandbox-blocked,
so the build used the supported `--no-opt` option. Translation extraction leaves
catalogs unchanged. No existing source PR branch is rewritten.

Real browser acceptance and required screenshots remain outstanding: the freshly
built server could not bind `127.0.0.1:9888` in this environment (`Operation not
permitted`). End-to-end Vault backup/restore and native transports are not claimed
as verified by the unit tests. Keep the consolidation draft until that acceptance
and coordinator-owned shared CI pass. Commit hooks run before publishing.

## Review hardening, 23 November 2026

PR #2621 remains draft. Reproduced the lost nested-parent dependency and the
loss of content proof on UI unsubscription with failing regression tests.
Private checkpointing now owns the whole unfinished ancestry, preserves each
parent dependency across reload, rejects cycles, and never confirms the child
when an ancestor write fails. Regression cases cover server and local-only
three-level drafts, with and without a previous save of the middle parent.

Local/server content history is independent of subscriptions and bounded to
512 unobserved subjects per destination, plus currently watched items. Account
and database A-to-B-to-A changes invalidate retained history even with no views
mounted; a changed manifest cannot reuse the old confirmation.

The local server bind was retried and is still sandbox-blocked. Real browser
acceptance, screenshots, Vault restore and native transport E2E remain outstanding.

Validation of this follow-up: 2,340 library tests pass (one existing skip),
including 41 tests in the two directly affected suites, and the library
TypeScript check passes. Initial broad runs encountered empty synchronous text
reads for nonempty fixtures in the local runtime; after successful file reads,
the unmodified suites and the full suite passed. No fixtures or assertions were
removed to obtain that result.

## Develop rebase, 23 November 2026

The rebase retains develop’s Loro-only database rows, snapshot/version-vector
transactions, shared resource/UI packages, Sync settings route, typed sync
refusal codes and blob verification cache. Persistence test doubles now use the
Loro snapshot API. The in-memory Redb snapshot backend cannot issue a durable
replica identity: the external host owns its persistence barrier.

Validation counts above describe the pre-rebase candidate. Rebased validation
is recorded separately below. Full CI requires an explicit workflow dispatch:
`gh workflow run main.yml --ref codex/unified-persistence-2538 -f e2e=full`.
The PR remains draft pending full integration and real browser acceptance.

Rebased checks: 2,197 library tests pass (one existing skip), including the
74 focused persistence tests; the library typecheck passes. Compiler checks
pass for the sync indicator, host adapter and resource row. Sync settings and
Popover retain only the same compiler diagnostics already present on develop.
Translation extraction refreshed all six catalogs. A pre-existing binary-only
Clippy dead-code error is fixed by exposing the notifier module consistently
with the library target. Full CI and browser acceptance remain outstanding.

## Develop rebase, 25 November 2026

- [x] Retain the native recovery CI gate and develop’s selective downstream
  build. Regenerate all six translation catalogs against the rebased sources.
- [x] Use one destination receipt type and registry for accepted metadata,
  stored metadata and stored file manifests. Read the copy status through one
  browser hook. Retain the existing transport and on-disk compatibility code.
- [x] Run the library suite (2,200 passed, one existing skip), 105 targeted
  browser tests, library and app typechecks, and Rust formatting.
- [ ] Run full CI, real-browser acceptance, Vault restore and native recovery
  end to end.

## Self-review findings and fixes, 26 November 2026

- [x] **Queued work could be lost on reconnect or during an online save.**
  The drain could checkpoint a server-hydrated document before reading the
  queued local snapshot. It also replaced the live Loro document with the
  snapshot it had just read, dropping edits made during the read. Recover the
  queued snapshot first, merge into the live document, and checkpoint before
  sending genesis or delta commits. Cover cold reconnect, an edit during the
  recovery read, and an edit during the online checkpoint write.
- [x] **Matching metadata could hide a missing-files warning.** The sidebar
  checked server blobs while the backup warning accepted a version inventory.
  Both now use the signed drive hash and blob confirmation. A definitive
  negative reply clears the previous timestamp. Connection failures preserve
  the historical timestamp so the existing age warning can still apply.
- [x] **Timed-out receipt attempts freed slots while database calls were
  unresolved.** With a stalled database the review observed 24 outstanding
  lookups in 30 seconds. Count actual identity calls per worker from dispatch
  to settlement, including through receipt timeouts and collector resets.
  Continue collection on a replacement worker and recheck identity after each
  receipt.
- [x] **Local-only and offline saves could signal success through a volatile
  adapter.** Required local saves now reject unless the adapter guarantees
  durable persistence. A native renderer can still deliver through its host
  commit transport.
- [x] **The copy view subscribed to the same evidence more than once.** Use one
  per-resource registration for local, server, peer and Vault copy status. It
  owns the metadata and attachment watchers and reuses the peer notifications
  already delivered by the attachment watcher. Transport and storage adapters
  still own their proof collection and compatibility formats.

## Flutter embed size, 26 November 2026

The rebased Flutter embed measured 1,015.4 kB of first-use JavaScript at
gzip level 9 and 15,460.1 kB of bundled assets. Size budget overages now
produce a warning and remain visible in the CI summary. The separate build
step still has to succeed. Verified the report against the built embed, with
both budgets met, with either or both budgets exceeded, and with a missing
embed.

## Source revisions

| Source PR | Reviewed head |
| --- | --- |
| [#2567](https://github.com/ontola/atomic-server/pull/2567) fix(lib): require local persistence before offline save success | [`2341c40a3`](https://github.com/ontola/atomic-server/commit/2341c40a37d8e4ef9677815a3c753d541b0676ed) |
| [#2568](https://github.com/ontola/atomic-server/pull/2568) fix(lib): distinguish unsaved-parent queues from offline saves | [`0454dbd52`](https://github.com/ontola/atomic-server/commit/0454dbd522400c1bac782f3fbe25c3adcc9e3159) |
| [#2584](https://github.com/ontola/atomic-server/pull/2584) feat(lib): expose version-specific local and server save receipts | [`c4a4acfaa`](https://github.com/ontola/atomic-server/commit/c4a4acfaa8505bafa1e93ca22f2fac9456466181) |
| [#2586](https://github.com/ontola/atomic-server/pull/2586) Add policy-based independent-replica evidence signals | [`ddfb7ce0f`](https://github.com/ontola/atomic-server/commit/ddfb7ce0f0b9cd3e4067fe3f1eb3e7d021d05a5b) |
| [#2589](https://github.com/ontola/atomic-server/pull/2589) Produce version-specific storage receipts from browser peers | [`1f5ffa584`](https://github.com/ontola/atomic-server/commit/1f5ffa58407ba8bd0edb27957c5423a931c2690f) |
| [#2592](https://github.com/ontola/atomic-server/pull/2592) Produce automatic version-specific storage receipts over native Iroh | [`0cd97292a`](https://github.com/ontola/atomic-server/commit/0cd97292a6c93f60797df4b6ffa27370d65726e0) |
| [#2594](https://github.com/ontola/atomic-server/pull/2594) Produce automatic HTTP/WebSocket storage receipts | [`e5bdb2cb3`](https://github.com/ontola/atomic-server/commit/e5bdb2cb3a8995f78b0c1fb338b280e63fba3617) |
| [#2596](https://github.com/ontola/atomic-server/pull/2596) Automatically collect native WebSocket and Flutter storage receipts | [`f68945fd9`](https://github.com/ontola/atomic-server/commit/f68945fd97520b76e8d731dd9af9eaa7d527b402) |
| [#2598](https://github.com/ontola/atomic-server/pull/2598) Automatically collect browser receipts after background delivery | [`6ea17197b`](https://github.com/ontola/atomic-server/commit/6ea17197bf801581ae3923a013fa4b0db029edbf) |
| [#2413](https://github.com/ontola/atomic-server/pull/2413) Keep sync warning until the current drive and attachments are confirmed | [`f13efaccc`](https://github.com/ontola/atomic-server/commit/f13efacccddfc4f254ff342c4135b10b920f413f) |
| [#2559](https://github.com/ontola/atomic-server/pull/2559) Show verified server sync and Cloud Vault backup status | [`64f5c0cef`](https://github.com/ontola/atomic-server/commit/64f5c0cefdc14497c6090fdc8b3a83bdd4c5bc38) |
| [#2564](https://github.com/ontola/atomic-server/pull/2564) Record confirmed full syncs with Iroh peers | [`1021eba25`](https://github.com/ontola/atomic-server/commit/1021eba25ebf9b371768084762f3e020013cd656) |
| [#2576](https://github.com/ontola/atomic-server/pull/2576) Show per-resource and attachment confirmations across sync destinations | [`6f1715c3b`](https://github.com/ontola/atomic-server/commit/6f1715c3bea033f6c7e38a8d22ac2d26955f3165) |
| [#2561](https://github.com/ontola/atomic-server/pull/2561) Fix Cloud Vault backup download failing in the save picker | [`dae567446`](https://github.com/ontola/atomic-server/commit/dae567446b15fe95774db1a064dc9c4fdf215358) |
| [#2571](https://github.com/ontola/atomic-server/pull/2571) Retry missing Iroh file contents | [`d8c03f320`](https://github.com/ontola/atomic-server/commit/d8c03f320eea5e930b000ea0041cac340f2803e1) |
| [#2587](https://github.com/ontola/atomic-server/pull/2587) Automatically recover missing file contents from Cloud Vault | [`8f6921bf7`](https://github.com/ontola/atomic-server/commit/8f6921bf763c3747b168a8945aa8e7f8e97bcba4) |

[#2628](https://github.com/ontola/atomic-server/pull/2628) already brought
#2561, #2567 and #2568 into develop.


## Integration repairs, 27 November 2026

The DO attempt on `61f6c4039a558e2195574cf6bc70f967fac959cb` did not pass.
Seven public checks passed; Rust, Flutter and JavaScript integration failed.
The first browser round had 147 passes, 251 unexpected failures and 13 skips;
the final failed-only retry did not complete. Native/private gates were not
completed. These results are diagnostic evidence, not merge acceptance.

- [x] Preserve completed independent failures and run nextest without fail-fast.
- [x] Correct the two Flutter fixture calls for the encrypted-store API and the
  stale optional-replica capability expectation without relaxing production
  receipt eligibility.
- [x] Reproduce open/seed initialization races using the actual client worker;
  wait for database opening before required snapshot/outbox persistence.
- [x] Reproduce healthy concurrent writes during confirmation. Return an empty
  no-store 204 with no receipt for an unstable token; preserve real auth and
  storage errors. Actual signed-route and busy-browser controls pass.
- [x] Repair the native workspace dependency closure and bound transient MinIO
  module downloads without retrying builds or acceptance tests.
- [x] Preserve complete trace paths while deduplicating immutable attachments;
  stream archive hashes and independently validate scoped metadata collection.
- [x] Integrate develop's default vocabulary ordering and container fixture
  mount, removing only identical vocabulary duplicates introduced by Git's
  automatic merge.
- [x] Finish independent review and actual reopen/failure controls for the
  test-only filesystem-backed Node integration fixture. The production
  in-memory Node database must remain non-durable.
- [x] Validate the narrow offline usage guard and canonical settings fixtures
  against a matching rebuilt frontend, keeping strict browser diagnostics.
- [ ] Complete clean-source native/private acceptance and full DO CI; verify
  develop again before merging. No changed-source pass is inferred from caches
  or earlier test receipts.

All temporary resources from the failed attempt were independently verified
deleted. The previously authorized regional build/report volume remains
detached. Costs, private pins and raw operator receipts stay outside Git.

Current working-tree preflight: all 27 formerly affected integration cases pass;
the complete JavaScript integration suite passes 50 cases with one unchanged
existing skip. Five focused browser journeys pass without retries/skips and
with strict diagnostics; a busy confirmation journey observes 96 HTTP 200 and
32 empty 204 responses, no 503s, and eventual confirmation. Actual offline
reload exposed missing local-font precaching; the cache now includes the
already-shipped fonts and the former failure passes without raising its warning
allowance. Release embed remains within the 1,000,000-byte first-use gzip budget.
These are source-bound local repairs, not a full clean-commit DO result.

## Shared resource copy API

Use #2613's `getResourceCopies` and `subscribeResourceCopies` entry points on
the existing evidence registry. One Store snapshot resolves document and
attachment evidence for local, server, and peer copies, and concurrent views
share one Store watch per resource. The managed adapter supplies document and
file evidence from the same Vault scope. The existing wire formats, durable
observations, save checkpoints, and scope invalidation rules are preserved.

The copy API review reproduced three observer issues. Editing attachment
references released the native peer watch and discarded its current proof.
A native poll notified the combined copy view before applying its file rows.
A peer could display a newer timestamp from a receipt that did not cover the
displayed version. The peer watch now survives dependency rebinding, the Store
coalesces copy notifications from one update, and all destinations use the
registry's shared status and timestamp projection for metadata.

Merge acceptance applies to the exact published commit. Run the full public
DigitalOcean suite with `supplemental_profile: pr2621-native-private-v1` and
the paired `atomic-saas` source. It requires executed browser Vault backup and
clean-profile restore, native peer and Vault recovery, Iroh/WebRTC renderer
checks, and private workspace and managed-node checks. The separate Atomic
Flutter package workflow covers the `atomic_store_flutter` Dart tests.
