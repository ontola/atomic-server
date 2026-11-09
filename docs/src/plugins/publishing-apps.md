# Publishing an app

You built an app in your drive, with AI or by hand. This page explains how to
get it in front of other people. Pick the route that matches who should have it.

## 1. Share it with one drive or one person

Open the app and use **Share**. Members of the drive see it in their sidebar.
For someone outside the drive, share the app's link or QR code; they review what
it asks for and install it themselves. Nothing is published anywhere.

## 2. Run your own marketplace

A marketplace is a `catalog.json` on an HTTPS URL. Anyone can host one, for a
school, a company or a community.

1. Build the app and package it as a drive app: one ES module that exports
   `view({ root, store })`.
2. Host the built module at a stable URL per version, and add a catalog entry
   with `shortname`, `name`, `description`, `version`, `app-module` (the module
   URL) and `app-module-integrity` (its `sha384-` hash). A version that is
   published is never changed afterwards, a new version gets a new URL.
3. Publish `catalog.json` on an HTTPS URL.
4. Tell people to add it under **Settings > Integration > Marketplaces**, or
   give them the link `https://<your-atomic>/app/apps?marketplace=<catalog url>`.
   Atomic asks before it adds the marketplace, because apps from it can be
   installed into their drives.

When two marketplaces offer an app with the same name, the one listed first
wins.

## 3. The community marketplace

The default marketplace is built from the
[atomic-plugins](https://github.com/ontola/atomic-plugins) repository. To get an
app in, open a pull request that adds the app under `integrations/<id>/app/`
and its entry in `integrations/catalog.json`. Follow "Publishing a drive app" in
`integrations/README.md` there: bump the version, run
`node integrations/tooling/apps.mjs write <id>`, and commit the built
`apps/<id>/<version>/ui.js` with the catalog change. New apps start as
experimental and only show up for people who turned on **Show experimental
apps**, until they are certified.

## Selling an app

Not available yet. The plan is that a marketplace entry can carry an offer and
that you grant buyers access with a signed entitlement. See
`planning/app-marketplace.md`.
