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
- [ ] Make the table package consume these implementations and delete its
  utility copies. Application-wide UI must not depend on the table package.
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
- [ ] Changed numeric draft validation and value conversion
  (#2519 and mixed field-extraction PRs #2500, #2528, #2531).
- [ ] Scoped quick-add queues and row-selection state (#2527, #2533).
- [ ] Page-owned action/computed/create-button dialogs, tracked write receipts,
  retry/abandonment rules and conflict checks (#2530, #2532).
- [ ] Inactive saved-view rename identity fix from the unpublished work, separate
  from moving the existing saved-tab menus and controls.

Do not treat the existing mixed PRs as extraction-only or merge the old stack
as completion of TablePage. Keep them in draft while separating their changes.
