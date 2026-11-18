# Automatic native WebSocket and Flutter receipts

Stacked on #2594 (`e5bdb2cb3a8995f78b0c1fb338b280e63fba3617`), separate from TablePage extraction. Branch: `codex/atomic-native-ws-receipts-2538`. Task-owned worktree: `/Users/michieldejong/.codex/worktrees/atomic-peer-receipts/atomic-server`.

- [x] Read architecture, protocol, coverage and adapter boundaries; delegated design review.
- [x] Core bounded native WebSocket requester, authenticated connection/agent fences, typed Db subscription, native replication integration.
- [x] Flutter session integration, continuous per-handle bridge stream, immutable public Dart API and generated bindings.
- [x] Native/Dart regression tests: correlation, historical captured targets, unsupported peers, lifecycle replacement, bounded inventory; real server native integration and Flutter stream behavior.
- [x] Public documentation and coverage updates.
- [x] Independent review and root Rust formatting checks.
- [x] Native Flutter bridge tests against the actual server and existing bridge unit suite.
- [x] Mandatory staged-snapshot workspace Clippy checks.
- [ ] Dedicated stacked PR; exact-head CI followed through completion.

Ownership: local_persistence_fix owns `lib/src/**`; durability_design owns `packages/atomic_store_flutter/**` including generated bindings; coordinator owns server integration tests, outer docs, plan, integration/publishing; durability_review independently reviews.

Contract: probe immutable observed stored applied-state version vectors on followed drives after authentication, live changes, outbox and reconciliation. Recover missed notifications with bounded rotating inventories. Correlate complete wire tuples before state work. Source identity is optional for memory clients. Server origin is provenance, not a verified server agent or proof of independent hardware. Receipt absence cannot fail ordinary sync or upgrade save/replication acknowledgement. Events are historical, metadata-only, non-replayed evidence; no guarantee for every intermediate save, blobs, keys or retention. Account/auth/connection replacement must suppress pending old proofs. Flutter subscribes continuously rather than resubscribing per event. Core logic remains in atomic_lib; no UI changes.

Validation uses task-private native and Flutter build/build-cache directories. Generated FRB files must come from pinned 2.12.0. Main CI previously cannot acquire self-hosted runners; do not bypass those checks and retain this plan if still blocked.

Review found and resolved overlapping Flutter opens and account changes during collector construction. Post-construction checks occur before following any drive; monotonic account epochs also fence away-and-back changes. Direct injected-barrier coverage of that constructor interleaving remains a gap; downstream account invalidation is tested. Flutter package analyzer and all 71 Dart tests pass; pinned FRB generation repeated with identical output. Native client tests pass (41 passed, two existing ignored), all four real-server native acceptance tests pass, and five existing replication regressions pass. The ws-only feature configuration also checks successfully. The native Flutter bridge suite passes (61 passed, two intentional ignored entries); the real-server bridge acceptance passes separately. Final focused Dart tests pass (four), including three receipt-module tests in Chrome. Staged-snapshot workspace Clippy passes. The full bridge crate rustfmt check reports pre-existing formatting debt in 15 files, verified against the base; new receipt modules and changed receipt methods are formatted. Required exact-head CI remains pending publication.
