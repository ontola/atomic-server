# Batch replicated envelopes with SYNC_PUSH projections

Status: implementation reviewed; targeted sync tests pass; full validation and matched benchmark in progress.

Task: the benchmark chat rooted at `/Users/michieldejong/Documents/Codex/2026-10-26/sync-benchmark-atomic`.
Worktree: `/Users/michieldejong/gh/ontola/worktrees/atomic-server/sync-envelope-batching-candidate24`.
Branch: `codex/sync-envelope-batching-candidate24`.
Base: candidate24 `9524618a46b7e1c57e440effca310519367e2400`, which includes develop `2339f4e1fc2de3bf0f6e6d0f550348405837f463`.
Dependency: candidate24's prepared projection batching is not in develop. Target the focused PR at `claude/atomic-plugins-pin-candidate24`; do not include the candidate's unrelated history in a develop PR.

## Scope and acceptance

- Keep the public Atomic Lib API and wire protocol unchanged.
- Stage accepted signed envelope operations with each message's resource/snapshot/index projections, avoiding a data transaction per envelope.
- Preserve drive/subject admission, signature verification, invalid-envelope rejection, retention, CRDT history, complete query/search indexes, and final native flush behavior.
- Resolve same-message schema reads, concurrent retention updates, compression/genesis snapshot dependencies and event ordering explicitly before implementation.
- Do not use the global begin_batch buffer as a wrapper around asynchronous import.
- Prove the transaction reduction with a meaningful regression test and verify failure atomicity and post-commit notification semantics.
- Rerun the complete tracker10000 fixture with exact fixture/state/vector/envelope/index/search/offline checks; compare against the unchanged candidate24 under the shared measurement lock. Report observed performance without assuming a speedup.
- Leave unrelated flush issue #2378 and other performance hypotheses out of this change.

## Ownership and workflow

Coordinator owns this plan, documentation integration, benchmark harness/evidence, commits, PR and CI. Astra-low reviews architecture. Human approved gpt-6.1-terra (medium) for implementation because the skill's older Terra model is unavailable. Assign implementation/test file ownership after the architecture pass; agents do not independently commit, push or change branches.

- [x] Architecture contract and lock/error/visibility review.
- [x] Failing regression at the Rust layer.
- [x] Internal batching implementation and regression coverage.
- [x] Public documentation and TESTING_COVERAGE updates.
- [x] Targeted tests, required server build, and final architecture/diff review.
- [ ] Mandatory commit-hook checks.
- [x] Matched unchanged/optimized benchmark and proof.
- [ ] Focused PR against candidate24 and exact-commit CI.
- [ ] Completed-plan cleanup and final exact-commit CI.

## Approved architecture

Verify envelopes against a read-only view of all accepted final projections, including same-message Property and signer resources. Fold retained envelopes in wire order with pending inserts/deletes, preserving Latest/All and conservative unknown-ancestor behavior. Append envelope operations to the prepared projection transaction; apply once, then release subject locks and publish notifications. Standalone envelope import shares subject locking and staging helpers without changing its public signature. Invalid envelopes are ignored; storage errors reject the transaction. LAST flush semantics remain unchanged.

Implementation and Rust test ownership: `/root/batching_implementation` (gpt-6.1-terra, medium). Architecture reviewer: `/root/batching_design` (gpt-6-astra, low). The coordinator serializes heavy builds/tests/measurements with the shared benchmark lock and 20 GiB free-space guard.

Validation reads must not invoke Db's write-through network lookup while subject/identity locks are held. A private overlay uses staged resources, local resources and an ephemeral fetched-resource cache; external reads use the overlay's cache-only mutation path. Preserve the existing local/identifier network restrictions and external schema compatibility. Standalone envelope validation remains before acquiring its retention lock.

## Local validation evidence

- Regression failed before implementation (three physical transactions), passed after (one).
- Final envelope-filter run: 85 passed; the remaining staged-signer fixture was corrected and its targeted rerun passed. Final Clippy and rustfmt passed.
- Import durability integration: two parent tests passed, including subprocess abort/reopen after LAST.
- Earlier full library run: 908 passed, 3 failed, 11 ignored. Two new fixture failures were corrected and rerun successfully. The existing startup compaction test also failed on an isolated unchanged candidate24 build, at a different assertion; do not claim a clean full-suite run or an identical failure cause.
- Matched baseline-before: native return 42.907 seconds with full fixture and offline verification. Optimized: 33.718 seconds; baseline-after: 43.314 seconds. Identical sender snapshots and all verification passed; observed reduction 21.4–22.2%.

- Fresh worktree frontend/WASM build and full native server build passed.
