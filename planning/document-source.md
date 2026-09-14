# Document HTML source viewer

- Task: 01a09f5c-4e36-70a2-9fd8-f014e349afa7
- Worktree: /private/tmp/atomic-server-document-source
- Branch: codex/document-source
- Base: origin/develop at 843060541
- Ownership: Terra owns frontend implementation/tests; coordinator owns docs, plan, catalogs and validation.

## Acceptance and design

- [x] Astra design: shared resource menu action, DocumentV2 only, available to readers.
- [x] Implementation: lazy dialog showing HTML generated from detached TipTap JSON from existing Loro conversion.
- [x] Tests: rich body, empty/error/loading, read-only/nonmutation, menu eligibility.
- [x] Documentation and coverage map.
- [x] HTML revision: 27 targeted unit tests and 1 Chromium E2E passed; production build and Vite extraction passed. Typecheck has only pre-existing useFile.test.tsx:36 TS2352.
- [ ] Reviewed commit and PR against develop.
- [ ] CI on latest commit, then remove this plan and verify cleanup CI.

Use the menu's subject, including in Data View. Reuse Dialog and CodeBlock with copy.
Do not mount an editor or persist anything. An opening-time snapshot is sufficient.
No unmerged dependencies identified. Original checkout was clean and detached.

User refinement: menu label View as HTML; standard TipTap HTML serializer,
newlines only between top-level blocks. Preserve inline and code whitespace.
PR #1484 exists; original e431bbbda CI is being superseded by this refinement.
Preview: frontend 16759, backend 19884, separate data/config/cache under target/document-source-preview.
