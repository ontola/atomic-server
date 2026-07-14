# Website templates and CMS workflow

> **Status:** template repair complete, CMS product work active, July 2026.
> Next.js and SvelteKit generation now work after the DID migration. Drafts,
> editing from a generated site, content i18n, and canonical path migration
> remain product work rather than template-repair follow-ups.

## Goals

- [x] Generated Next.js and SvelteKit sites work with a `did:ad:` drive.
- [x] Re-enable and pass both website-template E2E tests.
- [x] Keep transport origin, drive identity, ontology identity, and website
      identity as separate values.
- [x] Scope page and blog queries to the configured website/drive.
- [x] Establish a concrete direction for drafts, editing from the published
      site, and i18n.

## Verified breakage

- [x] The E2E passes `drive.driveURL` (now a DID subject) as `--server-url`.
      `Store`, HTTP fetch, and WebSocket code require an HTTP(S) origin.
- [x] The scaffolder derives the ontology and website subjects as
      `${serverUrl}/website` and `${serverUrl}/<localId>`.
- [x] DID-parent imports cannot derive child identities from paths. Every new
      imported resource is genesis-signed into an independent DID, with
      `parent` and `localId` retained for discovery and idempotent re-import.
- [x] `Store.importJsonAD()` discards the import response, so the browser UI
      and scaffolder cannot consume the actual local-ID-to-DID mapping.
- [x] The Apply Template dialog still predicts `${drive}/${localId}` for DID
      drives and navigates to a subject that was never minted.
- [x] Generated page and blog queries are global. Two websites with `/about`
      or blog posts on the same server can collide.
- [x] The website ontology uses a template-local `path` property while server
      host routing understands the canonical Atomic `path` property.

## Completed repair

- [x] Reserve DIDs for all imported local IDs before materializing resources,
      then rewrite forward references, cycles, and property subjects to those
      reserved DIDs in one import pass.
- [x] Make local-ID import idempotent under a DID parent, including nested
      resources.
- [x] Resolve imported resources by `(drive, localId)` after import. The import
      response remains unchanged; consumers no longer predict path subjects.
- [x] Update Apply Template navigation and already-applied detection to query
      the actual imported DID under the selected drive.
- [x] Change `@tomic/create-template` inputs to require both
      `--server-url <http>` and
      `--drive <did-or-url>`.
- [x] Resolve ontology and website resources by `(drive, localId)` and write
      their real subjects to `atomic.config.json` and `.env`.
- [x] Use direct HTTP reads in the generation CLI so WebSocket commit messages
      are not mistaken for complete resources.
- [x] Add the configured drive/site boundary to generated collection queries.
      Full-text search uses the actual Blog posts folder DID because `parents`
      is a direct-parent scope, not an ancestor/drive scope.
- [x] Update generated dependencies and build configuration. Next uses a
      patched Next 16 release; SvelteKit handles Loro WASM and top-level await.
- [x] Fix React server snapshots and the Svelte resource proxy so generated
      sites can render through React 19 SSR and Svelte SSR/hydration.
- [x] Re-enable Next.js and SvelteKit tests and verify generation, ontology
      generation, production build, homepage, blog routing, and search.

## Validation

- [x] `cargo test -p atomic_lib --no-default-features parse::test`
      (12 passed, 1 ignored).
- [x] `@tomic/create-template`, `@tomic/cli`, `@tomic/react`, and
      `@tomic/svelte` focused build/type/lint checks.
- [x] `template.spec.ts` in serial mode (Next.js and SvelteKit: 2 passed).

## CMS product concerns

### Drafts and concepts

- [ ] Define publication visibility independently from write permission.
- [ ] Ensure public templates never render drafts merely because their
      resources are readable.
- [x] Record the current security boundary: rights inherited from a public
      drive are additive, so a confidential draft cannot safely be a hidden
      child of that drive.
- [ ] Put confidential drafts in a private authoring resource/drive and publish
      by explicitly copying or applying an approved diff to the public page.
      A status or `publishedAt` property alone is presentation metadata, not an
      authorization boundary.
- [ ] Add a publication query shared by both templates. Today `publishedAt` is
      only used for sorting, so future-dated or otherwise unpublished posts are
      still rendered.

### Editing from the website

- [x] Record the existing Data Browser contract:
      `/app/edit?subject=<resource>` and Cmd/Ctrl+E inside Data Browser.
- [ ] Add a configurable CMS origin to generated sites and use it for a
      Cmd/Ctrl+E deep link. Do not assume the content server and Data Browser
      have the same origin.
- [ ] Add a small authenticated edit affordance for editors; it must not embed
      credentials or private agent material in the public bundle.
- [ ] Decide whether "in-page editing" means navigation to Data Browser,
      an extracted shared editor surface, or framework-native fields backed by
      `@tomic/react` / `@tomic/svelte`. Avoid duplicating the existing editor
      behavior independently in both templates.

### Internationalization

- [x] Record the current boundary: Wuchale translates Data Browser chrome only;
      the website content model is scalar and both templates hardcode
      `<html lang="en">`.
- [ ] Model locale explicitly; do not infer content language only from UI
      chrome or browser locale.
- [ ] Prefer localized content resources linked by a stable translation key,
      with `locale` on each resource and `defaultLocale` on the website.
- [ ] Decide locale-aware path uniqueness, routing, and fallback rules, for
      example `/en/about` and `/nl/over` within one website.
- [ ] Separate translated content resources from translated template chrome.
- [ ] Add E2E coverage for at least two locales before claiming i18n support.

## Decisions still open

- Should import eventually return a `localId -> subject` map to remove the
  post-import query, or is `(drive, localId)` discovery the intended contract?
- What is the publish operation between private authoring resources and public
  pages: copy, explicit diff approval, or another signed mutation workflow?
- Should the template ontology migrate directly to the canonical `path`
  property, and what compatibility behavior is needed for existing sites?
