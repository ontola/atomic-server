# sveltekit-site

A website built with [SvelteKit](https://kit.svelte.dev/) powered by [AtomicServer](https://github.com/atomicdata-dev/atomic-server).
Pages are server-rendered with `Cache-Control: public, s-maxage=60, stale-while-revalidate=86400` so a CDN can serve the correct language and content on the first byte.

Apply the **Website** template in the Data Browser first, then generate this project with `--server-url` (HTTP origin) and `--drive` (the Drive's `did:ad:` subject). Full walkthrough: [Using Atomic as a headless CMS](https://docs.atomicdata.dev/headless-cms.html).

From the running site, press Cmd/Ctrl+E or use **Edit this page** in the footer to open the current resource in the Data Browser. `PUBLIC_ATOMIC_CMS_URL` in `.env` is that editor origin (defaults to the server URL).

A blog post with `published-at` in the future (or missing) is not listed, searchable, or routable. Forks are excluded from public queries.

`/sitemap.xml`, `/robots.txt`, and `/rss.xml` are generated from that same filter. Blog cards on `/nl/blog` keep the `/nl` prefix. `<html lang>` comes from the URL on the first byte. Blog search filters the rendered list in the browser.

## Architecture

Atomic Data resources are rendered by views.
These views are components that accept a resource as prop and render the data in a certain way.
For example the `BlogPostFullPage` view renders a `blog-post` resource as a full page.

Oftentimes these views also come with a kind of view selector component that determines what component to render based on the resources class.
An example of this would be `FullPageView`.

These selector components are great for when a resource can reference another resource without a classtype, meaning it can be any kind of resource.
For example, the `page` class has a `blocks` property that can reference any type of resource.
The FullPage view for the `page` class (`PageFullPage`) therefore renders a `BlockView` component that selects the appropriate component to render, i.e. a `TextBlock` or an `ImageGalleryBlock`.

## Updating the generated ontology.

After making changes to an ontology you need to re-generate them in your code. This can be done by running:

```bash
<PACKAGE_MANAGER_RUN> update-ontologies
```

## Developing

Once you've installed the dependencies and generated the ontologies with `<PACKAGE_MANAGER> install` and `<PACKAGE_MANAGER_RUN> update-ontologies`, start a development server:

```bash
<PACKAGE_MANAGER_RUN> dev

# or start the server and open the app in a new browser tab
<PACKAGE_MANAGER_RUN> dev -- --open
```

## Building

To create a production version of your app:

```bash
<PACKAGE_MANAGER_RUN> build
```

You can preview the production build with `<PACKAGE_MANAGER_RUN> preview`.

> To deploy your app, you may need to install an [adapter](https://kit.svelte.dev/docs/adapters) for your target environment.

## Why `@swc/core` is pinned

`package.json` pins `@swc/core` and `@swc/wasm` to an exact version through
`pnpm.overrides`. Neither is a direct dependency: both arrive under
`vite-plugin-top-level-await`, which needs them to rewrite top-level `await`
(this project has some, via the `loro-crdt` wasm bundle).

That plugin floats them on a caret range, and it parses with one and
manipulates the AST the other produced. When SWC ships a release that changes
the AST schema, the two disagree and every build fails with:

```
error during build:
[vite-plugin-top-level-await] missing field `type`
```

which names neither SWC nor the plugin, and appears without you having changed
anything — a fresh install is all it takes. Pinning is the only lever here,
since the range belongs to a transitive dependency.

Safe to raise once `vite-plugin-top-level-await` ships a release that agrees
with a newer SWC. Verify by building this template, not by reading versions.
