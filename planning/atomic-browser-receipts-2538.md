# Automatic browser server receipts

Stacked on #2596 (`f68945fd97520b76e8d731dd9af9eaa7d527b402`), separate from
the TablePage extraction. Task: browser automatic receipts, #2538/#2244.
Branch: `codex/atomic-browser-receipts-2538`.
Worktree: `/Users/michieldejong/.codex/worktrees/atomic-peer-receipts/atomic-server`.

## Contract

Extend the existing `StoreEvents.ServerReplicaReceipt` producer. Normal saves
already collect evidence; cover background/cold outbox delivery and refresh
followed drive inventories so newly imported stored versions receive evidence
without another application save or explicit receipt probe. Keep exact captured
versions, bounded background work, negotiated capabilities, and account/database/
connection fencing. Receipt collection never changes save or sync completion.
Do not claim every intermediate save, future retention, independent hardware,
attachment/key coverage or complete backup recovery.

## Ownership and acceptance

- Coordinator: plan, public docs, coverage notes, integration, builds and PR.
- `local_persistence_fix`: browser receipt scheduler, Store integration and unit
  regressions (`server-receipts.ts`, `store.ts`).
- `durability_review`: WebSocket AUTH and follow lifecycle with WS unit tests
  (`websockets.ts`).
- `durability_design`: real-server integration tests and Chromium/OPFS harness.
- Regression tests must exercise background outbox acceptance, fresh imported
  state, reconnect without another save, stale account/database/connection work,
  and bounded queues. Preserve existing HTTP/WS/peer receipt and save tests.
- Verify real server integration and Chromium worker/OPFS behavior without UI
  changes; keep private test data, ports and processes.

## Progress

- [x] Complete architecture and authentication lifecycle review.
- [x] Implement browser automatic collection gaps with regressions.
- [x] Update public documentation and testing coverage.
- [x] Run targeted tests, browser acceptance, typecheck and required checks.
- [ ] Review complete diff; commit, push and open dedicated PR against #2596.
- [ ] Observe CI on the exact final commit; record infrastructure blockers.

Separate discovered gap: a cold outbox containing a signed genesis plus a later
offline edit can clear after sending only the older genesis. Receipt collection
correctly reports the accepted version and withholds evidence for the unsent
edit. This PR preserves outbox semantics; replay repair is separate follow-up.

Dependency: #2596 is open and unmerged. Main/Downstream CI on the preceding
slice awaited self-hosted runners; local checks do not establish CI success.

Validation so far: 62 focused receipt/save tests and 68 WebSocket lifecycle tests
pass; six production-server integration cases and three Chromium/OPFS scenarios
pass. Typecheck, library build, lint, formatting and Rust workspace formatting
pass. An overloaded full-suite run timed out in six tests and one worker startup;
the serial full-suite rerun passed all 1,926 tests (one existing skip) in 66.92s
without changing timeouts. Independent
cross-review of AUTH and scheduler changes found no remaining blocker.

Design decisions: existing drive VV helpers expose snapshot oplog frontiers,
so receipt refresh reads bounded stored snapshots and extracts applied state
instead. Never fall back to live editor memory. Keep one in-flight scan per
database so a hung worker cannot accumulate background requests. Preserve exact
older targets independently of refreshed current state. Serialize AUTH callers
and bind receipt eligibility to both connection and Store identity generation;
an ambiguous sent-AUTH outcome disables evidence until a new socket.
