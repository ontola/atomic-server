# Headless CMS, drafts, and forks

AtomicServer is a local-first headless CMS: model content with ontologies, edit
it in the GUI, and render it from any front-end that can read Atomic Data
([Astro guide](../astro-guide/1-index.md), Next.js / SvelteKit website templates,
or your own `@tomic/react` / `@tomic/svelte` app).

Two generic capabilities make publishing work. Neither is Website-specific.

## Visibility is location

A resource is public because it lives somewhere public — not because of a
`status` field that can drift from reality.

On a drive that is not blanket-public you typically have:

- a **public folder** with `read` granted to the public agent; children inherit
  public read through the [hierarchy](../hierarchy.md);
- a private **Drafts** folder (no public grant) for unpublished new content.

**Publishing** a draft is moving it to a public parent. **Archiving** is moving
it somewhere non-public. No extra class or workflow engine required.

The drive keeps a well-known Drafts folder (created on first use). New content
you are not ready to show the world goes there.

## Forks: propose a change

A **Fork** is a proposed edit to an *existing* resource.

| Property | Meaning |
| --- | --- |
| `Fork` (class) | Marker: this resource proposes a change to another |
| `originalSubject` | The resource being changed |
| `forkBase` / `forkVersion` | Snapshot of the original at fork time (for merge) |

Creating a fork copies the resource into a private Forks folder, sets
`originalSubject`, and lets you edit freely. The original is untouched until you
**merge**. Merge squashes the fork onto the original (properties + Loro body
where applicable). While a fork is open, the original can show that pending
forks exist.

Forks are ordinary resources: they have their own subject, history, and rights.
They carry the content class alongside `Fork` (`isA: [BlogPost, Fork]`), so the
normal editors and site previews render them.

This replaces the older "Suggestions / Inbox HTTP POST" idea. Cross-agent
"suggest an edit to someone else's drive" can reuse the same Fork mechanism once
authorization for that path is fully productized; today the GUI flow is
optimized for staging your own edits and merging them.

## Websites and front-ends

- **Website templates** in the app scaffold a site (pages, nav, locales) as
  Atomic resources you can edit in the GUI.
- **Headless front-ends** fetch JSON-AD over HTTP or sync a drive locally, then
  render with your stack. See [Build a portfolio with Astro](../astro-guide/1-index.md)
  and [`@tomic/template`](../create-template/atomic-template.md).
- **Edit from the webpage** — guest edit / local clone flows let a visitor
  propose changes without write access to the live drive (forks / local-only
  drives); merge happens when an editor accepts them.

## Internationalization

Multilingual sites use the two mechanisms in
[Translations & Localization](../schema/translations.md):

- **Document-level** — one resource per language (`language` + `translationOf`),
  so each locale has its own path, history, and publish state (a translation in
  Drafts is simply unpublished).
- **Field-level** — [`LocalizedText`](../schema/datatypes.md#localizedtext) for
  short strings inside shared structure (nav labels, feature cards).

Declare `defaultLanguage` (and optionally `languages`) on the website or drive.

## Local-first CMS

Editors can work offline: drafts and forks live in the local database until
sync. See [Local-first](local-first.md) and [Sync & pairing](gui/sync-and-pairing.md).

## Related

- [Use case: Headless CMS](../usecases/headless-cms.md) (why / comparison)
- [Tables](gui/tables.md) for structured content collections
- [Hierarchy and authorization](../hierarchy.md)
- [Commits](../commits/intro.md)
