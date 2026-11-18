# TablePage extraction and deferred improvements

Decision: 13 November 2026. Extract the existing complete TablePage first,
preserving its behavior and state ownership. Review functionality changes in
separate follow-up PRs. The old stack mixes these concerns and is not a clean
extraction baseline.

Review: [Joep's complexity comment](https://github.com/ontola/atomic-server/pull/2520#issuecomment-6847397066).
Response: [agreed separation](https://github.com/ontola/atomic-server/pull/2520#issuecomment-6857232831).
Overall tracker: [#2484](https://github.com/ontola/atomic-server/issues/2484).

## Extraction

- [x] Move basic controls, scrolling/resizing helpers, menus, dialogs, popovers
  and their shared contexts into `@tomic/ui`. Keep Atomic boot-splash, welcome
  feedback and routing in thin wrappers. Remove replaced host implementations.
- [x] Make the table package consume these implementations and delete its
  utility copies. Application-wide UI must not depend on the table package.
  EventManager and civil-calendar helpers have one dependency-free source in
  the private `@tomic/utils` build package. SDK/UI distributions include their
  compiled code and declarations, preserving SDK package independence.
- [ ] Extract the complete TablePage, its orchestration, built-in renderers and
  controls. Individual shared widgets are preparation, not completion.
- [ ] Reuse existing field/record, upload, Markdown, collaboration and page
  decoration controls through shared dependencies. Resolve application-system
  boundaries for connections, automations and custom app frames explicitly.
- [ ] Keep only backend boundaries demonstrated by AtomicServer and ELFA:
  queries, metadata/schema, persistence, permissions and navigation. Native
  collection queries and record writes use the public NextGraph ORM.
- [ ] Use the same complete page in both hosts; document unsupported backend
  operations explicitly. Do not emulate missing query capabilities.
- [ ] Verify existing behavior and report moves/deletions separately from added
  production code, tests and tooling. Target roughly 1k lines of added adapter
  and abstraction code; explain excess before expanding scope.

Use a pinned submodule; npm publication is not required. Keep independent CI.
Catalog-based custom-view and lens discovery follows complete page adoption.

The saved-tab presentation seam is omitted from the clean branch: move the
complete existing TableViewTabs with TablePage instead of introducing a partial
widget boundary. Its inactive-rename fix is preserved separately in #2534.

## Deferred functionality

Preserve the previous implementation through `c2b7c72` as reference. Reassess each
improvement against an observable problem after extraction; retaining the old
code does not commit us to retaining every abstraction.

- [ ] Mutation/creation execution guards and undo progress handling
  (#2491, #2492, #2496, #2501).
- [ ] Property commit controllers and prepared-identity retries (#2502).
- [ ] Saved-view ownership/readiness, single-flight initialization, serialized
  writes and command checkpoints (#2503, #2504, #2505).
- [ ] Added stored-config validation and draft/session behavior (#2506, #2507);
  separate existing codecs/query composition from changed readiness semantics.
- [ ] Changed deletion and dialog lifetime/error handling
  (#2516, #2518, #2523, #2524, #2526).
- [ ] Optional host-owned raw text drafts across editor remounts; keep the
  existing local editor state in the extraction.
- [ ] Changed numeric draft validation and value conversion
  (#2519 and mixed field-extraction PRs #2500, #2528, #2531).
- [ ] Scoped quick-add queues and row-selection state (#2527, #2533).
- [ ] Page-owned action/computed/create-button dialogs, tracked write receipts,
  retry/abandonment rules and conflict checks (#2530, #2532).
- [ ] Inactive saved-view rename identity fix from the unpublished work, separate
  from moving the existing saved-tab menus and controls.

## Structural separation of the legacy mixed PRs

Each of the nine identified mixed changes has an intermediate move-only tree
and a separate improvement child. Eight moves have now been rebuilt on the clean
extraction (#2535 / #2536); the query-composition move remains blocked. Preserve
the original review bases for the improvement children until they receive their
own clean-base restacks.

| Original | Code moves | Deferred improvements |
| --- | --- | --- |
| #2500 property choices | #2539 | #2540 |
| #2506 view configuration | #2541 | #2542 |
| #2508 query composition | #2543 | #2544 |
| #2511 filter chips | #2545 | #2546 |
| #2519 property fields | #2547 | #2548 |
| #2527 quick-add bar | #2549 | #2550 |
| #2528 row-action fields | #2551 | #2552 |
| #2531 quick-add fields | #2553 | #2554 |
| #2533 row-selection controls | #2556 | #2557 |

The initial split commits for all nine pairs reproduced the exact complete Git
tree of the original mixed head and included the move parent in their ancestry.
Later improvement audits add explicit fixes/tests described in their own PRs.
The superseded mixed PRs are closed; their original
branches and review history are retained. This proves preservation of the
original result, not that every original behavior improvement is desirable.
Each move was checked with package tests and host type checks; relevant host
regressions ran where the boundary changed. Mandatory commit hooks passed.
Baseline React Compiler diagnostics were reproduced before retaining them.
Full integration CI and the outstanding clean-base restacks remain merge
prerequisites. Nothing is merged by this worker; trekmeester owns merge review.

The independently restacked test-worker policy #2497 (`faa6ba0`) is not part
of the eight-move validation batch. Its 14 package tests and commit hook passed;
its original base remains preserved for #2498. Keep that review separate unless
its configuration change is explicitly included in a later batch.

The move parents preserve existing draft ownership, conversion, lifecycle and
query readiness. Strict validation, scope services, queue isolation, failure
recovery and accessibility additions remain with the improvement children.
Pure state-management PRs listed above are still deferred, not silently merged
into the clean extraction. The public resource/property editor API and ELFA
submodule pin are unchanged. Whole-TablePage extraction and integration remain
unchecked above; these component splits do not complete them.

## Clean move restacks, 18 November

| Move | Clean review base | Restacked head |
| --- | --- | --- |
| #2539 format controls / Float | #2536 | `e48821d` |
| #2541 stored configuration codecs | #2536 | `5c35267` |
| #2545 filter chip | #2541 | `9ca3698` |
| #2547 precision / date format | #2536 | `912992d` |
| #2549 quick-add controls | #2536 | `273c6f5` |
| #2551 action fields | #2536 | `9c9b5e9` |
| #2553 create-button fields | #2536 | `b25afcf` |
| #2556 row-selection controls | #2536 | `5136f63` |

Before replacing any move branch, publish its original head as
`codex/legacy-split-<original-number>-move` and retarget the improvement child to
that identical preserved base. All nine pairs now have that preservation. Their
improvement diffs survive the move restacks without inheriting rewritten bases.

The combined validation branch is `codex/tablepage-clean-restack-validation`.
It combines the eight heads with only export-list/coverage-map reconciliation
and the codec host wrappers taking precedence over earlier type-only moves.
It is a validation batch, not a replacement whole-page implementation or an
authorization to merge. Package build/type checks, the full Data Browser type
check, 39 package tests and 107 affected host tests pass. The latter use this
worktree's real WASM for formula/aggregate coverage. Individual parallel app
type checks ran out of memory; they are not counted as passes. Full Main CI
still needs a completed passing run.

A real Chromium journey also uses the combined actual application and its own
OPFS/WASM database: create a local guest drive, class, table and row through
the SDK, reopen the stored table and toggle row selection. Desktop and touch
mobile journeys pass without page errors. Captures were shown in the task chat
and stay outside Git at `/workspace/artifacts/tablepage-clean-restack-combined`.
These are local-only application checks, not server/ELFA parity evidence.

The eight-move batch adds 752 net browser production TS/TSX lines; together
with the earlier foundation it totals 1,265 (same exclusions: tests,
declarations, documentation, tooling and configuration). The earlier 513
figure remains the two foundation PRs only. The additional public control
types, host mappings and compatibility exports put this expanded preparation
above the rough 1k target; do not present it as a completed-page LOC figure or
expand the architecture to hide that cost. Future whole-page extraction should
remove intermediate host seams where they cease to serve an independent use.

#2543 cannot be retargeted without its missing `TableQuery`,
`TableQueryAggregation`, `TableFormula` and saved-view configuration/readiness
dependencies. Keep those out of this batch while the query boundary is paused.

The nine-pair inventory is not exhaustive of behavior changes in the older
stack. Remaining query/result work (#2487, #2488, #2489, #2509) and deferred
services above are not made mergeable by these restacks. Other controls/forms
(#2498, #2499, #2510, #2512, #2514, #2515, #2517, #2520, #2525, #2529) still need
baseline audits and separation; for example, #2498 removed an explicit save
which the clean format move deliberately preserves. Navigation (#2486),
heading presentation (#2513) and the bounded test-worker policy (#2497) are
potentially independent follow-ups. The original planning PR #2485 is carried
by the clean plan here; the original grid PR #2434 is closed as superseded.
