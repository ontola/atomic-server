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
- [x] Add a publication query shared by both templates. Today `publishedAt` is
      only used for sorting, so future-dated or otherwise unpublished posts are
      still rendered. **Done (2026-08-14):** both templates drop forks and
      blog posts with a missing or future `published-at` from listings, search,
      and path routing. A scheduled 2030 post is seeded in the Website template
      and asserted in `template.spec.ts`. This is still presentation, not an
      ACL — a public Drive will serve the resource over HTTP.
- [x] `/` is the Website resource's `homepage` property, not whichever page
      happens to have path `/`. Changing homepage in the Data Browser changes
      the site root. **Done (2026-08-14).**

### Editing from the website

- [x] Record the existing Data Browser contract:
      `/app/edit?subject=<resource>` and Cmd/Ctrl+E inside Data Browser.
- [x] Add a configurable CMS origin to generated sites and use it for a
      Cmd/Ctrl+E deep link. Do not assume the content server and Data Browser
      have the same origin. **Done (2026-08-14):** `--cms-url` (defaults to
      `--server-url`) writes `ATOMIC_CMS_URL`; Cmd/Ctrl+E and **Edit this page**
      open `/app/edit?subject=…`.
- [x] Add a small authenticated edit affordance for editors; it must not embed
      credentials or private agent material in the public bundle.
      The link is public; sign-in happens in the Data Browser.
- [ ] Decide whether "in-page editing" means navigation to Data Browser,
      an extracted shared editor surface, or framework-native fields backed by
      `@tomic/react` / `@tomic/svelte`. Avoid duplicating the existing editor
      behavior independently in both templates.

### Internationalization

- [x] Record the current boundary: Wuchale translates Data Browser chrome only;
      content uses document-level `language` + `translationOf`.
- [x] Locale on each page/post (`language`) and `defaultLanguage` / `languages`
      on the website resource. Templates route `/nl/...`, emit `hreflang`, and
      keep the language prefix on nav links **and blog cards**.
- [x] E2E: two locales (en default, nl balloon post), `<html lang>`, nav prefix
      (`template.spec.ts` `assertTwoLocaleSite`), blog-card prefix
      (`assertLocaleBlogCards`).
- [x] `/sitemap.xml`, `/robots.txt`, `/rss.xml` from the same public-content
      filter. Scheduled posts and forks are omitted. **Done (2026-08-14).**
- [x] E2E: `/` serves `website.homepage` when that is About (path `/about`),
      and a renamed fork of About does not replace the published page.
- [x] Generated pages are CDN-friendly: Next.js prerender/ISR, SvelteKit SSR
      with `Cache-Control: public, s-maxage=60, stale-while-revalidate=86400`,
      correct `<html lang>` and body content on the first HTML byte (no JS).
      Blog search is client-side so `/blog` stays cacheable. Empty listings
      retry then expire instead of baking forever. **Done (2026-08-14).**
- [ ] Separate translated content resources from translated template chrome
      (template UI strings are still English).

## Decisions still open

- Should import eventually return a `localId -> subject` map to remove the
  post-import query, or is `(drive, localId)` discovery the intended contract?
- What is the publish operation between private authoring resources and public
  pages: copy, explicit diff approval, or another signed mutation workflow?
- Should the template ontology migrate directly to the canonical `path`
  property, and what compatibility behavior is needed for existing sites?
