# Missing databrowser translations

Task: translation PR requested in the localhost/account chat, 2026-11-02.
Worktree: `/Users/michieldejong/.codex/worktrees/missing-translations/atomic-server`.
Branch: `codex/missing-translations`; base: `2c35c2a61868760149b35b862d35b412745c5d51`.

## Scope and acceptance

- Fill missing active UI translations for all supported locales: en/es/fr/de.
- Preserve the current terminology, including Private drive. The user explicitly deferred renaming it.
- Preserve existing translations, terminology, interpolation and JSX placeholders. Replace English-only word-suffix assembly with complete messages/plural forms.
- Provide a repeatable audit for empty/missing/fuzzy translations, catalog parity and placeholder errors.
- Verify extracted catalogs and rendered account/settings UI; distinguish completeness from translation quality.
- No changes to account data, live services, sharing permissions or sign-in behavior.

## Ownership

- Coordinator: audit tooling, tests, docs, extraction/builds, integration, PR/CI.
- Planning agent: read-only audit and architecture review.
- Translation agents: disjoint es/fr/de translation maps, then assigned catalog integration.
- Only coordinator runs Vite/extraction. Translation maps live outside the repository until integrated.

## Progress

- [x] Isolated worktree and original checkout baseline.
- [x] Initial parsed audit: 3,018 active messages; 0 missing English, 2,206 Spanish, 2,206 French, 2,989 German.
- [x] Reviewed design and settled extraction baseline through one Vite writer.
- [x] Translate missing entries and validate all forms/placeholders: 3,029 active messages per locale, zero gaps; 7,434 new target-language translations, existing translations preserved.
- [x] Add repeatable audit and meaningful regression tests (15 focused tests pass).
- [x] Update public contributor/user docs and coverage map.
- [x] Build, typecheck, targeted tests and rendered UI verification (3 Chromium locale flows, no retries; screenshots inspected).
- [x] Review complete source/catalog diff; existing translations preserved.
- [ ] Publish PR against develop and follow exact-head CI; remove this plan once required checks pass.

Validation so far: full workspace build/lint and databrowser typecheck pass;
Wuchale full extraction check passes. React compiler diagnostics in ForkBar
and TableViewTabs reproduce on the unchanged base; other changed components
are clean. Production locale E2E verification passes for es/fr/de. CI currently
has no registered self-hosted runners; verify the dispatched exact-head run.
