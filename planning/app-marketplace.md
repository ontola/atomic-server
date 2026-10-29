# Apps: discovery, sharing, installation and selling

**Status:** Accepted direction (Joep, 2026-10-28: "follow your recommendations
for now"). Nothing built yet. The full design, in Dutch, with the reasoning and
the inventory of what exists, is kept in the project's shared files as
`plugin-marketplace/proposal.md`. This file is the plan.

Leading example: the Leerboom (learning tree, atomic-plugins `integrations/learning`)
as a separately sold app for schools, with no Leerboom code in this repo and
still good integration.

## Decisions

1. **One catalog.** Today there are two catalogs and two install paths: drive
   apps come from `catalog.json` on GitHub Pages and are copied into the drive
   as an App with its source (`chunks/PluginRuns/CatalogApps.tsx`); server
   plugins install as an `Installation` pinned to a `Release`, listed by
   `Listing` resources (`plugin-runtime-convergence.md`). They merge: a
   marketplace is a drive of Listings, any number of marketplaces can be
   configured (like F-Droid repositories), and `catalog.json` becomes a static
   JSON-AD export of a marketplace drive. A drive app becomes a Release; its
   package blob is copied into the installing drive, so it syncs, works offline
   and runs on a phone without a server.
2. **Activation per signer, not per device.** Sync still never activates an app
   by itself (`plugins.md`, "drive-shaped worm"). An Installation signed by your
   own agent is active on all your devices; one committed by another drive
   member asks each member once, with the same review screen. Updates within
   the same grants apply automatically; wider grants wait for review.
3. **Selling is access, not bits.** A Listing may carry an `offer` (price,
   checkout URL). Payment happens at the seller, outside the open core. The
   seller then signs an `Entitlement` (listing, holder agent/drive/group, seats,
   validUntil) and grants the holder read rights on a content drive. App code
   may stay open source. When an entitlement lapses, what the holder made stays
   theirs.
4. **"Add to home screen" for any resource**, not only apps: one item in the
   existing resource menu. Android (Flutter) pins a shortcut with a deep link
   that opens the resource full screen; web gets a per-app PWA manifest; iOS
   web uses Safari's own "Add to Home Screen"; an iOS widget comes later.
5. **"Apps" is the user-facing word** for everything installable. Integrations
   are a category of apps. The Integrations Store route becomes Apps.

## Principles

- Discovery happens mostly in context: "Open with" for a resource's class,
  suggestions on empty tables and new drives, an Apps group in Cmd+K, and an
  assistant tool `search_apps` that is consulted before building something new.
  The Apps page is the secondary route.
- Few UI components (Joep, 15 Oct): card view for grids, `ResourceRow` for
  lists, the existing install review dialog, resource menu and share dialog.
  The only new view is the one for the `Listing` class.
- Integration through the manifest, not core code: an app contributes schemas,
  views per class, an entry, templates (starter data), `creates` (New menu
  entries), settings, link patterns and later exports (Host ABI). The host has
  generic places where these appear.
- App mode: open one app alone (its name and icon, the rest of Atomic one tap
  away, same store and identity). A home screen icon opens it; a domain can be
  configured to open the web app in app mode for one Listing.
- FOSS never depends on saas: the open core knows only the Listing, Entitlement
  and marketplace formats. The default marketplace list in the FOSS build is the
  community catalog; no unsolicited atomic.place promotion.

## Phases

- [ ] **1. One catalog and one install path.** Drive apps as Releases with the
  blob in the drive; marketplaces as a configurable list (today a single
  `plugin-catalog-url`); `catalog.json` as an export; Store renamed Apps;
  Listing page with a public URL, share and QR. Check with Michiel first that
  `catalog.json` may become an export of Listing resources with the same
  fields; the catalog tooling is his.
- [ ] **2. Discovery in context.** "Open with", empty-state suggestions, Cmd+K
  group, `search_apps` assistant tool, "Try" in a temporary local drive.
- [ ] **3. Activation per signer.**
- [ ] **4. Mobile and home screen.** The Flutter embed host
  (`flutter-resource-webview.md`) also answers app frames and loads apps from
  the local blob; "Add to home screen"; app mode.
- [ ] **5. Selling.** `offer` on Listing, `Entitlement` class, content drive
  rights. Pilot with Leerboom at one school.
- [ ] **6. Remaining manifest contributions:** `templates`, `creates`, `opens`,
  and `exports` once the Host ABI moves.

## To verify before building

- How many installable PWAs Chrome and Safari allow per origin with distinct
  manifest `id`s, and whether a manifest served by the service worker is
  accepted (needed for serverless per-app manifests).
- Publisher verification format (agent named in `/.well-known/` on the
  publisher's domain).
- What Dutch schools require around privacy agreements and single sign-on.

## Related

- `host-abi.md`: independent of this plan. Later adds precise grants to the
  review screen and exports for assistant tools.
- `plugin-runtime-convergence.md`: Release, Installation and Listing classes.
- `plugins.md`, `extension-architecture.md`: app model and activation rule.
- atomic-plugins `docs/design/pieces.md`, `bundles.md`: manifest matching and
  bundles for discovery.
