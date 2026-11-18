# Automatic browser peer storage receipts (#2538)

Worktree: `/Users/michieldejong/.codex/worktrees/atomic-peer-receipts/atomic-server`.
Branch: `codex/atomic-peer-receipts-2538`.
Base: #2586, `ddfb7ce0f0b9cd3e4067fe3f1eb3e7d021d05a5b`.
This is separate from TablePage (#2535/#2536), follows #2537/#2244, and does not
replace #2564's native full-drive/blob confirmation protocol.

## Contract

Authenticated browser peers negotiate `browser-storage-receipts-v1` through
AUTH_OK. Optional 0x56/0x57 request/receipt frames correlate a fresh nonce, drive,
subject and encoded requested version. The receiver checks drive/read access,
persistent backend capability and stored state-vector coverage, then flushes
before producing `atomic-redb-flush-v1` evidence. Missing state, tombstones,
unresolved dependencies, memory storage and failed flushes give no positive proof.
A receipt covers the checked target frontier even if the receiver stores a newer
snapshot; it does not assert the snapshot equals the requested version.

Private identity metadata is atomically durable in the actual backing store;
drive-scoped pseudonyms survive reopen and leader handoff. Recreated databases
get fresh metadata; byte clones retain identity and conservatively deduplicate.
Graph/Vault imports do not import backing-store metadata. Physical independence,
retention, blobs, keys and recoverable-backup completeness remain separate.

Each connection automatically queues exact completed SaveReceipt versions and
bounded fair reconciliation targets. Capability, mutual authentication, complete
nonce correlation, agent/database generations and active connection fence replies.
An immutable callback envelope carries the observation, source identity and
verified reporter/context to the caller's explicit independence policy. No
application-issued probes or invented observations are needed.

## Ownership

- durability_design: architecture, Rust KV identity, protocol/session handler/tests.
- local_persistence_fix: JS connection scheduling/correlation, immutable save events,
  wire constants, helper/transport regression tests.
- coordinator: WASM/worker/Node bridges, public docs, real browser acceptance, builds,
  PR and exact-commit CI.
- durability_review: independent read-only adversarial review.

- [x] Inspect existing receipts, browser auth/barriers and protocol overlap.
- [x] Persist scoped identity and produce authenticated version receipts after flush.
- [x] Automatically request/consume receipts with bounded retries and lifecycle fences.
- [x] Cover memory/legacy/failed flush/authorization/replay/old-version boundaries.
- [x] Verify real browser WebRTC + OPFS receipt production and reopen/leader identity.
- [x] Update protocol, persistence guide and coverage documentation.
- [x] Run scoped/full checks and independent review (native failures recorded below).
- [ ] Publish focused stacked PR; dispatch and follow exact-SHA CI.
- [ ] Remove this task plan only after required CI passes.

Validation so far: 1,885 JS tests pass (one existing skip), 39 focused JS tests,
21 native browser-session cases and three identity cases pass; real WASM memory
integration passes seven tests. Real Chromium receipt/handoff/reopen acceptance
passes. Independent review found no remaining blockers. Broad native validation
finished with 1,090 passes, two failures and 15 ignored tests. The compaction
line-606 disk-size assertion reproduces in pristine ddfb7ce; the isolated feature
run also hits #1886's final-record assertion. The populate reopen failure occurred
only in the broad run; isolated pristine-base and feature checks pass, and its
cause remains unresolved. Baseline/feature inventories were verified (1095/1107)
after forced recompilation to avoid stale Cargo artifact reuse.
Final input-boundary regressions, library rebuild, and real Chromium acceptance also pass.
The required pre-commit lint/Clippy and exact-commit CI remain release gates. This plan stays until that gate passes.
