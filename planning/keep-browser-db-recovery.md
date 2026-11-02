# Keep browser database recovery

Task: two-way keep sync deploy / 01a18c34-dcc8-74f1-bb04-b9ddd3421caf.
Worktree: /Users/michieldejong/.codex/worktrees/keep-browser-db-recovery/atomic-server.
Branch: codex/keep-browser-db-recovery. Base: fetched origin/develop (recorded in git).

## Acceptance

- Reproduce and fix Loro/WASM failures during a large Keep Drive read.
- Preserve offline data, pending edits, resource history and authorization boundaries.
- Browser can finish a complete import/read sync and a repeat sync without duplicates.
- Google Keep Drive write-back stays off throughout.
- Existing laptop shared read login and per-send approval setup remain unchanged.
- Do not restart another task's localhost11870 server or edit its worktree.

## Ownership

Coordinator: integration, reproduction, documentation, live read verification and CI.
db_architecture: bounded read-only design/review; implementation assignments follow evidence.
Other task owns keep-resource-views; no overlap with its renderer/grant files.

## Checklist

- [x] Reproduction and architectural design
- [x] Regression test and implementation
- [x] Documentation and coverage map
- [x] Targeted checks and browser GC/persistence validation
- [ ] Live read-only Keep sync and repeat sync
- [ ] PR and exact-commit CI

## Evidence

Existing live frontend (chunk_web-BJ4Q3ifm, loro_wasm_bg-5ZFyxdCj) reaches gigabytes of memory during Drive hydration, then throws DataView bounds errors or RuntimeError: unreachable. Further resource reads/outbox drainage fail in the same WASM instance. Direct signed HTTP data reads are healthy. The provider connection refreshed and returned three HTTP200 pages on 2026-11-02; authentication is not the current blocker. No browser database reset or deletion is authorized or planned.

Root cause reproduced on the base: Rust-held Loro event callbacks capture their
Resource strongly, retaining all 20 discarded resources after full GC. Editing
an old document after reset also dirties the replacement's outbox. The fix uses
a weak owner created outside the Resource's lexical scope, owns subscription
cleanup at reset, and leaves public document handles and version vectors to
normal GC. Three regression tests failed before and pass after the fix.

No protocol, stored snapshot, authorization, or OPFS format changes are needed.
Reloading a patched frontend discards an already-poisoned runtime without
discarding the durable database. Live localhost11870 is shared with another
active task; do not restart it before the final deployment is coordinated.

Validation: full client-library unit suite 1,768 passed, one existing skipped;
library typecheck and lint pass. Production Chromium GC and ClientDb persistence
tests passed (2/2, no retries). The first app-frame run used a light native build
without `wasm-plugins`, so `/plugin-view-token` was absent; that build selection
was corrected before rerunning the app-frame checks.

Upstream PR: https://github.com/ontola/atomic-server/pull/2435. Main CI uses the
self-hosted runner and is queued; do not change the runner setting.

Laptop compatibility: a separate task-owned managed worktree at
`/Users/michieldejong/.codex/worktrees/keep-db-live-f570/atomic-server`, branch
`codex/keep-db-live-f570`, backports only the observer lifecycle onto deployed
backend base `f570405eb2ff14570ca26d4e91e82e5dafd338b5`. Its original
`serverConnected` guard is preserved. Its own 60 focused tests, typecheck and lint
pass. Build with the existing `default,plugin-routes` features and managed portal
URL, without E2E mode, to avoid unrelated backend or configuration changes.
