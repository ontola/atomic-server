# Atomic websites: implementation handoff

Updated 15 September 2026. Read this before continuing work. This is a working
prototype with focused tests, not a production-ready hosting product.

## Start here

- Repository: `ontola/atomic-server`, checkout `/private/tmp/atomic-pr-website`
  (`/tmp/atomic-pr-website` is the same location).
- Branch: `codex/website-self-hosted-publishing`.
- Draft PR: https://github.com/ontola/atomic-server/pull/1500
- PR base: `codex/assistant-website-publication`, **not develop**. This is stacked
  on the Assistant website work originating from the plugin work. Inspect the
  current dependency/merge state before changing its base.
- Last implementation commit: `cb3e6ae00` (pushed). The handoff itself follows it.
- SaaS checkout: `/Users/joep/dev/atomic-saas`. The implemented hosting backend in
  this PR is in atomic-server; a managed SaaS publishing adapter is still needed.
- Read repository AGENTS.md files and `browser/data-browser/UI_COMPONENTS.md`
  before editing. Check git status and preserve existing work.
- Companion architecture document: [website-publishing.md](website-publishing.md).
  This handoff supersedes its stale references to a custom “Publishing options”
  menu: website actions now use the standard resource More menu.

Do not reset the user's database or identity, overwrite another checkout, or
restart unrelated servers. Create fresh test resources for reproduction. Never
copy invitation tokens, signing secrets or credentials into docs/logs.

## Product intent and decisions

The user opens Atomic and asks, “I want a website for my bakery.” The Assistant
finds existing Products, prices, documents and photos, then creates/designs the
website using those resources. Atomic remains the source of truth; the website
must not become a disconnected copy of editable content.

The user edits through normal tables/documents or inline in the preview. Those
edits save to the original Atomic resources. **Production changes only after
Publish site / Update site.** This explicit publication boundary is intentional,
including after inline editing. Rollback changes delivered website content, not
source records, operational app data or form responses.

UX requirements from repeated user feedback:

- One blue primary button at a time: Publish site or Update site. One action
  performs snapshot preparation, upload and activation; no mandatory manual
  release/upload/review sequence.
- Hosting status refreshes automatically. No “Refresh hosting status” button.
- “Edit with AI” is now back next to “Edit on page” in the preview toolbar as a
  subtle button. Both that shortcut and the More action share the same callback.
  The More action currently retains the label “Design with AI”.
- View site, versions, unpublish and export operations use standard context
  actions. Page-specific actions precede generic actions with one divider.
- Normal View/Data View are ordinary icon actions; hide the active view action.
- Use existing ResourceRow/components for content, meaningful labels and types.
  Add content is a button. Avoid a custom CMS UI full of technical export terms.
- Do not reload the preview merely because AI/sidebar state changes.
- Do not add version resources to the sidebar or version-specific show-more UI.
- Show failures through `store.notifyError`, with a useful visible failure state;
  don't leave a spinner forever or silently disable the only useful action.

Longer-term intent: strong interactive apps as well as beautiful websites, reuse
the plugin abstractions and CMS editing controls, FOSS hosting plus managed SaaS.
**The current implementation is static-v1; that wider ambition is not delivered.**
CLI uploads are not the main authoring flow. Registrar/DNS purchasing is deferred.
Account entitlements should eventually be visible in Atomic, with actual payment
in the trusted SaaS account flow. No approved public pricing or automatic overages.

## What is implemented

### Authoring and preview

`browser/data-browser/src/chunks/Website/` contains the implementation:

| File | Responsibility |
| --- | --- |
| `websiteModel.ts`, `websiteTools.ts` | Website resource/config and Assistant authoring tools |
| `websiteExport.ts`, `renderWebsite.ts` | Selected source snapshot and static rendering |
| `WebsitePage.tsx` | Content sidebar, draft preview, AI shortcut, export context actions |
| `WebsitePreview.tsx`, `useWebsitePreviewHtml.ts` | Preview rendering and media URLs |
| `WebsiteInlinePreview.tsx`, `websiteInlineEditing.ts` | Authorized inline source editing |
| `WebsiteHosting.tsx`, `hostingClient.ts` | Status, publish/update, versions, rollback and HTTP client |
| `WebsiteExportPage.tsx` | Frozen version preview, including legacy exports |
| `websiteMedia.ts`, `websiteAssets.ts`, `optimizeWebsiteImage.ts` | Media selection, blobs and optimization |

Preview subscriptions filter changes to website design rather than rebuilding on
any resource notification. Source changes still trigger debounced rebuilds. The
previous preview remains visible while refreshing. Unchanged output preserves
iframe identity. This is a correctness improvement, not a measured performance SLA.

Inline editing supports selected string, integer and float table fields. Numbers
are parsed as numbers, reject invalid/nonfinite values, and integers require safe
whole values. Commits check current permissions, binding membership and conflicts.
Document sections mount the existing `CollaborativeEditor` in a React portal in
the preview iframe, reusing structured rich text and normal autosave.

The latest fix passes the iframe body as `menuContainer` to the editor. Resource
and slash suggestion menus are adopted into that document before positioning;
keyboard scrolling uses its ownerDocument. Embedded editor backgrounds are
transparent. Styled-components styles target the iframe head. The preview remains
sandboxed without script permission; trusted Atomic code owns the editor/writes.

### Versions and delivery

- Browser uploads a version-1 WebsitePackage: code files, asset references and
  optional **private** metadata for reconstructing previews.
- Server stores code and a version-2 manifest as immutable BLAKE3 blobs through
  BlobBackend (local or configured internal S3). Images are separate HTTP blobs,
  never base64/bytes embedded in HTML. S3 stays private behind serving endpoints.
- KV/redb stores membership, deployment IDs/timestamps, active pointer and history.
  New exports create no Atomic child resources and no website-release pointer.
  Legacy resource/KV exports remain readable; they are not deleted.
- Identical exports deduplicate. The current pilot caps distinct deployments at
  20 and activation history at 100. There is no blob garbage collector.
- Publish uses expectedRevision; stale activation gets HTTP 409. Failed upload or
  build preserves the existing public site. Upload alone does not publish.
- Public files are served on a separate customer origin. Delivery does not read
  the authoring drive. HTML pins runtime/assets to its version.
- Previously activated versions remain accessible while the site is published;
  unpublishing hides them all. Downloaded copies cannot be recalled.
- Source edit authority is narrower than publication: current publishing requires
  write access to the website and containing drive root.

Server entry points: `lib/src/website.rs`, `lib/src/db/website.rs`,
`server/src/handlers/website.rs`, `server/src/blob_storage.rs`.

Control API (signed requests):

- GET `/website-hosting?project=...&drive=...`: status/history/URL.
- POST `/website-hosting/deployments?project=...&drive=...`: private package upload.
- GET `/website-hosting/preview/{deployment}?project=...&drive=...`: private JSON
  package, no-store; never serve customer HTML on the editor origin.
- POST `/website-hosting/activate?project=...&drive=...`:
  `{ expectedRevision, deployment }`; null unpublishes; an old ID rolls back.

### Media

Browser optimization preserves originals and generates derivatives with longest
edge at most 1920px, targeting 600 KB WebP. Small images and GIF animation are
preserved; large GIFs have an explicit rejection. Input caps are 50 MB/80MP.
Errors identify the source/field/page. Private unpublished asset availability is
currently tied to local cached blobs; see improvements below.

## Improvements needed, in suggested order

### 1. Finish validating inline RTE behavior (immediate)

The user reported @/# appearing frozen and a white editor background. The last
commit fixes the known menu-document mismatch and background, and focused tests
pass. **Do not interpret this as all rich-text features verified.**

Next reproduce in Firefox (the user's reported browser) and a real bakery page.
Test selecting a mention, arrow navigation, escaping then reopening, formatting
bubble menus, link/color popovers, image insertion/upload, tables, drag handles,
undo/redo, selection across blocks, and long/scrolled documents. Some shared RTE
components still refer to global document/window or use portal defaults. Audit
these against iframe ownership rather than loosening iframe sandbox permissions.
Check CSS/font inheritance, dark backgrounds and popup readability. `# ` with a
space is the heading input rule; a bare # is not established as a suggestion menu.

Acceptance: each supported control works visibly in the iframe, saves to the
original resource, survives reload and does not leak keys/credentials to site code.
Add focused regressions for actual failures; don't build a separate rich-text editor.

### 2. Preview speed, invalidation and actionable failures

The user repeatedly reported slow “Preparing preview”, unnecessary reloads and
missing content errors. Some fixes exist; investigate remaining bottlenecks with
measurements (resource fetching, image decode/optimization, render, blob URL setup).
Avoid rebuilding/re-fetching every asset on unrelated changes. Cover remote source
updates, additions/removals in tables, replacing files, concurrent inline edits and
navigation. Preserve cursor/selection during relevant background updates.

There is an Up to date / Unpublished changes state. Audit that it compares actual
published output to current draft across related rows/documents/assets; never
infer “clean” from an unavailable source or failed preview. Explain disabled
publish states. Missing resource errors should offer practical recovery (repair or
remove the selected binding) rather than leave a long DID and a dead end. Do not
silently publish with omitted private/unreadable content.

### 3. Managed atomic-saas publishing (major missing deliverable)

Implement a hosting destination adapter with the same status/upload/private-preview/
activate semantics. Reuse the builder and package contract, not a second CMS.
SaaS must validate account-to-drive ownership, hosting entitlement and publishing
rights; use the trusted account session flow without forwarding signing secrets.
Use durable transactional compare-and-swap for activation, private object storage
for immutable blobs, and a customer-content serving origin independent of a
managed drive process. FOSS redb locking is not a multi-process SaaS transaction.

Prove staging publication, private previews, unauthorized access denial, activation
conflict, failed-build preservation, rollback, unpublish, source drive offline,
and image delivery. Live S3/managed delivery has NOT been demonstrated here.
Coordinate atomic-server dependency pin updates only with compatibility checks.
Keep shared drive subscriptions from being charged again for every website.

### 4. Storage/delivery production work

Add retention and reference-aware GC (including failed uploads and concurrent
publication), quota enforcement/reporting, meaningful cap-reached UX, backups and
restore tests covering BOTH metadata and blobs. Measure cache behavior and serving
cost/latency. Never delete a blob still referenced by an active or retained version.
Verify internal S3 end to end, not merely the local BlobBackend path. Make unpublished
exports/assets portable across devices; currently local cache alone is insufficient.
Document manifest compatibility/migration and limits before treating this as stable.

### 5. Reassess renderer/plugin abstractions for the actual product

Current static rendering does not prove arbitrary AI designs or powerful interactive
apps. Review the plugin package, grants and bridge abstractions against design
freedom, structured bindings, reusable CMS controls and a standalone app host.
Prefer extending shared abstractions; don't create parallel form schemas or auth.
Current static CSP blocks arbitrary scripts, live network interactions/workers and
form actions. Changing that requires an explicit runtime/security design, not just
turning off restrictions to make a demo work.

Forms should reuse the Forms implementation associated with PR #1281 once a
compatible revision is verified; its current merge status was not rechecked here.
Keep site deployment, form availability and private response rows independent.
Website rollback must not reopen forms or delete responses. Preview submissions
need an explicit test path. Domain registration/DNS and arbitrary runtimes remain
out of this immediate milestone.

### 6. Remaining authoring/product polish

Review document File embeds, a folder-to-gallery flow, labels/icons, responsive
layout and accessibility. Audit screenshot capture and Assistant input drag/drop
requests against current code before assuming completion; they were discussed but
are not established as delivered by this handoff. Likewise, prior chat persistence,
rate-limit/tool-result recovery and sidebar chat requests are separate work: inspect
their PRs before conflating them with website-hosting completion.

## Local development and verification

These are the previous session's local service paths; check listeners/process
ownership before using/restarting them. Do not replace user state.

- Vite: `http://localhost:6763`, config `/private/tmp/hosting-vite.config.mts`,
  cache `/private/tmp/hosting-vite-cache`, log `/private/tmp/hosting-vite.log`.
  Aliases use this checkout's `browser/lib/dist/index.js` and `browser/react/src/index.ts`.
- Backend: `http://localhost:9897`, binary
  `/private/tmp/atomic-website-rust-build/debug/atomic-server`.
  Data/config/cache under `/private/tmp/atomic-hosting-node/{data,config,cache}`.
- Website origin: `ATOMIC_WEBSITE_ORIGIN=http://sites.localhost:9897`.
  Public URLs are `http://<project-id>.sites.localhost:9897/`.
- Do not restart the backend for UI-only changes. If Rust changes, ensure the
  running binary actually includes them before claiming live validation.
- Vite/Wuchale updates locale .po files. Inspect those diffs; avoid extraction and
  resets racing each other. HMR can disturb tests if edits continue during a run.

From the atomic-server checkout:

```sh
browser/node_modules/.bin/oxfmt -c browser/.oxfmtrc.json <changed-files>
browser/node_modules/.bin/oxlint -c browser/.oxlintrc.json <changed-files>
```

From `browser/data-browser`:

```sh
../node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Focused live browser checks (existing services required):

```sh
FRONTEND_URL=http://localhost:6763 SERVER_URL=http://localhost:9897 WEBSITE_HOSTING_E2E=1 \
  browser/e2e/node_modules/.bin/playwright test \
  --config browser/e2e/playwright.config.ts \
  browser/e2e/tests/website-inline-content.spec.ts \
  browser/e2e/tests/website-preview-stability.spec.ts \
  --project chromium --workers 1 --trace off --reporter line
```

Other suites in `browser/e2e/tests`: `website.spec.ts`, `website-publishing.spec.ts`,
`website-media.spec.ts`, `website-errors.spec.ts`, `website-versions.spec.ts`,
`website-export.spec.ts`. Use the normal isolated E2E setup if existing services
aren't available; don't point destructive tests at the user's drive.

### Evidence and limits

At cb3e6ae00: the two focused Chromium tests above passed together (18.3s),
TypeScript passed, targeted lint had no errors (existing set-state-in-effect
warning in CollaborativeEditor). Tests cover visible slash/@ menus, heading
input, transparent editor background, numeric/document save and reload, and
AI opening without iframe replacement. They do not cover every RTE feature.

Earlier commits passed focused publication/authoring/media/error/version browser
checks and unit/Rust tests. They were not all rerun after the final commit.
No claim of green full CI, Firefox parity, production deployment, load testing or
live S3 verification. Read current PR checks before merge.

## Suggested next session

1. Confirm branch/status, read applicable repo instructions, and inspect PR checks.
2. Reproduce the user's inline RTE interactions in Firefox and address any remaining
   ownerDocument/portal issues. Keep the working publication and source-save paths.
3. Measure preview work and fix one concrete bottleneck or stale-content case.
4. Implement the managed SaaS adapter as a separately reviewable milestone, with
   coordinated compatibility tests and a real staging demo.
5. Report exactly what is verified, what remains a prototype, and which user-visible
   behavior to test next. Do not substitute a toast/build for the requested outcome.
