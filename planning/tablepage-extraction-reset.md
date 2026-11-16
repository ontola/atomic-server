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

Each original mixed change now has an actual intermediate move-only tree and a
separate improvement child. These pairs retain their original legacy review
bases: they are content splits, not an extraction-only merge stack. Restack the
moves onto the clean extraction (#2535 / #2536), resolving inherited state
changes, before integrating them. Keep the improvement children deferred.

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

For all nine pairs, the improvement child has the exact complete Git tree of
its original mixed head and includes its move parent in its ancestry. Existing
branches and review history are retained. This proves preservation of the
original result, not that every original behavior improvement is desirable.
Each move was checked with package tests and host type checks; relevant host
regressions ran where the boundary changed. Mandatory commit hooks passed.
Baseline React Compiler diagnostics were reproduced before retaining them.
Full integration CI and clean-base restacking remain merge prerequisites.

The move parents preserve existing draft ownership, conversion, lifecycle and
query readiness. Strict validation, scope services, queue isolation, failure
recovery and accessibility additions remain with the improvement children.
Pure state-management PRs listed above are still deferred, not silently merged
into the clean extraction. The public resource/property editor API and ELFA
submodule pin are unchanged. Whole-TablePage extraction and integration remain
unchecked above; these component splits do not complete them.
