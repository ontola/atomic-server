# Property-name behavior review

- [x] Preserve original mixed head8a8e365 at codex/legacy-tablepage-property-forms.
- [x] Keep name input extraction in its parent review.
- [x] Separate accessible labels/error IDs and disabled presentation.
- [x] Restore baseline delayed focus/reset dependency (original mixed head lost it).
- [x] Keep baseline explicit text-format save; hold removal separately under #2538.
- [x] Validate package/host tests, package types, compiler, actual component
  desktop/mobile accessibility checks and the mandatory commit hook.
- [ ] Clean-base restacking and full integration CI before any merge.

No Resource/Store/useValue contract or ELFA submodule change. This legacy-base
proposal still needs later clean-base restacking/full integration CI.

# Legacy schema review content separation
# Range-policy behavior review

- [x] Preserve original mixed headab17e73 at codex/legacy-tablepage-property-ranges.
- [x] Initial child e5e9630 reproduces the complete original Git tree.
- [x] Remove the now-unused old MinMaxInput implementation; keep one range UI.
- [x] Keep raw validation/form-submit changes separate from the baseline move.
- [ ] Reconcile fractional numeric bounds for integer columns with #2540.
- [ ] Clean-base restacking and full integration CI before any merge.

- [x] Identify input/focus, persistence and range-validation changes.
- [x] Relocate baseline presentation and helpers without fixing old policies.
- [x] Run focused package/real Atomic compatibility tests, compiler/types, real
  component desktop/mobile captures and the mandatory commit hook.
- [x] Preserve original heads and all child review bases before rewriting refs.
- [ ] Publish separate proposed-behavior reviews; preserve the original result.

Explicit text-format save removal is disputed under #2538. Raw range semantics
and submit validation require their own review, not an extraction prerequisite.

## Held text-format save proposal (#2538)

This child isolates the explicit save removal from original #2498. It is not a
merge candidate until the persistence/editing contract is resolved. Removing
this call alone does not guarantee a private draft or durable local storage;
set() can independently enqueue existing owned resources. No UI markup changes.
These are proposed policies, not extraction prerequisites. Integer-valued
columns can have fractional JSON Schema boundaries; the original proposal's
whole-number restriction needs explicit reconciliation before merge. No
Resource/Store/useValue API or ELFA submodule change.
