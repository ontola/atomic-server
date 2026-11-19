# Candidate27 integration

Frozen current develop `9e9017e365a51dddad798bc71f3eb467f4504d3b` plus all 85 open PRs authored by michielbdejong at the recorded snapshot, including all32 drafts. The source heads, patch IDs, duplicate/supersession decisions and integration resolutions are recorded in `candidate27-sources.json`. Previous candidate26/plugin baseline is retained for compatibility and ancestry; this is a broad integration preview, not a clean-extraction LOC claim. No source PR is merged into develop or rewritten.

This candidate includes the complete TablePage extraction, Syncables, per-resource/attachment evidence, automatic storage receipts, Cloud Vault file recovery and the separate component improvements. Conflicting proposals are reconciled explicitly in the manifest. The resource/property editor syntax remains public, generic UI remains canonical, and unsupported executable host views are unavailable rather than pretending to work.

## Validation

- [x] Package-boundary source audit: no host imports, missing local sources or package cycles.
- [x] SDK/UI/grid/resource/page distributions and declarations; complete Atomic app types including tests.
- [x] SDK2316 tests (one existing skip), grid211, shared resource UI104 and complete page667 tests; targeted app/proxy/Syncables121 plus28 host regressions.
- [x] Fresh own Rust/WASM release build and Binaryen117 optimization; all667 page tests pass with real formula WASM.
- [x] Unchanged delivered embed budgets:966.9KB first-use gzip and15.10MB total. Executable frames, specialized resource views and onboarding UI load on actual use.
- [ ] Final full-app unit aggregate, post-fix external package proof and mandatory normal commit hook; rustfmt already passes.
- [ ] Public candidate CI and final review evidence.

## ELFA acceptance remaining

Creating this Atomic candidate does not claim the full page has been integrated into ELFA. Its host must supply actual navigation/menu/comments/app services and supported query/write/history/upload behavior. Atomic CSV export needs a real export capability or an explicit unavailable action. The complete external-backend acceptance gate remains separate from Atomic extraction verification.
