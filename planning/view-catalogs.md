# Views, plugins and catalogs

Status: **notes, not decided** (2026-10-02). Background for the view registry
in [#1899](https://github.com/ontola/atomic-server/issues/1899): where
installable views come from today and one possible way the catalogs could feed
the registry. Michiel asked to hold this back from #1899 until it is better
understood, so nothing here is agreed. Builds on
[`plugin-runtime-convergence.md`](./plugin-runtime-convergence.md).

## Today: three ways a plugin offers a view

| | Listed by | Installing creates | Offered as |
|---|---|---|---|
| **Drive apps** | `catalog.json` on GitHub Pages (`app-module` entries; 6 of its 30 entries on 2026-10-02), plus apps made by hand (`routes/NewResource/createDriveResource.ts`), by the assistant (`chunks/AI/useAtomicTools.ts`) or from an app package (`lib/src/app-package.ts`) | An **app** resource in the drive (`createApp`, `lib/src/plugin-app.ts`) with an entrypoint script, its own ontology, a data table and `renders` (its row classes, `plugin-app.ts:201`) | A **table tab** (`useDriveApps` → `appsForClass`, `TableViewTabs.tsx:122`), and its own page (`AppPage`) |
| **WASM plugins with a UI** (Polle's model, from `0c0cac63` / `f5ffa58d`) | `/plugin-list?drive=…` (`components/CustomViewProvider.tsx:74`): zips installed per drive, each with `classes` and a `ui.js` | Files on the server plus a `Plugin` resource | A **page view** for those classes (`getPluginForClass`, `ResourcePage.tsx:244`, iframe `PluginView`) |
| **Published releases** | `/plugin-catalog` (`server/src/handlers/plugin_release.rs`): this server's public Listings | An **Installation** pinned to the release (`routes/IntegrationStore.tsx`) | Nothing yet: the Listing JSON exposes no view |

So there are three separate "which plugin view for this data" mappings: drive
apps for table tabs only, `/plugin-list` UIs for pages only, and releases with
no view at all.

## What `/plugin-catalog` actually lists

- It came with Joep's JS plugin model (`278aa499`, 2026-09-08). The
  convergence PR (#1571, `03c1a38f`, 2026-09-19, for #1546) gave both runtimes
  one manifest (v2) and one install path, so a Release is either JS
  (`atomic-js/1`) or a WASM zip (`wasip2/1`).
- It lists only **Listings**, and a Listing is created only on an explicit
  public publish: `POST /plugin-release` (JS) or
  `POST /plugin-release-package?public=true` (a zip, e.g. from the
  `atomic-plugin` CLI).
- **Uploaded zips get a private Release and no Listing.** The migration for
  legacy uploaded plugins calls `record_release(…, None, …)`
  (`server/src/plugins/plugin.rs:710`). Polle-style plugins therefore stay out
  of the catalog unless someone republishes them as public.
- A release **can** carry a view: the v2 manifest has `entrypoints.view`, a
  custom view module that needs the `custom-view` capability
  (`server/src/plugins/manifest.rs:148`), and WASM releases can have
  `entrypoints.classExtender`. The catalog entry just doesn't say so.

## A possible direction

Two layers, each answering one question:

- **The registry (#1899): "which views are available now?"** Built-in views
  register in code. Installed plugins register from what is installed: drive
  apps from their app resource (`renders`), `/plugin-list` UIs from their
  `classes`, later Installations whose release has a view. After install, a
  plugin view differs from a built-in one only in running in the iframe. The
  #1899 selection order (`?view=` → local override → stored value → class
  default) applies to all of them.
- **The catalogs: "what could I add?"** They never render anything and never
  load code before install.

Steps, none started:

1. **A catalog entry declares the views it offers:** classes and view types.
   `catalog.json` app entries hold only a module URL and an integrity hash; a
   `/plugin-catalog` Listing has no view fields even when its release has
   `entrypoints.view`.
2. **The view switcher shows installable views next to installed ones**, e.g.
   "Calendar (plugin), install" on a table whose rows have a published class
   (ontola/atomic-plugins#177). No code is loaded until the person installs.
3. **Installing makes it an ordinary view:** the declared classes become the
   app's `renders` (or the Installation's equivalent), and the registry picks
   it up from there.
4. **The catalogs converge.** With a Release as a resource
   ([`plugin-runtime-convergence.md`](./plugin-runtime-convergence.md),
   "One install path and a marketplace"), `catalog.json` and `/plugin-catalog`
   become one query, and step 1 is done once.

## Open questions

- **Noise:** suggestions in the switcher could clutter it. Matching only on an
  exact row class (the #177 rule) keeps them relevant.
- **Who may install from the switcher:** probably anyone with write access to
  the drive, since installing creates resources in it.
- **Trust:** the `catalog.json` URL is configurable (Settings > Integration),
  so a suggestion should show which catalog it came from.
- **Built-in views in a catalog:** if the built-in views ever move to
  atomic-plugins, a catalog entry (module + integrity) is how they would ship.
  Running them in the page rather than the sandboxed iframe, with shared
  React and store, is a separate trust decision.
- **`/plugin-list` and Installations:** whether Polle-style UI plugins should
  move onto Installations (so the page-view mapping comes from one place) is
  part of the convergence plan, not of #1899.
