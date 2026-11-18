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

Keep baseline code moves separate from behavioral proposals, without expanding
the clean extraction or changing ELFA's pin. These are legacy review bases and
still need later clean-base integration.

- [x] Identify input/focus, persistence and range-validation changes.
- [x] Relocate baseline presentation and helpers without fixing old policies.
- [x] Run focused package/real Atomic compatibility tests, compiler/types, real
  component desktop/mobile captures and the mandatory commit hook.
- [x] Preserve original heads and all child review bases before rewriting refs.
- [ ] Publish separate proposed-behavior reviews; preserve the original result.

Explicit text-format save removal is disputed under #2538. Raw range semantics
and submit validation require their own review, not an extraction prerequisite.
