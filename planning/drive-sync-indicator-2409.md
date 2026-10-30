# Confirmed drive sync (#2409)

Status: attachment confirmation implemented and reviewed; browser acceptance and final PR validation in progress.

- Task: Codex chat `drive-my-chrome-to-find-out`.
- Worktree: `/Users/michieldejong/.codex/worktrees/drive-sync-indicator-2409/atomic-server`.
- Branch: `codex/drive-sync-indicator-2409`.
- Base: fetched `origin/develop`, `54dc025958dd370c1730dc240854d9614ecf1b60`.
- Original checkout baseline is saved outside the repository and remains unchanged.
- Ownership: coordinator owns plan/docs/catalogs/builds/E2E/PR; client coding
  agent owns TS confirmation and sidebar; server coding agent owns Rust strict
  inventory/endpoint, narrow storage consistency primitives and Rust tests;
  architecture reviewer is read-only.

## Acceptance

- Remain red unless the latest selected drive state is confirmed at another
  place, including every referenced file/image blob and chunk.
- An unrelated server, historic receipt, pending save, unsaved edit, partial
  chunk ACK, rejected transfer or stale asynchronous response cannot certify it.
- Keep local-only drives excluded; checks are read-only and cannot promote or
  upload anything. The desktop embedded node is not another place.
- Unsupported servers, incomplete inventories, invalid references and read
  failures fail closed. Confirmed state must be scoped to drive, server and
  identity, and invalidated by changes.
- Account/drive routing preference isolation remains separate in #2411;
  global progress counters remain conservative blockers. Minimal server feature
  build repair remains separate in #2412.

## Design

Add signed, read-only `GET /drive-sync-confirmation?subject=...&hash=...&hashVersion=2`.
Its versioned response confirms an exact canonical v2 hash plus exhaustive
attachment presence from a stable readable drive inventory. Metadata-only
`SYNC_OK` remains insufficient. Old servers leave the icon red.

Use authoritative stored membership and propagate inventory/read errors.
Mirror download semantics: nonempty `chunks` needs every chunk but not a
monolithic blob; single-file representations validate their backing hash.
Establish a consistent metadata/ACL view and durable storage before responding.
The response exposes no private manifest, only authorized drive/hash/result/count.

The client flushes local persistence, obtains the full local state hash, and
accepts the response only while the captured identity/server/drive/mutation
context remains current and all local work is settled. Recheck after later
acknowledged uploads; querying must never enable publishing.

## Work

- [x] Original icon/local-activity regressions reproduced and fixed.
- [x] Strict resource-state ACK behavior reviewed and verified (131 library,
  25 sidebar/helper tests, real Chromium journey, typechecks and screenshots).
- [x] User explicitly included file/image byte confirmation in PR scope.
- [x] Attachment confirmation architecture contract.
- [x] Strict server inventory, attachment checks and signed endpoint with tests.
- [x] Correlated client confirmation lifecycle, invalidation and tests.
- [x] Public docs, UX reference, coverage map and settled catalogs (no new catalog diff).
- [x] Matching builds, endpoint tests, browser acceptance and screenshots.
- [ ] Review, push and update PR #2413; mark ready after requested behavior.
- [ ] Exact-commit CI, completed-plan removal and final cleanup validation.

## Validation constraints

The documented minimal `light` build fails on unrelated plugin imports (#2412).
Local app verification uses `light,wasm-plugins` with a real built runtime. The
current PR head is `2d43236f6`; its CI is queued on the repository's self-hosted
runner. Do not claim green CI. All task logs/builds remain inside ignored
`target/task-logs/` and the worktree's own build directories.

Latest checks: 134 client-library tests, 44 sidebar/confirmation/helper tests,
8 Rust confirmation/epoch tests, 1 revision-cache test and 2 server tests passed.
App/E2E TypeScript, React Compiler and rustfmt checks passed. Matching WASM,
frontend and native `light,wasm-plugins` builds passed. Architecture review found
no blockers. Real Chromium acceptance passed 2/2 tests with zero skips, retries or failures
(21.6 seconds); screenshots were reviewed and shared in the task chat.
