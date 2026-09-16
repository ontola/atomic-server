# Editor typing and formatting history

- Task: 01a09f5b-fcfe-79d2-b9ef-156a0fd04cdb
- Worktree: /private/tmp/atomic-server-editor-typing
- Branch: codex/editor-typing-history
- Base: origin/develop 843060541315962241f52e5447b4aad7971ac691
- Scope: preserve existing Loro identity/history, prevent redundant formatting operations and avoid full-text materialization for ordinary typing.
- Ownership: coordinator owns this plan, documentation/coverage and integration;
  Astra reviews design; Terra `implementation` owns the dependency patch and
  lockfile; Terra `collaboration_tests` owns both `loro-typing-*.test.ts` files,
  synthetic benchmark validation and `browser/e2e/tests/editor-typing.spec.ts`.

## Evidence

Real mixed-format paragraph (667 UTF-16 units): 1,702 historical mark operations. Chrome input processing 205–239 ms. Offline binding reproduction 175–201 ms, with 10 toDelta calls accounting for 170–188 ms. Synthetic typing after an inclusive bold phrase reproduces progressive history growth. Private document data and credentials must never enter this branch or a public artifact; tests use synthetic data.

## Acceptance criteria

- Ordinary inline insertion/deletion/replacement preserves text, marks, container identity, undo and peer convergence.
- Plain typing does not continually rewrite unchanged formatting ranges.
- Existing history-heavy paragraphs do not require repeated whole-run toDelta calls per key.
- Structural/unsupported edits preserve correctness through a safe fallback.
- Unicode/UTF-16, mark boundaries, composition and remote changes are covered at appropriate test layers.
- Validate performance on synthetic accumulated-history fixtures, not wall-clock-only CI assertions.

## Progress

- [x] Diagnosis and user approval
- [x] Isolated branch from fetched develop
- [x] Astra design contract
- [x] Failing regression
- [x] Terra implementation
- [x] Docs and coverage
- [x] Targeted tests, typecheck and browser validation
- [x] Review complete diff
- [ ] PR against develop
- [ ] Exact-head CI green
- [ ] Remove completed plan, push and verify final CI

## Decisions and dependencies

Existing remote-selection patch must be retained. Do not reset/rebuild a user's CRDT to clear accumulated formatting history.

The approved design uses the original ProseMirror transaction to apply a single
inline text replacement directly to its existing LoroText. All structure and
mapping checks happen before mutation; unsupported edits use reconciliation.
Inserted text carries complete marks, while unchanged ranges must not receive
redundant formatting operations. Refresh node mappings through changed ancestors
and preserve the existing appended-transaction commit boundary and origin.

Pinned dependencies installed in this worktree. The pnpm wrapper needs network
access to verify the pinned release; sandboxed invocations hang until that fetch
fails. Escalated installation succeeded without changing dependency versions.

Baseline validation before implementation: data-browser Vitest passed 89 files /
890 tests. `pnpm typecheck` fails at `src/hooks/useFile.test.tsx:36` with TS2352:
its partial mock is cast directly to `ClientDbWorker`. This predates this patch;
do not broaden the feature to repair it. Workspace libraries and WASM built.

First performance regression: 20 plain-tail keystrokes after an inclusive bold
phrase produce 220 `LoroText.prototype.toDelta` calls before the patch and zero
with the guarded inline path. Architectural review caught missing-vs-empty mark
comparison and ambiguous mapping refresh for duplicate paragraphs; both corrected
in staging and receiving regression coverage.

Coordinator reran the original private-snapshot offline benchmark with only its
dependency resolution redirected to this worktree. Stable patched binding:
7.51 ms first edit, then 0.66 / 0.28 ms; all three made zero `toDelta` calls.
Original binding measured 175–201 ms with ten calls. Snapshot remains outside
the repository and is not used by committed tests.

Final implementation uses a serialized ProseMirror step discriminator (safe
under minification) and explicit cache arguments scoped to one reconciliation.
The dependency patch preserves upstream unrelated compiled regions and the
pre-existing atomic selection fix. Astra reviewed cache scope/invalidation.

Validation: imported synthetic fixture retains 600 legacy mark operations and
adds none across 20 plain-tail keys; zero materializations from the first key,
exact text and identity preserved. Ad hoc synthetic dispatch median 0.116 ms.
Full data-browser suite: 91 files / 899 tests passed. Initial native production
GUI run: all four editor/document tests passed in 38.7 s with zero retries.
Final minimal patch built and embedded; second native run passed all four tests
in 26.2 s, zero retries. Data-browser lint passes, and typecheck now reports only
the original useFile mock error. E2E lint and formatting also pass.
