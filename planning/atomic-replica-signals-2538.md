# Independent-replica evidence signals (#2538)

Task: continuation of #2538 and the design in #2537, aligned with #2244.
Worktree: `/Users/michieldejong/.codex/worktrees/atomic-replica-signals/atomic-server`.
Branch: `codex/atomic-replica-signals-2538`.
Base: `c4a4acfaa8505bafa1e93ca22f2fac9456466181` (#2584 version-specific receipts,
stacked on #2567). TablePage extraction (#2535/#2536) is outside this work.

## Contract and scope

A pure public SDK evaluator assesses whether supplied trusted evidence establishes
at least one persistent copy independent of the local store for an exact subject
and version. Storage and device independence are different policies. It returns
immutable unsupported/unknown/pending/satisfied observations and reasons; it does
not add another Store registry, scheduler, outbox, wire protocol or write barrier.
The caller selects the target local or server version from `SaveReceipt` explicitly.
These receipt fields are not themselves remote durability or independence evidence.
Exact version equality is deliberately conservative; broader causal coverage is
future work. Unversioned metadata cannot satisfy this version-specific contract.

Built-in transports supply no qualifying evidence yet. A trusted adapter must
validate provenance, scope, active storage generation and backing independence.
Different IDs, sessions, URLs or peer counts never establish independence alone.
Historical persistence does not promise current retention, blob/key/dependency
closure, recoverable backups, or authority acceptance. #2564 full-sync confirmation
and #2166 durable commit work remain separate producer foundations; this slice does
not duplicate or silently strengthen them. Future native identity/protocol work
must define clone/reset and capability semantics before advertising receipts.

## Ownership and acceptance

- Architecture: durability_design (read-only).
- Implementation/tests: local_persistence_fix owns replica-evidence.ts,
  replica-evidence.test.ts and the index.ts export.
- Coordinator: this plan, public persistence guide, architecture notes, coverage,
  builds, integration verification and PR.
- Review: durability_review (read-only, independent adversarial pass).

- [x] Inspect prior receipts, replica design and overlapping protocol PRs.
- [x] Export evaluator and immutable types with truthful default states.
- [x] Test positive trusted evidence and invalid/unknown/stale/same-store cases,
  exact target binding, shared device scope, duplicates and immutability.
- [x] Document how developers select a receipt version and assess the signal.
- [x] Independent review and targeted/full library validation; workspace build.
- [x] Prepare dedicated stacked PR and exact-SHA CI dispatch.
  Required CI completion remains the gate below.
- [ ] Required CI passes; remove this task plan only after that gate passes.

Independent review found no remaining blockers after the single-read input
snapshot regression was fixed. The focused evaluator suite passes 36 tests.

Validation: 1,860 library tests pass with one pre-existing skip; full recursive
browser/WASM build, library typecheck/lint/format, Rust formatting and built-package export
smoke check pass. No native storage or wire behavior changed.
