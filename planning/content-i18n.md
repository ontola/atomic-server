# Content i18n: localized resources, not localized values

> **Status:** LocalizedText + template locales shipped (2026-07). Remaining:
> TranslationsBar UI, `useTranslation` sibling resolution, `/query` `lang`,
> search language filter. Issue #1069, milestone 11 (Local-first headless CMS).
> Supersedes the `TranslationBox` concept in
> `docs/src/schema/translations.md` (2020, pre-Loro, pre-DID). Companion to
> [`website-templates.md`](./website-templates.md) §Internationalization and
> [`drafts-and-suggestions.md`](./drafts-and-suggestions.md).
>
> **Sequencing amendment (2026-07-20):** `LocalizedText` was built ahead of
> the document-level tooling and without waiting for the primitive-first
> `Value` reshape — the reshape collapses variants Loro can't distinguish,
> whereas `LocalizedText` is a tagged structural shape (like `json`) and
> survives it. Build progress tracked in the checklist at the bottom.

## The question

Users publishing content through AtomicServer need per-language editing so one
site can serve `/en/about` and `/nl/over`. #1069 lists two approaches — a
`LocalizedText` datatype (a map of language tag → string inside one value) and
locale-per-branch. The CMS industry split the same way: Contentful is
field-level (localized values inside one entry), Strapi is document-level (one
entry per locale, linked). Sanity supports both and steers long-form content to
document-level.

## Decision

**Document-level localization: a translation is an ordinary resource.** It
carries a `language` (BCP 47 tag) and points at the canonical resource via
`translationOf`. No new datatype, no new `Value` variant, no branch primitive.

- **Locale-per-branch is rejected**, permanently. A second lineage on one
  subject is exactly the divergence bug `loro-source-of-truth.md` documents
  ("every later commit re-merged two divergent branches as LWW — silently
  dropping writes at random"), and `drafts-and-suggestions.md` already rejected
  branch-backed drafts for the same reason. Translations are worse than drafts
  here: they are *permanent* parallel content that never merges back.
- **A `LocalizedText` datatype is deferred, not rejected** — see below.
- **`TranslationBox` (a property per language,
  `https://atomicdata.dev/languages/{tag}`) is dead**: it multiplies property
  resources per language, predates the DID migration, and everything it did is
  covered more cheaply by either of the two live approaches.

### Why document-level wins here

1. **Long-form content forces it.** A DocumentV2 body is a Loro CRDT `doc`
   container, not a scalar propval — a field-level map of strings can never
   hold it. A translated document must be a separate resource with its own
   Loro doc. Since the flagship CMS content type needs document-level anyway,
   start with the mechanism that covers everything.
2. **It is almost free.** Two new default properties plus one on the site
   root. No `DataType`/`Value` variant, no Loro `datatypes`-map tag, no
   Rust↔TS lockstep serialization change, no search-schema change. (Compare:
   a new datatype touches ~10 files across `datatype.rs`, `values.rs`,
   `parse.rs`, `serialize.rs`, `loro.rs`, `datatypes.ts` — and lands in the
   middle of the pending primitive-first `Value` reshape, 704 call sites.)
3. **Everything already built composes with it.**
   - *Queries:* "give me the `nl` pages" is an ordinary `PropVal` filter —
     exactly what the in-progress `multi-property-filter.md` work enables.
   - *Drafts/publishing:* visibility is location, per locale for free — the
     `nl` translation sits in Drafts until it is moved to the public folder.
     Half-translated sites need no special state.
   - *Discovery:* "which translations exist?" is the same drive-scoped reverse
     query the PendingForks bar already runs on `originalSubject`.
   - *Permissions/zones:* a translator can be granted write on just the `nl`
     resource. Field-level can never scope rights to one language.
   - *Paths:* `/en/about` vs `/nl/over` fall out naturally — each translation
     has its own `href`/`path` value.
4. **Per-request bandwidth stays shaped like the request.** The field-level
   approach ships every language on every fetch (the concern #1069 itself
   raises); document-level ships one.

The honest cost (the classic Strapi complaint): **shared, non-textual fields
drift.** Cover image, author, dates exist once per locale, and an edit to the
original does not propagate. Mitigations below; this is the price of the
approach and it is worth paying.

## The model

| Term | On | Datatype | Meaning |
| --- | --- | --- | --- |
| `language` | any content resource | string (BCP 47, e.g. `nl`, `en-US`) | The language this resource's content is written in. |
| `translationOf` | a translation | atomicURL | The canonical resource this translates. Canonical = the one *without* `translationOf`; it carries `language` too. |
| `defaultLanguage` | site root (Website / Drive / folder) | string | Fallback language; also the language assumed for untagged legacy content. |
| `languages` | site root, optional | JSON array of tags | Declared locales, for pickers and generated routing. Derivable from content; this is a UI/codegen hint. |

- New core defaults in `lib/defaults/` (like `Fork`/`originalSubject`) — these
  are generic, not website-ontology-specific. **Inherits the known bootstrap
  gap** (`drafts-and-suggestions.md` §Known gap): existing stores don't pick up
  new defaults without `--repopulate-defaults` / a rebuilt wasm bundle. i18n
  ships behind whatever migration story closes that.
- `translationOf` points at the canonical resource, not at a minted
  "translation key". Asymmetric on purpose: it matches the `originalSubject`
  precedent, needs no key uniqueness machinery, and makes the reverse query
  trivial. Deleting the canonical orphans translations — same failure class as
  deleting any link target; acceptable.
- Fallback chain when resolving a resource for language `L`: exact tag →
  primary subtag (`en-US` → `en`) → `defaultLanguage` → the canonical resource.

### The Translate flow

A **Translate** action in the actions registry (context menu, ⌘K, MCP surface
for free). It creates a *copy* — propvals seeded from the original, a **fresh**
Loro doc (unlike a Fork, a translation diverges forever and never merges, so
sharing causal history with the original buys nothing and reintroduces
merge-surface) — then sets `language` + `translationOf` and drops it in the
Drafts folder. The translator edits and publishes by moving, like any draft.

This is also a natural LLM surface: the assistant/json-ad-compact tooling makes
"machine-translate this page, human reviews the draft" an agent skill with no
new plumbing.

### Serving and routing

- **Templates (the seam that matters).** `getCurrentResource.ts` already
  resolves drive-scoped `href == path`; locale-aware routing is
  `/{lang}/{path}` → filter `language == lang AND href == path`, falling back
  per the chain above. Templates read `defaultLanguage`/`languages` from the
  site root, set `<html lang>` (currently hardcoded `"en"`) and emit
  `hreflang` alternates from the translation set.
- **Server:** an optional `lang` param on the `/query` endpoint
  (`server/src/plugins/query.rs`) as sugar over the filter + fallback, so
  non-SDK HTTP consumers get it too. `Accept-Language` negotiation on the HTML
  view is a later nicety, not core: local-first clients replicate the whole
  drive and pick client-side anyway.
- **Search:** `/search` gains a `language` filter (resources carry one
  language, so this is a plain field filter — no per-language index schema).
  Per-language tokenizers/stemmers in Tantivy are future work.

### Shared-field drift mitigations (v1: render-time, no sync magic)

- Render/SDK helper (`useTranslation(resource, lang)` and the Svelte
  equivalent): resolves the right translation, and for a property *missing* on
  the translation falls back to the canonical resource's value. Translators
  then simply omit shared fields (cover image, author) instead of copying
  them, and the drift problem mostly disappears for fields that were never
  duplicated.
- Requires the Translate action to seed only *content* propvals worth
  translating, not blindly everything — the copy step is where "shared vs
  translated" is decided. Rule of thumb: copy text fields, omit the rest.
- A "translation is stale" indicator (canonical's `lastCommit` newer than the
  translation's) is a cheap UI affordance, later.

## Structured content: the field-level `LocalizedText` layer

Document-level assumes the unit of translation is a whole resource. That
breaks down for **componentized pages** — a landing page whose header labels,
hero, and feature cards are mostly *structure* with short strings inside:

- One-resource-per-locale duplicates the structure. Add or reorder a card in
  `en` and every locale must repeat the edit; icons, links, and layout drift.
- Fragmenting every string into its own translatable leaf resource (so
  structure stays shared and only leaves get locale siblings) is absurd
  overhead for a heading.

So the model has two shapes, split by what varies per locale:

| Content shape | Mechanism |
| --- | --- |
| Whole-entity content: own URL/slug/SEO, long-form body, diverges per locale (blog post, document, page) | document-level (`language` + `translationOf`) |
| Shared-structure fragments: nav/header labels, buttons, feature cards, alt-text, product catalogs | field-level `LocalizedText` |

This is the layering the mature CMSes converged on (Sanity's guidance is the
same split). Field-level mechanics are bounded and known:

- `Value::LocalizedText(BTreeMap<tag, String>)`, URL
  `.../datatypes/localizedText`; validation checks tag shape per key.
- Loro: a native LoroMap keyed by tag → **per-language LWW registers**, so two
  translators editing different languages merge cleanly; one `localizedText`
  entry in the sibling `datatypes` tag map; TS `datatypeTag` in lockstep.
- **Works inside nested resources.** A `FeatureCard` as a `NestedResource`
  resolves real Properties, so its `name`/`description` can be
  `LocalizedText` while the card list, order, icons, and links live once on
  the shared page. Raw `Json` blobs are opaque to the datatype machinery —
  translatable structured content must be modeled as (nested) resources with
  real properties, not stuffed into JSON.
- One shared fallback resolver: `useTranslation` resolves document-level
  siblings *and* flattens `LocalizedText` maps with the same
  exact → subtag → `defaultLanguage` chain.
- Sorting uses the `defaultLanguage` value in `to_sortable_string`; search
  indexes all languages via the generic `propvals` JSON field (per-language
  tokenizers stay future work). Forms get a language-tabbed text input.
- **Wire format: plain JSON, per the `Json`-datatype precedent.** In JSON-AD
  the value is a bare object keyed by tag —
  `"name": {"en": "Fast sync", "nl": "Snelle synchronisatie"}` — no wrapper;
  the shape is determined by the Property's datatype, so `parse_propval`
  reads it unambiguously. JSON-LD exports as a native language map
  (`"@container": "@language"`), Turtle/RDF as language-tagged literals
  (`"…"@nl`) — lossless standards mapping, better than TranslationBox
  achieved with nested resources.

**Sequencing: second, but with a concrete trigger — not "if ever".**
Document-level ships first because it is near-free and required for documents
regardless; the `Value`-enum addition should land after (or together with) the
primitive-first reshape decision (loro-source-of-truth Phase 1.6) rather than
adding a 14th variant to an enum slated for collapse. The trigger: the first
template or ontology with componentized pages (feature sections, site-chrome
strings) schedules this layer.

**Interim patterns until the datatype exists:**

- A per-locale *strings-bundle* resource (`SiteChrome` `nl`/`en` siblings via
  `translationOf`) for header/nav/button labels — a flat bundle where
  missing-key fallback covers drift. This handles site chrome acceptably in
  v1.
- Per-locale section/card sibling resources plus the transitive link swap in
  the resolver, where fragments are worth their own subjects.
- **Not** an ad-hoc `{en: …, nl: …}` map in a `Json` property: it works
  mechanically (native LoroMap and all), but it is schema-invisible — forms,
  validation, search, and the eventual migration to the real datatype all
  lose. If we are tempted to do this, that is the trigger firing: ship the
  datatype instead.

## Implementation phases

1. **Vocabulary + validation.** `language`, `translationOf`,
   `defaultLanguage`, `languages` in `lib/defaults/`; BCP 47 shape check on
   write (warning, not rejection). Blocked on the defaults-bootstrap
   migration story.
2. **SDK.** Reverse-query helper (translation set of a resource), fallback
   resolver, `useTranslation` in `@tomic/react` / `@tomic/svelte`.
3. **Translate action + UI.** Actions-registry verb; a TranslationsBar on the
   resource (sibling of ForkBar) listing existing translations and offering
   Translate-to-X; language picker sourced from `languages`.
4. **Templates.** Locale-prefixed routing + fallback in both templates,
   `<html lang>`, `hreflang`; scaffolder writes `defaultLanguage`. E2E: a
   two-locale site where `/nl/over` serves the Dutch page, `/nl/missing`
   falls back per the chain, and an unpublished translation is invisible —
   the acceptance bar `website-templates.md` already set.
5. **Server sugar.** `lang` on `/query`; `language` filter on `/search`.
6. **`LocalizedText` datatype** (structured content, see above). Gated on the
   Phase 1.6 primitive-first `Value` decision; triggered by the first
   componentized-page template/ontology. Includes the language-tabbed form
   input and extending `useTranslation` to flatten localized values.

## Open questions

- **`language` vs `locale` naming.** Leaning `language` (BCP 47 calls them
  language tags; tags can still carry region, `nl-BE`).
- **Canonical-resource asymmetry.** If the `en` original is deleted or the
  site's primary language changes, re-pointing `translationOf` on every
  sibling is manual. A symmetric shared-key model avoids this at the cost of
  key-minting; not worth it until it hurts.
- **Path property migration.** Locale routing builds on the template-local
  `href` today; `website-templates.md` already questions migrating to the
  canonical `path` property — decide there, i18n follows.
- **Link resolution across locales.** A relation (e.g. blogpost → author page)
  points at one concrete resource; rendering the `nl` site should swap link
  targets to their `nl` siblings. Helper-level concern; needs a decision on
  whether the fallback resolver does this transitively.
- **`LocalizedText` flavor.** Plain text or markdown-capable (the old
  TranslationBox spec said markdown)? One datatype or a
  `localizedString`/`localizedMarkdown` pair mirroring the existing
  string/markdown split? Affects forms and rendering, not storage.
- **Per-language search tokenization** (stemming per tag) — future Tantivy
  work, independent of the model.

## Completeness visibility (decided 2026-07-21)

"Which translations are missing?" is not a new view type — it is the absence
of a *contract*. Three decisions (from design discussion), layered on the
scope's declared `languages`:

1. **The declared set is an enum, not a suggestion.** When a drive declares
   `languages`, language pickers (form input, cell switcher) offer exactly
   declared ∪ present — no free tag entry. Free BCP 47 entry remains only for
   scopes that declare nothing. Declared-but-absent languages render as
   visibly empty rows / `(empty)` options, and absence *is* the missing
   state.
2. **One global content language.** `contentLanguage` in AppSettings
   (persisted, distinct from the wuchale UI chrome language), switchable from
   the navbar (shown only when the drive declares languages). Every
   `localizeText` surface resolves through it, so switching flips whole
   table columns at once — and a **missing** translation renders as a dimmed
   fallback with a warning dot (`LocalizedTextValue`), never silently as if
   translated. A table column in language X is thereby an audit of X.
3. **Split a LocalizedText column into per-language sub-columns** (virtual
   columns: `TableColumn = {property, languageTag?, key}` wrapper over the
   grid's `Property[]`, toggle in the column header menu, persisted on the
   View via `view-split-languages` like `viewColumns`). Rows × languages is
   the translator's matrix, built from the existing table — a dedicated
   Translation view type was considered and rejected as a parallel surface
   that would duplicate sorting/filtering/editing and drift.
   **Every cell write path must be language-scoped** (fixed 2026-07-21 after
   real data loss): type-over-to-edit, paste, and clear-cells all previously
   built the new value from `undefined`/whole-property semantics, wiping the
   other languages of the map — they now spread the existing map and touch
   only the target tag (`TableCell.handleEnterEditModeWithCharacter`,
   `useHandlePaste`, `useHandleClearCells`; clear is sequential per resource
   because parallel read-modify-writes on one map race). Copy still copies
   the whole property — cosmetic, not lossy.

**Discoverability (user feedback, iterated to):** a LocalizedText column
header shows a **language chip** (`ColumnLanguageChip`) next to the kebab —
the current content language on a normal column, the fixed tag on a split
column (which therefore no longer suffixes the header text). Clicking the
chip opens the language controls: switch content language (app-wide,
check-marked), Split/Unsplit, and **"Edit languages…"**
(`EditLanguagesDialog`), which edits the drive's declared `languages` set —
the bootstrap path from "nothing declared" to a working picker/enum/
missing-state; saving keeps `contentLanguage` inside the new set. With the
chip making the edited language visible, the **in-cell tag switcher was
removed**: a cell always edits exactly one language (split tag, else
content language), matching the type-over/paste/clear semantics. The kebab
menu carries no language items; the navbar switcher is secondary and only
appears when the drive declares languages. All three mechanisms shipped 2026-07-21: checks
green (typecheck baseline-only, lint 0, data-browser 116 + lib 185 tests);
in-browser verification still pending.

Document-level completeness (missing *sibling resources*) is not a grid
concern — it stays with the planned TranslationsBar (chips per declared
language on the canonical resource) and, later, a drive-wide saved query.

## Build checklist (LocalizedText layer, started 2026-07-20)

- [x] **Rust core:** `DataType::LocalizedText` + URL constant;
      `Value::LocalizedText(BTreeMap<tag, String>)`; BCP 47 key check
      (`LANG_TAG_REGEX`); `parse_propval` arm; native JSON-AD serialization +
      JSON-LD `@language` container; Loro `set_property` native LoroMap +
      `localizedText` tag round-trip (tolerates legacy JSON-stringified);
      `to_localized_string` fallback resolver; sortable-string rule
      (`en` → first key); unit tests incl. Loro snapshot round-trip.
- [x] **Defaults:** `localizedText` Datatype resource (`default_store.json`);
      `i18n.json` ontology with `language`, `translationOf`,
      `defaultLanguage`, `languages`; imported in `populate_default_store`.
      Bootstrap gap applies — existing stores need `--repopulate-defaults`.
- [x] **TS `@tomic/lib`:** `Datatype.LOCALIZEDTEXT`, `validateDatatype`,
      `datatypeTag` lockstep, `localizeText` resolver, `i18n` ontology
      binding, and a native-LoroMap write path in `loroSetProperty`
      (in-place key updates preserve container identity → per-language
      merge from the browser too), tests.
- [x] **Data-browser UI:** `InputLocalizedText` (per-language rows +
      validated add-language, registered in `InputSwitcher`),
      `LocalizedTextCell` (displays resolved language; edit mode has a
      language switcher — select over existing tags plus a validated
      add-language input — editing the selected tag's string),
      `ValueComp` read-only branch (`localizeText(value, navigator.language)`
      with an "N languages" hint), New Column category + datatype picker +
      `FaLanguage` icon. Not yet verified in a running browser.
- [x] **`@tomic/cli` codegen:** `DatatypeToTSTypeMap` maps the datatype to
      the `LocalizedText` TS type (caught by the workspace build — the map
      is exhaustive over the Datatype enum).
- [x] **Docs:** `docs/src/schema/translations.md` rewritten (two-mechanism
      model, was orphaned → now in SUMMARY); `LocalizedText` section in
      `datatypes.md`; i18n section in `usecases/headless-cms.md`.
- [x] **Checks green (2026-07-20):** `atomic_lib` 185 + clippy clean;
      `atomic-server` 46 + 28; browser/lib vitest 185 + tsc; data-browser
      lint exit 0 + vitest 116 (typecheck has 5 pre-existing baseline
      errors, none introduced); full browser workspace build passes.

- [x] **E2e (table editor):** `browser/e2e/tests/localized-text.spec.ts` —
      (1) create a LocalizedText column, edit a cell, persist as a
      `{en: …}` map (store-level shape assert); (2) declare languages via
      the chip dialog, switch to `nl` (missing-fallback flagged), edit `nl`
      without touching `en`, split into per-language columns, **type-over
      regression** (editing `en` must not wipe `nl`), per-language clear,
      unsplit, reload persistence. Rows must be collection members before
      column toggles (reload + index rebuild), or split re-render drops
      virtual rows. 3/3 green against live dev servers.

- [x] **Phase 4 — website templates (SHIPPED 2026-07-21, template e2e 2/2
      green incl. `assertTwoLocaleSite` on both frameworks):** template
      ontology seeds `language`/`translationOf` on blogpost+page recommends,
      `defaultLanguage: en` + `languages: [en, nl]` on the Website, and a
      Dutch translation of the balloon post — every applied template is a
      two-locale site. Both site templates implement locale-prefixed
      routing, `translationOf` sibling swap, group-fallback listings,
      hreflang, a footer switcher, per-request `<html lang>` (Svelte; Next
      keeps site default). `template.spec.ts` gained `assertTwoLocaleSite`
      (the acceptance bar). A late `/nl` 404 in the e2e turned out to be
      stale scaffold state from pre-import-fix runs, not template code —
      manual production build verified correct before the clean green run.
      **Platform bug found & fixed on the way:** DID imports blindly
      rewrote every string value equal to a reserved localId — the website
      ontology's `shortname: 'website'` == its own localId, so template
      import silently aborted after DID reservation ("Not a valid slug:
      did:ad:…"), invisible because the apply-dialog heading assert matched
      the preview. Fix in `lib/src/parse.rs`: values resolve localIds only
      in reference positions (`try_to_subject` consults the reservation
      map; forward refs/cycles still work), keys still rewritten. Pinned by
      `import_keeps_scalar_values_that_equal_a_local_id` +
      `import_preserves_i18n_properties(_db)`.

Not in this round (tracked in phases above): Translate action /
TranslationsBar, `useTranslation` sibling resolution, `/query` `lang`
param, search `language` filter.
