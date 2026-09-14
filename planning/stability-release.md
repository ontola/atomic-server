# Stability release and data safety

> **Status: active, 2026-09-14.** First save-acknowledgement audit and server crash
> regression completed. Broader implementation and release acceptance remain open.

## Objective

Make Atomic Server safe to recommend for real data. Intermittent failures must
leave enough evidence to investigate, acknowledged edits must survive the failures
we claim to tolerate, and recovery must work when prevention fails.

This milestone covers the complete user data path: browser/native client,
persistence, sync, server, indexes, attachments, and backup/restore. Feature
completion and a green unit/E2E suite do not establish these guarantees.

Prioritize data safety, recoverability, and misleading success states over new
features. Do not turn this into a broad architecture rewrite. Extend existing
ingress, outbox, save-state, diagnostics, and test infrastructure.

## Starting evidence and ownership

- [Testing coverage](../TESTING_COVERAGE.md) records strong protocol coverage,
  glue-layer regressions, and platform acceptance gaps.
- [Silent failures](./silent-failures.md) records missing rows caused by stale
  views or incomplete indexes, and a desktop local-save claim requiring review.
  Entries are investigation leads, not proof that the current build still fails.
- [Unified data layer](./unified-data-layer.md) owns browser persistence and outbox
  architecture; [save signals](./unify-resource-dirty-signals.md) owns save status.
- [Unified sync](./unified-sync.md) owns transport and reconciliation work.
- [Sentry readiness](./sentry-feedback-readiness.md) owns reporting deployment gates.
- [Vault format](./encrypted-vault-format.md) and the sibling repository's
  `atomic-saas/planning/BACKUP_SECURITY.md` own backup and account recovery design.

This plan owns stability acceptance and prioritization. Keep implementation details
in those domain plans and update the coverage map as tests or gaps are identified.
Verify existing implementation before adding duplicate work.

## 1. Define and audit the guarantees

- [ ] Agree on the supported release matrix: hosted/standalone, browser/native,
  storage backends, browsers/devices, and supported upgrade paths.
- [ ] Trace each user-visible save state to its actual persistence acknowledgement
  on every supported runtime. Record gaps and assign owners.
- [ ] Audit attachment persistence alongside resource metadata: a saved reference
  must not imply that its file is durable when it is not.
- [ ] Turn the following proposed guarantees into executable acceptance checks.

| Promise | Required evidence |
| --- | --- |
| Saved locally | Acknowledged edits survive abrupt process termination and reopening on the same intact storage. |
| Synced to a node | The named receiving node durably accepted the edit; a socket send or broadcast is insufficient. |
| Save failed or was refused | Pending content remains recoverable, the failure is visible, and retry does not silently discard newer edits. |
| Reconnected | Replicas converge after successful reconciliation without losing acknowledged operations outside the defined conflict/deletion semantics. |
| Data is visible | Production query shapes and derived indexes agree with authoritative stored state after a defined settling bound, or report a detectable failure. |
| Backup available | A completed backup restores usable content, attachments, and required identity/access material in an empty environment. |

Distinguish local durability, replication, and backup in product copy. Local
persistence does not promise survival of browser storage eviction, disk loss, or
lost keys. Document recovery for those cases separately. A process-kill test does
not establish power-loss durability.

## 2. Make intermittent incidents diagnosable

- [ ] Add a bounded flight recorder to existing diagnostics. Retain recent semantic
  actions, resource lifecycle transitions, save/persistence acknowledgements,
  retries, connection changes, and storage errors.
- [ ] Include build/runtime identity and correlation IDs across client and server;
  use random session-scoped aliases for resources/drives, not their URLs or stable
  hashes. Scope correlation IDs to the diagnostic session or operation.
- [ ] Connect “Something went wrong” feedback to the preceding diagnostic window,
  even when there was no exception and the tester cannot describe the trigger.
- [ ] Define retention across reload/crash, storage limits, and export behavior.
  Diagnostics must not block saves or worsen a storage failure.
- [ ] Implement the collection levels and privacy acceptance checks below before
  expanding production incident reporting.
- [ ] Detect stuck saves, blocked queues, failed recovery, and index disagreement;
  error-free execution alone must not count as healthy operation.
- [ ] Finish applicable deployed Sentry/source-map/backend acceptance checks from
  the existing readiness plan.

Acceptance: a deliberately injected save/reconnect failure produces a useful,
bounded report linking the user action to the failed boundary without requiring
the tester to reconstruct events from memory.

### Privacy boundaries

Record what the system did, not what the user wrote. Production diagnostics should
explain whether an edit reached durable storage without collecting the edit.
Minimal metadata can still reveal activity patterns; do not describe it as
anonymous or risk-free.

| Level | Data | Activation and delivery |
| --- | --- | --- |
| Production baseline | Build/platform, predefined error codes, durations, queue counts, save-state transitions, temporary correlation IDs | Minimal collection during normal operation; external reporting follows the installation's explicit reporting configuration. |
| Temporary diagnostics | More detailed event ordering and lifecycle transitions, still excluding content | User explicitly enables a bounded local recording; automatically expires. Upload only with the user's report submission. |
| Test diagnostics | Detailed traces, payloads, or screenshots when needed | Isolated environments with synthetic data. A testing flag alone does not authorize capturing real user data. |

- [ ] Define an allowlisted, structured event schema. Do not capture arbitrary
  objects and rely on redaction afterward.
- [ ] Exclude titles, document text, filenames, resource URLs, query strings,
  credentials, signed payloads, request/response bodies, and raw console logs from
  production diagnostics. Prefer predefined failure codes over arbitrary error
  messages, which can embed sensitive values.
- [ ] Keep detailed recent events on-device in a bounded buffer. Provide a
  readable report preview and let users omit diagnostics before submission.
  Enabling local recording must not silently enable automatic uploads.
- [ ] Keep production session replay, DOM snapshots, and screenshots disabled by
  default; any exceptional capture needs a separate informed choice.
- [ ] Set concrete buffer limits, local/server retention periods, access controls,
  and deletion procedures before rollout. Temporary recording must expire
  automatically, including across restarts.
- [ ] Let self-hosted installations disable all external reporting. Apply the same
  collection policy to third-party telemetry SDKs and server-side reporting.
- [ ] Test the complete export/telemetry path with distinctive fake secrets,
  resource identifiers, and document text. Assert they never appear in production
  reports; also test field allowlists, bounds, expiration, and upload controls.

Start with save-state transitions, persistence acknowledgements, connection
lifecycle, and sanitized failure codes. Expand only when a concrete investigation
shows that additional metadata is necessary and its privacy boundary is tested.

## 3. Build a durability and recovery harness

Start with one workload: create a document, edit text, add table rows, and attach a
file. Track intended operations and observed acknowledgements in an independent
test ledger. Do not derive expected results solely from the store under test.

- [ ] Establish a baseline that restarts and verifies content, query membership,
  pending edits, and attachment hashes.
- [ ] Add controlled failpoints before/after local persistence, queue updates,
  remote durable acceptance, and acknowledgement delivery.
- [ ] Kill actual client/server processes without graceful cleanup. Verify the
  harness cannot accidentally flush state through normal object destruction.
- [ ] Exercise lost acknowledgements, duplicate delivery, reconnect during save,
  and edits made while an earlier save is in flight.
- [ ] Exercise storage write failures/quota exhaustion and refused remote writes;
  verify visible failure and retained content where intact storage permits it.
- [ ] Exercise concurrent edits during a network partition, then reconnect and
  verify convergence according to explicit conflict and deletion semantics.
- [ ] Expand deterministic cases into seeded operation/failure schedules. Retain
  the seed, schedule, build IDs, acknowledgement ledger, and diagnostic artifacts.
  Minimize failing sequences into focused regressions.

Start disjoint edits with simple expected outcomes. For conflicting edits, define
an independent semantic oracle; comparing replicas alone can miss identical loss.
An unacknowledged operation may have persisted, so allow that outcome while
requiring every acknowledged operation to be accounted for. Do not equate LWW
resolution or an authorized later deletion with accidental loss.

Place checks at the cheapest effective layer: Rust/JS units, real-server
integration, then production-build browser tests for actual OPFS, lifecycle,
rendering, and UI save claims. Keep broader fault campaigns outside the smoke suite.

## 4. Exercise lived-in workspaces and supported devices

- [ ] Maintain versioned representative fixtures with rich history, tables,
  attachments, deletions, permissions, and pending offline work.
- [ ] Upgrade fixtures from each supported prior release and verify content,
  identity/access, indexes, attachments, and subsequent edits.
- [ ] Run sustained workloads against persistent workspaces, including reload,
  multiple tabs, account switching, sleep/wake, and network changes.
- [ ] Check that late asynchronous work cannot cross account/drive boundaries.
- [ ] Run physical browser/native acceptance where automated environments do not
  establish storage, lifecycle, or credential-provider behavior.
- [ ] Capture the actual application query when investigating missing rows;
  compare UI, exact query results, indexes, and authoritative resource state.

Keep fresh-agent E2Es for isolation. These longer-lived checks supplement them.

## 5. Prove recovery independently of replication

- [ ] Inventory what each backup contains and excludes, including blobs, history,
  identity material, and dependencies on account services.
- [ ] Define acceptable backup age and recovery time for supported deployments.
- [ ] Restore into an empty environment and compare resource contents and file
  hashes; verify users can open and edit the restored workspace.
- [ ] Test interrupted/incomplete backups and ensure they cannot be advertised as
  successful replacements for the last usable backup.
- [ ] Test recovery with lost device state and the supported recovery credentials;
  document what is unrecoverable without keys.
- [ ] Verify retained historical copies can recover accidental deletion or
  corruption propagated through sync.
- [ ] Schedule recurring restore drills and retain their evidence.

## 6. Triage and release gates

Every intermittent failure gets an incident record with build/platform, impact,
evidence, owner, and status. Separate actual persistence loss, rejected/unsent
writes, convergence failures, stale views/indexes, and identity/routing mistakes.
All can make data appear gone; classification must follow evidence.

- [ ] Record first-attempt failures even when retries pass. Classify product,
  harness, and infrastructure faults; do not treat retry success as resolution.
- [ ] Require a regression at the cheapest failing layer for each confirmed bug.
- [ ] Give quarantined tests an owner, reason, and review date. Quarantine cannot
  waive a data-safety gate.
- [ ] Set explicit reconciliation/save time bounds, campaign sizes, soak duration,
  supported platforms, and evidence retention before release acceptance starts.
- [ ] Track acknowledged-write loss, false success claims, stuck saves, convergence
  failures, restore success/time, and first-attempt failures with workload counts.

Release only when:

- [ ] No known unresolved acknowledged-write loss or false saved/synced claims
  remain in the supported matrix; unexplained possible-loss incidents are resolved.
- [ ] Deterministic crash/reconnect/storage-failure checks pass.
- [ ] The agreed seeded campaigns and soak period complete without unresolved
  safety failures on the actual release candidate.
- [ ] Supported upgrade checks and full empty-environment restore drills pass.
- [ ] Diagnostic delivery works from deployed builds and reports can be acted on.
- [ ] Evidence records exact builds, platforms, workloads, failures, and limitations.

Passing these gates provides bounded evidence, not proof of zero possible bugs.
Publish the supported guarantees and recovery procedure with the release.

## First implementation slice

1. Audit local/remote save acknowledgement boundaries and existing regression
   coverage; confirm whether historical desktop save warnings still apply.
2. Capture one complete save lifecycle through the existing diagnostics and
   feedback path, including a deliberately failed save.
3. Implement one real abrupt-termination/restart scenario with a document, row,
   and attachment, checked against an independent acknowledgement ledger.
4. Perform one empty-environment restore drill and record concrete gaps.

Use these results to order subsequent work by demonstrated risk. Each completed
slice must include reproducible evidence, not only a new test count.

### Save acknowledgement audit — 2026-09-14

Branch: `codex/save-durability-audit`. Scope is the shared save boundary; this
does not establish complete document/table UI or native-platform acceptance.

| Path | Inspected boundary | Finding |
| --- | --- | --- |
| Browser explicit online save | `Resource.save()` drains the outbox, checks acknowledgement/version, then awaits `persistToClientDb()` | Local snapshot RPC is awaited before returning `persisted`; remote durability depends on server acknowledgement semantics. |
| Browser local snapshot | `persistToClientDb()` awaits `putResourceWithSnapshot` | Existing worker durability tests cover the flush barrier and errors. No new real-browser crash evidence yet. |
| Browser offline/local-only | `saveOffline()` / `saveLocalOnly()` require local persistence | Missing/unsupported storage now rejects. Failed local-only saves retain signed work for retry and remain unsaved. Children waiting on a new parent return `queued` rather than claiming local durability. |
| HTTP and WebSocket commits | Both use `handlers::commit::apply_commit_json` | Reproduced loss: acknowledged name reverted after unclean exit before the periodic flush. Handler now awaits a blocking-pool durable flush before returning success; crash regression and server checks pass. |
| Desktop | Embedded server; no browser ClientDb (`desktop/src/lib.rs`) | Server acknowledgement is the local durability boundary when connected. Disconnected saves without ClientDb now reject; actual native acceptance remains open. |
| Connection-loss messaging | `NetworkIndicator.tsx` | Original connection-loss toast wording retained following review. Save failures are errors rather than queued/idle; the inspector offers Retry save. Save-state kinds use the exported `ResourceSaveStateKind` enum. |

- [x] Run existing save acknowledgement, worker durable-put, and scheduled-save
  suites: 17 tests passed across three files.
- [x] Reproduce and fix early server acknowledgement with a subprocess test
  using real redb, no graceful shutdown, and no periodic flush to hide the gap.
- [x] Verify the fix and relevant server HTTP/WS regressions: server library suite
  76 passed, 2 intentionally ignored (S3 environment test and subprocess entry);
  WebSocket commit and drive-isolation integration tests both passed.
- [x] Fix unsupported/offline local-save claims with focused regression coverage.
  Client library: 498 tests pass. Compiled browser retry/reload scenario passes.
- [x] Add Chromium document/table crash acceptance: three consecutive passes,
  each with two SIGKILL/reopen cycles and remote data access blocked.
- [ ] Add attachment recovery and native/other-browser crash acceptance.

The first server test uses an existing drive resource's name edit and the shared
HTTP/WS handler directly. It records the acknowledged subject outside the database,
exits without destructors, and reopens the same store. It deliberately excludes
the periodic flush thread, modeling a crash before the next tick. It does not
exercise network delivery, browser UI, attachment durability, or power loss.

The fix adds a durable flush per successful HTTP/WS handler call. Flush errors
propagate instead of returning success; the periodic flush remains for other
writers. This prioritizes the acknowledgement contract but may increase write
latency and disk I/O. Throughput benchmarking and a possible shared group-commit
barrier are follow-ups; any batching must retain the same durability guarantee.

Validation commands:

```sh
ATOMICSERVER_SKIP_JS_BUILD=true cargo test -p atomic-server --lib --no-default-features --features light
ATOMICSERVER_SKIP_JS_BUILD=true cargo test -p atomic-server --test it ws_commit --no-default-features --features light
cd browser/lib
pnpm exec vitest run src/save-acknowledgement.test.ts src/client-db-durable-put.test.ts src/scheduled-save.test.ts
```

The Rust checks used the light feature set. Existing frontend assets were reused;
these checks establish server behavior, not a rebuilt frontend or default-feature
release acceptance. `git diff --check` passed.

### Browser acceptance and runner findings

The next browser checks build the frontend/WASM and default-feature server. The
first attempts exposed runner issues before reaching the new scenarios:

- Installed Playwright rejects `install --no-remove`; use
  `PLAYWRIGHT_SKIP_BROWSER_GC=1` to preserve other installed browser versions.
- Cargo built beta.7 into its configured shared target directory, while the runner
  copied a stale beta.2 binary from the repository's `target/debug`. The runner
  now obtains `target_directory` from `cargo metadata` instead of guessing it.

Those failed runs do not establish product failure or durability acceptance. The
crash test owns a dedicated Chromium persistent profile and obtains that browser's
PID through CDP before sending SIGKILL. On restart, HTTP data access and WebSocket
sync are blocked so remote copies cannot rescue missing local edits.

Accepted local evidence:

- `.e2e-runs/2026-09-14T13-55-58.954Z-Svh0AH`: rebuilt frontend/WASM and
  default-feature beta.7 server; both inspector save tests passed. The crash
  content checks passed, but the harness incorrectly required a warning for each
  deliberately closed socket, including closes preempted by process termination.
- `.e2e-runs/2026-09-14T13-58-19.747Z-2anKCD`: reused that build, corrected the
  diagnostic expectation to permit at most one specifically identified warning
  per injected close, and passed the crash test three consecutive times (56.8 s).
  No unexpected diagnostics are permitted. Earlier first-failure artifacts remain.
- All 498 client-library tests, seven process-runner tests, UI and E2E typechecks,
  changed-source lint/format, and `git diff --check` pass.

The retry button needed its new message in the locale catalogs; the compiled UI
test caught the missing label. Its click handler now handles the save rejection
while the subscribed resource state keeps the failure visible and retryable.

**Toolchain limitation:** the installed environment uses pnpm 8.15.0 and
Playwright 1.60.0, while the repository pins pnpm 10.15.1 and Playwright 1.63.0.
The runner's install subprocess printed replacement prompts and exited without
bringing them into alignment. Corepack resolves the pinned pnpm, but nested bare
`pnpm` commands still resolve to 8.15.0 on this machine. These results are valid
local source-level checks under the installed toolchain, not frozen-lockfile
release acceptance. Do not count the reported install phase as verification.

- [ ] Make runner installation noninteractive and use the pinned package manager
  for nested commands; verify resolved dependency versions and rerun release
  acceptance with the lockfile toolchain before shipping.

Public API note: `SaveResult` now includes `queued` for an unsaved parent. It
explicitly carries no durability promise; consumers that exhaustively switch on
the result must handle it. `offline` is reserved for successful local persistence.

### Durable acknowledgement throughput probe

Manual probe, local macOS, Rust debug/light build, real redb, synthetic folder
renames. Each writer performs 16 sequential edits; writers run concurrently on
independent resources in one database. Timing includes signing, validation and
persistence, not HTTP or browser latency. Both modes retain the 100 ms periodic
flush. The baseline intentionally reproduces the unsafe early acknowledgement;
it is a comparison, not an acceptable implementation.

Repeat measurement after builds/browser tests finished:

| Concurrent writers | Operations | Periodic-only ops/s | Durable-ack ops/s | Periodic-only p95 ms | Durable-ack p95 ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 16 | 28.6 | 17.0 | 42.19 | 124.01 |
| 4 | 64 | 82.7 | 66.1 | 100.89 | 69.68 |
| 16 | 256 | 93.6 | 72.7 | 53.59 | 386.06 |

The earlier run overlapped other build activity, so it is not the primary
measurement; at 16 writers it also showed a roughly 380 ms durable-ack p95.
Small sample sizes and inconsistent low-concurrency tails preclude a production
capacity claim. The high-concurrency cost merits a group-commit experiment, not
removing the durability barrier. The probe checks final values for all writers.

Reproduce with:

```sh
ATOMICSERVER_SKIP_JS_BUILD=true cargo test -p atomic-server --lib compare_acknowledgement_throughput --no-default-features --features light -- --ignored --nocapture
```

- [x] Measure per-commit flush cost under concurrent writes.
- [ ] Benchmark an optimized build on representative deployment storage and agree
  on latency/throughput targets.
- [ ] If needed, prototype one shared flush barrier that acknowledges a batch only
  after its durable commit point; preserve crash and flush-failure guarantees.
