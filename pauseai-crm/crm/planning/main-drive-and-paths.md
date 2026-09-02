# Main drive, legacy URLs, and human-readable paths (DID-branch deployment)

> **Status:** strategy, July 2026. Written for the planned deployment of
> the `did` branch to atomicdata.dev. Three goals, in order of
> hardness: (1) the main drive stays visible at the root, (2) every
> pre-DID URL keeps resolving, (3) later, users can share their `did:`
> resources on human-readable paths (their own subdomain/domain).
> Grew out of the drive-UX redesign: the New Drive "Subdomain" field
> turned out to be a dead propval, which prompted auditing what the
> host/path routing layer actually does.

## What exists today (verified in code, July 2026)

- **Host → drive binding**: `Tree::DriveMapping` maps a hostname to a
  drive DID; `get_drive_did(host)` reads it;
  `map_request_subject` (`lib/src/db.rs:1031`) routes `/` on a bound
  host to the drive and resolves sub-paths *within* that drive.
  Endpoint-style prefixes (`/did`, `/setup`, `/search`, `/upload`,
  `/commit`, …) bypass drive routing (`should_bypass_drive_routing`).
- **Legacy fallback**: when drive routing misses,
  `resolve_request_target` falls back to a **direct DB lookup of the
  full HTTP URL** — this is what keeps pre-DID URL-subject resources
  resolving. DID responses carry `Link: <did:…>; rel="canonical"`.
- **`/bind-drive` endpoint** (`server/src/plugins/bind_drive.rs`,
  formerly `/setup`): POST binds the current host to a drive. Authz is
  right (write on the target drive; rebinding additionally requires
  write on the currently bound drive; `?reset` unbinds, dev-only). It
  was a routing no-op until July 2026 — it relied on a "db layer picks
  this up" hook that never existed, and **nothing in production ever
  wrote the mapping**. Fixed + renamed in `b783b9a6`: the endpoint
  writes the mapping directly; tests cover deny-anonymous / bind /
  root-resolution / reset.
- **Path resolution inside a bound drive** (`get_resource_at_path`):
  - Strategy 1: exact match on the canonical
    `https://atomicdata.dev/properties/path` propval. **Zero
    producers**: nothing in the app writes that property — the website
    template mints its own template-local `path` property the server
    router can't see — and the drive-membership check only accepts
    resources whose *direct* parent is the drive.
  - Strategy 2: per-segment `shortname` traversal (tested). Real, but
    ordinary content (folders/docs/tables) carries `name`, not
    `shortname`, so typical drives aren't deep-path-addressable yet.
- **Subdomain remnants**: `Subject::Internal` has a subdomain slot,
  config has a wildcard-domain option and DNS-01 LetsEncrypt support.
  The per-drive `subdomain` propval is dead (field removed from the
  New Drive dialog); the *host-binding* model replaces it: a subdomain
  is just another `DriveMapping` row.

## Invariants for the atomicdata.dev deployment

1. **Root serves the public main drive** — the pre-DID behavior:
   `GET /` renders the drive, like today's atomicdata.dev.
2. **Ecosystem constants resolve forever.** Every client, library, and
   stored resource hardcodes `https://atomicdata.dev/properties/*`,
   `/classes/*`, `/ontology/*`. These must return 200 with the same
   semantics on the DID server, indefinitely. Non-negotiable.
3. **Old content URLs resolve** (drives, invites, docs) — directly or
   via redirect to a canonical form.
4. **New resources are `did:ad:`**; URLs are presentation aliases
   (canonical Link header), never identity.

## Strategy, phased

### Phase 0 — mechanism

- ✅ Endpoint fixed and renamed to `/bind-drive` (`b783b9a6`).
- Optional env/boot seed (`ATOMICSERVER_MAIN_DRIVE=<did>` or config)
  writing the same mapping at startup — infra-as-code and headless
  deploys; the endpoint remains the runtime/UI path.
- UI action on the drive ("Serve as this server's main drive…", shown
  with write access), ideally next to the make-public toggle since a
  main drive almost always wants `publicAgent` read. Binding is
  routing; visibility stays a rights question.

### Phase 1 — staging rehearsal (the real risk lives here)

- **Data migration is the biggest unknown**: production atomicdata.dev
  runs a pre-DID store; this branch changed subject types, trees
  (redb/sled layout, Loro snapshots), and indexing. Investigate:
  export/import path? in-place migration? repopulate + re-import?
  (Related: `planning/drive-reconciliation.md`,
  `planning/subject-types-end-to-end.md`.) Nothing below matters until
  a copy of production data boots on the branch.
- **URL-corpus crawl**: harvest a corpus of real URLs (ontology
  constants, sitemap, server logs, invite links) and assert
  200/3xx+canonical against staging. This is the regression gate for
  invariant 2/3 — automate it, keep it as a deploy check.
- **Shadowing audit**: drive-path resolution runs *before* the legacy
  direct-URL fallback. If the bound main drive contains a child whose
  shortname is e.g. `classes`, it shadows
  `https://atomicdata.dev/classes/*`. Options: extend the bypass list
  with reserved legacy prefixes on this host; or flip precedence to
  legacy-exact-match-first; or simply audit the main drive's top-level
  shortnames. Decide with the crawl results in hand.

### Phase 2 — bind atomicdata.dev

- Bind the host to the main drive via `/bind-drive` (or env seed).
- Decide the main drive's subject form: keep the existing URL-subject
  drive (the mapping value is a string; URL subjects resolve), or mint
  a `did:ad:` drive and treat the old URL as alias. Leaning: migrate
  to `did:ad:` so the flagship deployment eats the branch's own dog
  food, with the old drive URL 3xx-ing to `/`.

### Phase 3 — human-readable paths for everyone (later)

- **Users' drives on subdomains**: `joep.atomicdata.dev → drive DID`
  is one more mapping row + the existing wildcard DNS-01 TLS. Needs:
  a claim flow (authz = write on the target drive, name-squatting
  policy TBD), and the drive-UX surface ("Publish at…" on the drive —
  GitHub-Pages-style custom domain later, same mechanism).
- **Deep-path polish bundle** (what makes a bound website template
  actually crawlable/shareable):
  - slugified-`name` fallback in the shortname traversal, so ordinary
    folders/docs are path-addressable;
  - ancestry-walk membership check for the `path`-propval strategy
    (today: direct children of the drive only);
  - align the website template with the canonical `path` property;
  - a UI affordance to set `path` on a resource.
- **Precedence policy, documented + tested**: reserved endpoint
  prefixes > (host-reserved legacy prefixes, if chosen in Phase 1) >
  drive paths > legacy full-URL fallback.

## Out of scope / notes

- CDN/cache strategy, sitemaps, SEO.
- The per-drive `subdomain` propval stays dead; do not resurrect it —
  host bindings subsume it. `@tomic/lib` still accepts
  `createDrive({subdomain})`; delete in a lib cleanup pass.
- Legacy `/setup` *invite* docs (`docs/src/atomicserver/faq.md`,
  `gui.md`) are stale on this branch independent of this plan; update
  when renaming the endpoint.

## Open questions

- Migration tooling for the production store (Phase 1) — the gating
  unknown for the whole deployment.
- Shadowing policy (bypass list vs precedence flip vs audit-only).
- Main drive subject: keep URL-subject vs re-mint as `did:ad:`.
- Subdomain claim policy (reserved names, squatting, one per agent?).
- Should an unbound host's `/` serve a landing/welcome instead of 404?
  (Today the app loads but the root resource 404s — fine for the app,
  ugly for curl/crawlers.)
