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
