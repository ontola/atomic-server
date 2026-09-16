> Follow-up: [Website publishing](./website-publishing.md) adds opt-in self-hosted publication. The prototype results below describe the earlier export-only slice. Managed SaaS activation remains pending.

# Assistant-authored websites: first implementation and abstraction review

Status: first local prototype validated on `codex/assistant-website-publication`, based
on `feat/plugin-model` at `d0e49b8b9`. The source worktree's staged and unstaged
changes were preserved. No production deployment or domain integration.

## Product decisions from the discussion

- A top-level Website resource represents the publication in Atomic.
- Atomic Assistant designs/edits the website beside a preview. Direct document
  editing and tables/grids remain equally valid ways to edit its content.
- Existing content is referenced, not moved or duplicated into an HTML blob.
- A document can become a web page while its rich text remains editable.
- Publication freezes a selected version. Later edits remain drafts.
- Subscription status, included allowances and remaining domain capacity should
  be visible in Atomic; actual checkout happens in SaaS and returns to the site.
- Hosting and an existing Cloud Server can be reused together. Domain registration
  through a registrar reseller API is a separate lifecycle and later scope.

## Is the plugin branch enough?

**It supplies an authoring and authority foundation, not yet a complete website
runtime.** Keep its shared release/installation/host boundaries. Do not invent a
second general-purpose extension system to implement websites.

| Inspected abstraction | What it provides | Website gap / recommendation |
| --- | --- | --- |
| `create_app`, `describe_app`, `update_app` | Source-as-data, edit existing identity, run/check/repair loop. | Current create tool provisions one owned table. Websites must reference multiple existing tables/documents without taking ownership. Add website tools, retaining normal document/table tools for content. |
| `AppFrame`, `FrameBridge`, shared view protocol | Isolated UI and mediated data operations; binding to an existing table is already possible at the frame layer. | A hosted page lacks the parent Atomic session. Reuse the protocol for interactive islands with explicit bindings; do not export a logged-in iframe or signing identity. |
| `view({root, store})` | Arbitrary DOM/CSS interactions without a build step. | It produces a browser view, not indexable HTML. No static render entrypoint, route manifest, asset graph or frozen content contract. |
| Plugin release / manifest | Versioned source and requested capabilities, separate installations and grants. | Website deployment adds static artifacts plus content snapshot; it is not another installation. Catalog publication is not website publication. Schema snapshots and portability are still incomplete upstream. |
| Tables, classes and properties | Native schema and content editing without a bespoke CMS data store. | Export needs explicit rows/fields and readable relationship policies. A live query for every child can publish new private drafts unintentionally. |
| TipTap/Loro document body | Structured rich text, an existing adapter to TipTap JSON, Assistant document editing. | Existing resource node HTML is an Atomic link, not an exported card/table/form. Add a pure public renderer; fail unsupported embedded resources until explicitly mapped. |
| CSS and template configuration | Can create attractive static layouts without runtime dependencies. | A fixed document/grid layout is a bootstrap renderer, not the final design ceiling. Free page composition, media and interactive islands remain necessary. |

The existing `create_app` preference for tables is correct for CRM/task workflows.
Website requests need different routing: their layout and presentation are the
product. Adding website tools must not turn ordinary data tools into custom apps.

### Target composition

One Website workspace references content bindings, routes and a design package.
Its design package should converge on the existing extension release envelope:
add static rendering as a capability alongside a browser view, not a competing
package registry. Public snapshots are read-only input. Interactive parts hydrate
only where needed and use the shared host protocol under current user rights and
installation grants. A backend operation or form submission is never rolled back
by replacing the website files.

**Recommendation:** static HTML for initial content and navigation, optional
interactive islands for behavior. Avoid shipping the entire data-browser or one
separate server process per website. Neither a CSS-only template nor running the
current AppFrame as a whole site covers the eventual product.

## Shared inline editor integration (13 September 2026)

`browser/edit-mode` provides `@tomic/edit-mode/react`. The website preview now
uses its `EditModeProvider` and `Editable` through React portals in a dedicated
preview iframe. **Edit on page** activates writable selected text fields;
**Done editing** returns to the refreshed preview. Saving writes to the existing
Atomic row with the current authenticated Store; no visitor clone is created.
The shared component adds an opt-in `allowEmpty` option so clearing a field
reaches normal source validation, while existing consumers keep their behavior.

The editable frame permits same-origin parent access, never iframe scripts.
Only locally rendered draft HTML enters that host; saved releases stay in the
opaque, non-editable sandbox. Navigation is intercepted in editing mode. Content
bindings are derived from this renderer's known table/grid structure and the
explicit selection, with no resource identifiers added to exported HTML.
This DOM mapping is deliberately specific to the static renderer, not the
future arbitrary-plugin annotation API.

Every write rechecks the current website selection, row membership, source write
rights, private ancestry, text datatype and expected previous value. A pending
save is not reported as durable. Conflict detection is an optimistic client
check, not a server compare-and-swap transaction. Unselected, public, read-only
and non-text fields are not activated. The export and prior release stay frozen.

`useCloneMode` / `createCloneStore` remain the independent visitor-owned clone
workflow. Rich-text documents still use the structured document editor;
flattening a CRDT document through the plain-text `Editable` would lose format.

## Multi-page composition and a snapshot plugin view

The Assistant can now order page sections, choose full/half/third widths, apply
section classes and CSS, and bind each document/table section by explicit index.
Repeated or out-of-range section references fail validation. The garden example
has a split homepage with searchable growing notes and an About page containing
an ordinary editable Atomic document. Both desktop and mobile were inspected.

`table.search` enables a concrete `view({ root, store })` search view. The host
reuses **the existing FrameBridge class and atomic.view v1 protocol**. It supplies
only the selected scalar snapshot through `data`; it denies live reads, queries,
subscriptions and mutations. There is no signing agent or Atomic Store in the
published runtime. The ordinary HTML cards remain until the view reports a
successful render, so search enhancement failure retains readable content.

The authoring preview's trusted, generated shell allows scripts and same-origin
parent access to host nested null-origin views. Only fresh validated draft output
enters that shell. Stored release/review HTML retains the opaque script-disabled
sandbox. Search is therefore interactive in draft preview and deployed/exported
sites; release review and inline-edit mode retain the static cards. This is not
a safe host for arbitrary imported HTML: that requires a separate content origin.

`runtime/searchView.ts`, `snapshotHost.ts` and `websiteRuntime.ts` are bundled by
`node scripts/build-website-runtime.mjs`. Build/dev/start run that generator; the
checked-in minified runtime and hash-authorized view HTML are the exported assets.
No dependency installation or JS compilation runs per content edit. The sample
uses a built-in bundled view, not dynamically loaded third-party plugin releases.
That next capability still needs a pinned release/static-render/asset contract.

Standalone acceptance serves the actual downloaded archive from a plain HTTP
server while Atomic and Vite are stopped. Navigation, filtering, no-results state
and responsive layout pass with all non-site requests blocked. The archive
contains only two pages, a small shared runtime, the view and a manifest; no
private source identifiers or unselected fields/rows. This supports the proposed
S3/CDN serving model, without proving a production deployment or traffic capacity.

## First implementation scope

- [x] Website resource/schema using the plugin branch's schema creation machinery.
- [x] New website from a document, retaining its source reference.
- [x] Assistant create/read/update tools with export validation before saving.
- [x] Multiple routes, theme typography/colors and additional CSS.
- [x] Ordered section composition and a searchable snapshot plugin view.
- [x] Rich-text HTML and explicit scalar table-field selection, grid/table output.
- [x] Private draft preview and reviewed frozen export resource.
- [x] Shared inline editing for existing selected private text fields.
- [x] ZIP with independent HTML pages and a small hosting artifact manifest.
- [x] Complete focused browser acceptance and capture the resulting UI.
- [x] Complete checks and record exact outcomes below.

The UI says **Prepare release / Create release / Download website**, not Publish:
there is no public serving API connected yet. An export is integrity-checked,
append-created through this UI, and stored under private authoring permissions.
It is not an immutable server-enforced deployment: authorized direct resource
editing or later sharing can change/expose it. Public publication requires the
SaaS authority boundary described below.

Current limitations: bounded section kinds (intro/document/table) with custom
composition, column spans and CSS;
no arbitrary generated JavaScript, only embedded raster images, no automatic
private media packaging, no Forms, no live app writes, no public URL, no
per-record incremental publication baseline, no shared permission review for
publishing, no account quota UI. Rich-text unsupported nodes fail explicitly.
Record selection is explicit, with no unbounded queries or graph traversal.

Snapshot capture reads selected resources then renders synchronously from the
loaded client state. This freezes that local projection; it does not establish
a cross-client/server transaction snapshot. SaaS activation needs authoritative
revision validation and a generation-based compare-and-swap.

## Efficient SaaS deployment

1. The authoring client prepares selected content and the pinned design release.
   No full-drive credential or secret enters the exported archive.
2. SaaS validates a versioned artifact manifest, file paths, sizes and hashes,
   ownership, current publishing rights and hosting allowance. Upload directly
   to a private S3-compatible hosting bucket with bounded signed upload grants.
3. Seal artifacts under a deployment identity; atomically activate a project
   generation. Keep code/content releases separate from live operational data.
4. Serve through Caddy and a small artifact router on a separate customer-content
   origin. HTML uses revalidation; hashed assets use long immutable caching.
   Resolve all page assets from one release. No database query per content block.
5. Private preview authorization covers every file and does not use public cache
   paths. Static public sites survive the authoring drive going offline.
6. Add a constrained build/export worker only for design packages requiring it.
   The bootstrap static renderer produces HTML directly in the client; do not
   require an npm installation or container build for every text edit.

Before treating the ZIP as a stable public API, finalize asset hashing, per-file
metadata and the mapping into the shared extension release envelope. The current
manifest is an internal prototype artifact contract, not a second plugin format.

## Validation

Eight focused Vitest tests pass. They cover inherited public permission rejection,
missing/cyclic ancestry, pending-save handling, escaping, rejected active URLs,
unsupported embedded resources, route traversal/collisions, CSS external-load
rejection, relative navigation, grid escaping and deterministic content hashes.
The browser regression covers document editing, source-to-preview rendering,
release review, actual ZIP download, later draft edits, frozen output and reload.


Chromium: 2 passed in 16.6 seconds with 1 worker against isolated backend 9896
and frontend 6759. The second case invokes the actual create/describe/update
Assistant tools with scripted model responses and real Atomic writes; it verifies
selected table content is visible and unselected rows/fields are absent. It does
not measure real-model design quality. Both cases save UI screenshots.

Data-browser TypeScript check passes. Targeted formatting passes; targeted lint
has zero errors, with one state-in-effect warning in the new async preview and
three pre-existing ResourcePage warnings. Full workspace tests, production build,
Rust checks, public hosting and live-model acceptance were not run.

The existing local backend on 9885 had a latched database write failure; it was
left untouched. Validation uses a separate fresh test data directory and the
existing plugin-branch server executable. Original worktrees were not switched.

The downloaded ZIP was extracted and opened in a separate browser on a plain
local HTTP server after stopping both the isolated Atomic backend and Vite.
The released document text remained visible. This verifies standalone static
output locally; it is not a SaaS deployment or a traffic/performance benchmark.
The initial catalog additions were minimal. The inline-editor pass retains
Wuchale's regenerated catalogs (including reference and wrapping normalization),
as required by the repo's instruction to preserve the dev extractor output.

Inline editing validation (13 September): four additional focused unit tests
cover source write authorization, selection removal, public/non-text refusal,
concurrent source edits and pending saves (12 website unit tests total). The
Assistant browser case additionally edits and clears a field through the shared
inline editor, checks the original row, verifies a frozen release and reloads.
Data-browser typecheck and the edit-mode TypeScript build are checked separately.

Final inline pass: both Chromium cases pass in 19.0 seconds with one worker,
including clearing and restoring a field. Data-browser typecheck, edit-mode
TypeScript build and targeted formatting pass. Targeted website lint has no
errors and retains the existing preview state-in-effect warning. Test servers
were stopped after verification. No public deployment or full-suite claim.

Final composition pass: 16 focused unit/bridge tests pass; 2 authoring browser
cases pass in 19.2 seconds and 1 standalone export browser case passes in 807ms
(all Chromium, one worker). Data-browser typecheck passes. Targeted lint has no
errors, with the existing async-preview state warning. The real Assistant tools
run against a scripted model; live-model design quality and arbitrary plugin
execution are not established by this example. No full production build/full
suite or SaaS publication was performed.
