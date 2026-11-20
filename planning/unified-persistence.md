# Unified persistence and copy evidence

Status: implementation in progress, authorized 19 November 2026. Base is
candidate27 `d067d02209a480962e8928d885e473a8846c7212`, which includes the
existing save/receipt stack and resource-copy UI. Preserve source PR history;
publish the consolidation as a reviewable forward change for trekmeester.

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
- [ ] Publish reviewable forward refactor and source PR accounting; shared CI
  and final candidate merge remain with trekmeester.

## Existing evidence to preserve

The transport receipt producers already perform authentication, scope checks,
version correlation and persistent Redb barriers. Reuse them. Vault already
tracks encrypted exported versions and content manifests with account/epoch
fences. Keep its managed-account knowledge in its adapter. Existing file recovery
performs verified content admission and does not restore graph history.

No new wire messages or parallel delivery queues are needed for the consolidation.

## Implementation and rollout

Source heads and review vehicles are recorded in `unified-persistence-sources.json`.
This is a forward refactor of the already integrated candidate, not another
competing whole-stack merge. Existing source PRs remain open until trekmeester
accepts the resulting candidate. No shared CI is dispatched by this worker.

The model is shared in `browser/lib/src/persistence-evidence.ts`: causal metadata
observations, content manifests, scope lifetimes and completion rules. Protocol
request/response correlation remains exact and authenticated in the existing
transport adapters. Native transport producers and verified file recovery are
preserved. Server content evidence now includes its scoped storage incarnation.

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
