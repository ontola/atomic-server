# Dutch and Indonesian interface languages

Task: additional language PR requested in the localhost/account chat, 2026-11-02.
Worktree: `/Users/michieldejong/.codex/worktrees/dutch-indonesian/atomic-server`.
Branch: `codex/dutch-indonesian`.
Base: `34650827ae216ca463e6bf2ac689d379e92347fc`, PR #2430 (`codex/missing-translations`).
This PR stacks on #2430 to reuse its complete source catalog and CI audit;
retarget to develop after that dependency merges.

## Acceptance and ownership

- Complete Dutch (`nl`) and Indonesian (`id`) catalogs matching all 3,029 active source messages.
- Both languages selectable and detected from browser preferences; saved selections survive reloads.
- Dutch has two plural forms; Indonesian has one, with variable counts preserved.
- All six catalogs pass the CI audit. Existing terminology and user content stay unchanged.
- Coordinator: catalog integration, single Vite writer/builds, docs, review and PR/CI.
- Dutch and Indonesian agents: disjoint translation maps outside the repository.
- Planning/implementation agent: bounded locale/plural design, then assigned source/tests.

## Progress

- [x] Isolated checkout and saved original checkout baselines.
- [x] Review design: register nl/id, retain existing loader, and audit single-form plural targets against the source plural variant.
- [x] Implement locale configuration/plural support.
- [x] Fill and validate both catalogs.
- [x] Add browser-language, plural and production locale regression coverage.
- [x] Update user/contributor documentation and coverage map.
- [x] Build, lint, typecheck, tests and screenshots.
- [x] Review changes and open the stacked PR.
- [ ] Observe exact-head CI and remove this plan after required checks pass.

## Plural-library compatibility

Wuchale 0.25.6 checked target plural counts against the English form count and
compiled one-form target plurals as ordinary strings. Reproduced both with
isolated library fixtures, then extended the existing dependency patch to use
target `nplurals` for validation and source message shape for compilation.
The actual compiler now exports the Indonesian plural rule and produces correct
0/1/2 counts. Lockfile changes only update the existing patch hash.

## Existing source gaps found during review

Separate follow-up: AuthorizeMcpRoute and ConnectAgentRoute interpolate
unextracted English `read` / `read and edit`; DerivedColumnDialog interpolates
an unextracted English suggestion. These require complete source sentences
and updates to all existing locales, outside this language-addition PR.
The new catalogs cover all 3,029 extracted messages; that does not claim
every existing source literal is localized.

## Validation

- Full workspace build and final E2E production/native asset build pass.
- 30 focused Vitest tests pass; all six catalogs have 3,029 active messages
  and zero audit issues. Read-only Wuchale full check passes.
- Full browser lint, data-browser and E2E TypeScript, rustfmt pass.
- Native Chromium: 7/7 pass, zero skips/retries/flakes, 52.3 seconds.
  Run `.e2e-runs/2026-11-02T10-02-42.860Z-pIqqJ5`; screenshots shared in chat.
- Original four catalogs remain unchanged. Original checkout and parent
  feature checkout match recorded status baselines.

PR: https://github.com/ontola/atomic-server/pull/2433 (ready for review).
Required exact-head main CI remains pending; retain this plan until it passes.
