# Convert uploaded files to documents

Task: 01a09fa3-3aaf-7900-8932-9e5957582bc6
Worktree: /private/tmp/atomic-server-convert-document
Branch: codex/convert-file-to-document
Base: origin/develop, 843060541

- [x] Design: explicit in-place conversion for Markdown/plain text; preserve subject, parent, permissions, and source blob metadata. Use local-first file URL and existing collaborative editor schema/Loro writer. Plain text remains literal.
- [x] Implementation and regression tests (Terra: browser/data-browser source/tests).
- [x] Public docs and test coverage (coordinator).
- [x] Targeted tests, frontend typecheck, localization extraction and review.
- [ ] PR against develop and exact-commit green CI.

Acceptance: only supported files expose action to writers; failures preserve original file; successful conversion opens an editable current-format document with formatting/line breaks preserved. No fresh Loro document replaces existing history. Source bytes remain referenced. Coordinator owns this plan, docs, coverage, and generated catalogs.

Review decisions: stage against cloned existing Loro history, bypass live editor registry during staging, reject concurrent conversion before merge. Persistence failure keeps the local document and exposes a retry toast; pre-merge failures leave File untouched. Original bytes stay referenced by the retained blob property.

Validation: 12 focused conversion/file-preview tests pass; full frontend typecheck and targeted lint/format pass. Fixed an existing partial ClientDbWorker test-stub cast to unblock typecheck. Chromium module checks exercise the real editor and Loro pipeline with persistence mocked: Markdown, literal text, filename-only uploads, required document name, actual blob DID and ACL preservation, permission denial, 404 and save rejection. Vite exposed an error-constructor localization hook bug; ignored the internal error literal and retested successfully. Catalog extraction reviewed and unrelated churn removed.
