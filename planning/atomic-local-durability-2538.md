# Honest local save completion (#2538)

Task: implement the first Atomic-side findings from #2538 independently of
TablePage extraction (#2537).

- Worktree: `/Users/michieldejong/.codex/worktrees/atomic-local-durability/atomic-server`
- Branch: `codex/atomic-local-durability-2538`
- Base: `f445d2909c50506c74c798cd8d891e99e8962780` (`origin/develop`)
- Coordinator owns documentation, this plan, integration and publication.
- Implementation agent owns `browser/lib/src/resource.ts` and relevant library
  regression tests. No branch changes, commits or publication by agents.

## Contract and scope

Extract the narrow required-local-persistence and local-only retry behavior
already proposed in #1531. Offline/local-only saves must reject when no usable
client database exists or its write fails. Retain signed local-only commits
across failure so retry stores and publishes the same genesis/history. Keep
online acknowledgement successful when its optional local mirror fails.
The internal persistence boolean still means outbox rows were written, not
snapshot success. Use the existing snapshot/outbox persistence path.

An independent companion PR will return `queued` for children waiting on an
unsaved parent. Until it lands, that branch remains an exception to interpreting
`offline` as completed local storage. No new receipt API: #2244 owns that contract;
#2166 owns optional server durable acknowledgements. No ELFA or TablePage edits.

## Acceptance and progress

- [x] Inspect current code, existing proposals and delegated architecture review.
- [x] Reproduce missing/unsupported/failing database false success in unit tests.
- [x] Require persistence for offline/local-only saves, preserve retry history.
- [x] Verify snapshot-only success, error recovery, peer publication ordering,
  and unchanged online mirror failure/timeout behavior.
- [x] Document observable API signals and remaining receipt limitations.
- [x] Update testing coverage and review complete diff.
- [x] Run targeted tests, full library suite (1800 pass, one existing skip),
  workspace build, library typecheck and lint. Commit hook runs at publication.
- [ ] Publish dedicated PR, link #2538/#2537 and overlapping #1531/#2244.
- [ ] Follow exact-commit CI; remove this completed plan after green CI.

Unit tests establish acknowledgement and retry behavior, not a new crash-durability
guarantee. The worker flush implementation is unchanged.
