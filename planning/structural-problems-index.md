# Structural problems audit (2026-05-28)

Working list of structural issues surfaced during the QUERY_UPDATE /
canvas-genesis-save / outbox / live-Loro debugging arc of late May 2026.
Ranked by load-bearing impact (1 = most bugs traced back to it).

Items #4 (opfs-double-rehydrate), #9 (connection-close-cleanup), and
#10 (dev-cargo-lock-contention) have been fully implemented and their
plan docs removed.

Several open items overlap with broader existing plans:

- **#2, #5, #6** are slices of [`unified-data-layer.md`](./unified-data-layer.md)
  — the browser data-layer redesign. Doing those three in isolation
  risks landing partial layouts that the bigger plan then has to undo.
- **#6** has a Rust/Flutter dual in [`loro-source-of-truth.md`](./loro-source-of-truth.md).
  The browser `Resource._cache` and Rust `PropVals` should converge to
  "derived from Loro" together.

The remaining standalone items (#1 react-compiler, #3 subscription
actors, #7 arc-wrap, #8 subject types) don't overlap with the broader
plans and can be tackled independently.

| # | Plan | Class | Risk | First step |
|---|---|---|---|---|
| 1 | [react-compiler-resource-proxy.md](./react-compiler-resource-proxy.md) | Correctness | High | Audit all `.props.X` / `.isReady()` / `.loading` reads in render |
| 2 | [unify-subscription-primitives.md](./unify-subscription-primitives.md) | Cleanup | Medium | Single `Subscription` shape with `Match::{Subject, Drive, Filter}` |
| 3 | [unify-subscription-actors.md](./unify-subscription-actors.md) | Cleanup | Medium | Fold LoroSyncBroadcaster's subject-sub into CommitMonitor |
| 5 | [unify-resource-dirty-signals.md](./unify-resource-dirty-signals.md) | Correctness | Medium | Single `getSaveState(subject)` enum |
| 6 | [unify-resource-representations.md](./unify-resource-representations.md) | Correctness | High | Make Loro doc authoritative; `_cache` becomes memoized read |
| 7 | [arc-actor-message-payloads.md](./arc-actor-message-payloads.md) | Performance | Low | `CommitMessage` Arc-wrap remaining (`atomic_lib` change). `MembershipNotification.loro_snapshot` already Arc-wrapped. |
| 8 | [subject-types-end-to-end.md](./subject-types-end-to-end.md) | Correctness | High | Add a `Subject` TS type that round-trips through Rust |

## Suggested execution order

**Highest leverage** — 1 (React Compiler) is the highest bug density
in the codebase (~280 suspect sites) and won't get easier as the
codebase ages.

**Opportunistic cleanups** — 2 and 3 reduce mental overhead but are
not blocking anything. 7 remaining (CommitMessage Arc-wrap) is a
small perf win for high-fanout drives.

**Defer the invasive ones** — 5, 6, 8 need design alignment before
implementation. Each warrants its own RFC-style discussion.
