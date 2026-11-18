# Range-policy behavior review

- [x] Preserve original mixed headab17e73 at codex/legacy-tablepage-property-ranges.
- [x] Initial child e5e9630 reproduces the complete original Git tree.
- [x] Remove the now-unused old MinMaxInput implementation; keep one range UI.
- [x] Keep raw validation/form-submit changes separate from the baseline move.
- [ ] Reconcile fractional numeric bounds for integer columns with #2540.
- [ ] Clean-base restacking and full integration CI before any merge.

These are proposed policies, not extraction prerequisites. Integer-valued
columns can have fractional JSON Schema boundaries; the original proposal's
whole-number restriction needs explicit reconciliation before merge. No
Resource/Store/useValue API or ELFA submodule change.
