# Drive root file dropzone

Task: 01a09f4f-0cc0-79b1-a3c3-2ab8ddfad275
Worktree: /private/tmp/atomic-server-drive-root-dropzone
Branch: codex/drive-root-dropzone
Base: 843060541315962241f52e5447b4aad7971ac691 (origin/develop)

- [x] Design: reuse FileDropZone around drive content with the viewed resource as parent; preserve existing upload and folder behavior.
- [x] Implementation (Terra owns DrivePage.tsx and regression tests).
- [x] Public docs and coverage map (coordinator).
- [x] Targeted tests (single/multiple drops) pass; typecheck run with only pre-existing TS2352 in useFile.test.tsx:36. Targeted lint and formatting pass.
- [ ] Reviewed commit and PR against develop.
- [ ] CI green on final commit; remove this completed plan.

Acceptance: dropping one or multiple files in drive root uses that drive as parent, including when settings.drive differs. Existing progress/error feedback remains available and children refresh through useChildren. No protocol or persistence changes and no new rendered strings are needed.
