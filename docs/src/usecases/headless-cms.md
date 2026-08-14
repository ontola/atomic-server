# Using Atomic-Server as an open source headless CMS

AtomicServer stores typed, live-updating content. You edit it in the Data Browser and render it with any front-end. The supported path is the **Website** template plus `@tomic/template` (Next.js or SvelteKit).

**Walkthrough:** [Using Atomic as a headless CMS](../headless-cms.md).

## Why people are switching to Headless CMS

Traditionally, content management systems were responsible for both managing the content as well as producing the actual HTML views that the user saw.
This approach has some issues regarding performance and flexibility that headless CMS tools solve.

- **Great performance**. We want pages to load in milliseconds, not seconds. Headless CMS tools + JAMSTACK style architectures are designed to give both performant initial page loads, as well as consecutive / dynamic loads.
- **High flexibility**. Designs change, and front-end developers want to use the tools that they know and love to create these designs effectively. With a headless CMS, you can build the front-end with the tools that you want, and make it look exactly like you want.
- **Easier content management**. Not every CMS is as fun and easy to use, as an admin, as others. Headless CMS tools focus on the admin side of things, so the front-end devs don't have to work on the back-end as well.

## Atomic Server

The [Atomic-Server](https://github.com/atomicdata-dev/atomic-server/blob/master/server/README.md) project may be the right choice for you if you're looking for a Headless CMS:

- **Free and open source**. MIT licensed, no strings attached.
- **Easy to use API**. Atomic-Server is built using the [Atomic Data specification](../atomic-data-overview.md). It is well-documented, and uses conventions that most web developers are already familiar with.
- **Typescript, React, and Svelte libraries**. Use `@tomic/lib` with `@tomic/react` or `@tomic/svelte` for live-reloaded, typed resources.
- **Fast**. Written in Rust; millisecond-range responses on a laptop.
- **Lightweight**. A single binary, no external database required.
- **Easy to setup**. Run the binary and open the address. HTTPS support is built-in.
- **Clean admin GUI**. The Data Browser is the editor: pages, tables, ontologies, history, forks.
- **Share your data models**. Re-use existing ontologies, or share the ones you built.
- **Files / Attachments**. Upload and preview files.
- **Pagination / sorting / filtering**. Query your data.
- **Versioning**. Built-in history, where each transaction is saved.
- **Websockets**. Live updates for collaborative documents and other interactive apps.
- **Full-text search**. Built-in; no separate search cluster.
- **Translations / i18n**. Localize content per language — see below.

## Internationalization (i18n)

AtomicServer supports multilingual content with two mechanisms, matching how the mature CMSes model it (see [Translations & Localization](../schema/translations.md) for the full model):

- **One resource per language** for content that diverges per language (blog posts, pages, documents). Each translation carries a `language` (BCP 47 tag, e.g. `nl`) and points at its canonical resource via `translationOf`. Because a translation is an ordinary resource, per-language paths (`/en/about` vs `/nl/over`), per-language publishing (an unpublished translation is just a resource in a private folder), and per-language edit rights all come for free.
- **The [`LocalizedText` datatype](../schema/datatypes.md#localizedtext)** for short strings inside shared structure (labels, feature cards, product names): a single value holding all its translations as a `{ "en": "...", "nl": "..." }` map. The structure exists once; only the strings vary. Concurrent edits to different languages merge conflict-free.

Declare `defaultLanguage` (and optionally `languages`) on your website or drive, and resolve a language in the client with the `localizeText` helper from `@tomic/lib` — the fallback chain is exact tag → primary subtag → default language.

## Limitations

- No support for image resizing, [as of now](https://github.com/atomicdata-dev/atomic-server/issues/257)
- No GraphQL support [(see issue)](https://github.com/atomicdata-dev/atomic-server/issues/251)
- Scheduled `published-at` dates hide posts on generated sites, but they are not an authorization boundary. A Drive with public read still serves the resource over HTTP.
- Confidential drafts require a private folder (the Drive itself must not be blanket-public). The Website template does not yet ship that layout.

## Setting up the server

- One-liners: `cargo install atomic-server` or `docker run -p 80:80 -v atomic-storage:/atomic-storage ghcr.io/ontola/atomic-server`
- Check out the [readme!](https://github.com/atomicdata-dev/atomic-server)
- Then follow [Using Atomic as a headless CMS](../headless-cms.md) to apply the Website template and generate a site.

## Using the data in your (React / NextJS / Svelte) app

The `@tomic/lib`, `@tomic/react`, and `@tomic/svelte` typescript NPM libraries can be used in any JS project. Generated sites already wire them up.

## Compared to alternative open source headless CMS software

- **Strapi**: Atomic-Server doesn't need an external database, is easier to setup, has live synchronization support and is way faster. However, Strapi has a plugin system, is more polished, and has GraphQL support.
