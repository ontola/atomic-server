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
- [ ] Documentation and coverage map
- [ ] Targeted checks and browser validation
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
