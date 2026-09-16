# Preserve document undo across view changes

Status: implementation authorized; regression, implementation and CI in progress.

Task: 01a09f60-14c6-7b50-9393-c1201d24d5ae
Worktree: /private/tmp/atomic-server-document-undo
Branch: codex/document-undo-investigation
Base: develop 843060541315962241f52e5447b4aad7971ac691
Ownership: parent owns plan/docs/PR; undo_analysis (Astra-low) architecture review; undo_implementation (Terra) owns RTE code/unit tests; undo_probe (Terra) owns browser regression tests.

## Confirmed failure

Data View removes CollaborativeEditor. Returning retains the exact LoroDoc but creates a new editor and UndoManager. Earlier edits cannot be undone. The focused browser retention test fails on unchanged develop. Ordinary editor blur/refocus preserves both instances.

## Proposed design

- Own rich-text undo managers in a small RTE session registry, outside the React editor. Scope registry by Store and authentication-session generation; key each manager by actual LoroDoc identity using a WeakMap.
- Pass the retained manager through the supported LoroUndoPlugin({ doc, undoManager }) option. Preserve current 100-step / 1000ms grouping defaults. Exclude atomic:system housekeeping changes as well as the binding's sys:init changes.
- On editor detach, remove view-specific selection callbacks while retaining undo/redo stacks. Guard callback ownership so delayed teardown of an old binding cannot clear callbacks installed by a replacement binding. Continue using current-view cursor restoration.
- Invalidate session state on sign-out or agent identity changes, including switching away and back to an agent. Store.setAgent can retain Resource/LoroDoc objects, so doc identity alone is insufficient. Ensure active bindings cannot continue using the previous session manager.
- A replacement LoroDoc gets a fresh manager. Reload persistence is outside this fix; history remains in-memory for the document/session lifetime.
- Keep the document-specific manager separate from Resource.ensureUndoManager: that manager serves property/canvas undo with different grouping behavior.
- Audit the short-lived headless editor path. It must not overwrite or detach callbacks belonging to an active editor; retain the existing preference for dispatching through the registered live editor.

## Acceptance and validation

- [x] Reproduce Data View round-trip loss on unchanged develop.
- [x] Review ownership and lifecycle design.
- [x] Add a lowest-layer regression for manager reuse across plugin detach/reattach, preserving both undo and redo.
- [x] Test document isolation, agent-session reset, doc replacement, callback ownership, and remote changes not becoming local undo entries.
- [x] Implement session registry and editor integration with Terra.
- [x] Convert investigation into focused Playwright coverage: edit -> Data View -> Back -> undo/redo; also undo -> Data View -> Back -> redo.
- [x] Check cursor restoration, autosave and post-undo persistence.
- [x] Document in-memory undo lifetime and update TESTING_COVERAGE.md.
- [ ] Run targeted unit tests, data-browser typecheck, isolated browser tests.
- [ ] Review changes, open PR against develop and follow exact-commit CI.

No router keep-alive changes are needed. The normal view may unmount; its undo history must outlive that view.

Baseline validation: both production browser regressions fail on unchanged develop (zero retries); report `.e2e-runs/2026-09-14T11-41-30.979Z-Nls4ML/report.json`. Review requires explicit disposal of session-invalidated managers and per-editor callback ownership.

Implementation validation: all 10 RTE unit tests pass; the first rebuilt browser run passed both regressions (25.5 seconds, zero retries). Final formatted implementation is rebuilding for these plus the existing document collaboration/migration tests. Full typecheck reports only the unchanged baseline cast error in `browser/data-browser/src/hooks/useFile.test.tsx:36`; targeted lint has no errors.
