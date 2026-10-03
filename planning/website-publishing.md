# Website publishing: self-hosted first, managed hosting alongside it

Status: FOSS implementation on `develop` since #1500 (merged 2026-09-17), built
on the Assistant website prototype (#1498, still an open draft). The managed SaaS
adapter is not started. The open follow-ups from the #1500 handoff are in
[Remaining work](#remaining-work) below.

## Contract and boundaries

The browser uploads a version-1 package containing code files, image hash references and optional private preview metadata.
`atomic_lib::website::WebsitePackage` validates paths, file types, a root page,
100-file/5 MB limits and a deterministic content-addressed deployment identity.
No source resource IDs, design configuration, credentials or relationship graph
are included in the public package. Atomic is still the editable source of truth.

A deployment is immutable. Upload does not publish. Activation accepts the
revision the editor reviewed and returns HTTP 409 when another writer has changed
hosting state. Uploads, rollback and unpublish all preserve source records.
Publishing requires authenticated write access to the website AND its containing
drive root, whereas source editing can be delegated more narrowly.

## FOSS implementation

- [x] Shared package validation and deployment IDs in atomic_lib.
- [x] Local persistent storage adapter, private uploads and atomic active pointer.
- [x] Authenticated status/upload/preview/activate API.
- [x] Separate customer-host routing, public files only, no fallback to Atomic APIs.
- [x] Website UI: one-click Publish site / Update site; saving, uploading and
  activation happen inside that action. Secondary actions register with the standard
  resource More menu through useCustomContextItems. Versions open a shared dialog
  for preview, rollback and publication history; export and unpublish are menu
  actions, alongside Design with AI and View site. Publish / Update site is the
  only persistent main action. Hosting status refreshes automatically.
- [ ] Managed SaaS adapter, account/drive ownership proof, object storage and serving.
- [ ] Production capacity measurements, garbage collection and richer assets.

The adapter stores code files and a version-2 manifest as immutable BLAKE3 blobs
through the configured blob backend (local storage or internal S3). The manifest
maps paths to hashes and contains private preview metadata. Only project membership,
upload timestamps, deployment IDs and activation history remain in redb/KV.
Images remain separate HTTP-served blobs; they are never embedded in HTML.
Public serving reads the manifest and the requested file, without querying the
authoring drive or loading every code file.

New exports do not create Atomic resources or modify a website-release pointer.
Identical exports reuse a manifest hash, regardless of when the editor saved them.
Website versions are accessed through publishing history and a frozen preview;
the sidebar has no version children or version-specific expand/collapse controls.
Legacy export resources and KV packages remain readable and are not deleted.
This is a capped pilot: 20 distinct deployments, 100 activation-history entries,
no garbage collection or automatic paid overages. Failed uploads can leave
unreferenced blobs. Back up both the metadata database and the blob backend.

Serving reads the active deployment, returns the file with revalidation headers,
and never reads the source drive. Generated search/runtime URLs are pinned to
that HTML's deployment to avoid mixing runtimes across concurrent publication.
Version URLs are available only for previously activated releases while the site
is published; unpublish hides all versions. Previously downloaded copies cannot
be recalled. Arbitrary generated scripts, live apps and Forms are outside this
static-v1 serving policy: network connections, workers and form actions are blocked.

## Running locally

Start a dedicated Atomic Server with `ATOMIC_WEBSITE_ORIGIN=http://sites.localhost:9897`
and `--port 9897 --ip 127.0.0.1`, plus isolated data/config/cache directories.
Point the data-browser at `http://localhost:9897` with `VITE_ATOMIC_SERVER_URL`.
Each website gets `http://<project-id>.sites.localhost:9897/`; browsers resolve
`.localhost` locally. For command-line clients without wildcard localhost
resolution, connect to 127.0.0.1 and preserve the URL's Host header.

For remote self-hosting, set an HTTPS base origin on a separate customer-content
domain, configure wildcard DNS/TLS at your reverse proxy, and preserve Host when
proxying to Atomic Server. The website domain must not overlap API or drive
routing domains and must also be separate from any externally hosted editor.
This does not implement domain acquisition, DNS provisioning or ACME wildcard
certificate management. With the setting absent, publishing is disabled.

Create a website and click **Publish site**. Later edits go live with **Update
site**. That single explicit action saves the draft snapshot, uploads it and
conditionally activates it. Conflicting publication changes are refused; the
current site stays available if saving/uploading fails. One blue primary button
is visible at a time. Version restore, unpublish, export, Design with AI and
View site are entries in the standard resource More menu (registered through
`useCustomContextItems` in `WebsitePage.tsx` / `WebsiteHosting.tsx`); versions
open a shared dialog and there is no separate "Publishing options" menu or
versions panel. Status loads on mount, after actions and when the browser
window regains focus; no manual refresh control is exposed. Action errors use `store.notifyError` for the
standard toast and logging pipeline.

API routes (all control requests signed with the existing Atomic request proof):

| Method | Path | Result |
| --- | --- | --- |
| GET | `/website-hosting?project=...&drive=...` | Status, active release, revision, history and public URL |
| POST | `/website-hosting/deployments?project=...&drive=...` | Validate/store package, return deployment ID, leave live site unchanged |
| GET | `/website-hosting/preview/{deployment}?project=...&drive=...` | Authenticated JSON package with no-store; never HTML on the editor origin |
| POST | `/website-hosting/activate?project=...&drive=...` | `{ expectedRevision, deployment }`; null unpublishes, old ID rolls back |

## Next: managed hosting

Use the same package contract and review/activation semantics; don't implement a
second website builder. SaaS needs account ownership, a verified relationship to
the authoring drive, hosting entitlements and a durable expected-revision update.
Use object storage for immutable files and a control-plane DB transaction for the
active pointer/history. Customer delivery should remain available independently
of a managed drive's process. The FOSS KV adapter is not a multi-process SaaS CAS.

The frontend should offer a destination adapter with the same four operations.
Self-hosting signs requests only to the configured Atomic node; Cloud should use
the existing trusted SaaS login/account flow, never forward a signing secret or
send Atomic proofs to arbitrary customer domains. Billing/domain registration
remain separate from this publication milestone. Do not bump the SaaS server pin
until both adapters and the cross-repository compatibility checks are ready.

### Media and Assistant authoring

Selected File columns, page galleries and inline document raster images become
separate content-addressed blobs. HTML contains HTTP asset URLs, never image bytes
or base64. Publishing uploads blobs through the existing BlobBackend (internal S3
when `ATOMIC_BLOB_BACKEND=s3`, local storage for FOSS), then activates the manifest.
Only assets of published deployments are public; uploads require project/drive
write authority. HTTP paths pin the deployment so rollback also selects its images.
The S3 bucket stays private behind the serving API.

Browser-native optimization preserves originals, limits the longest edge to 1920px,
and targets 600 KB WebP derivatives. Small images and GIF animation are preserved;
GIFs above 2 MB are rejected explicitly. Source limits are 50 MB and 80 megapixels.
Errors identify the page, field and File. Export ZIPs contain separate image files.
Private exports cache blobs locally until publication uploads them; moving an
unpublished export to another device requires its asset files as well.
Document File embeds and a folder-to-gallery picker remain future work.

The query tool resolves standard File, Folder, Document, Class, Property and Table
aliases from generated ontology constants before consulting user classes.

`update_table_rows` batches existing row edits using schema shortnames and refs,
prechecks table membership and write permissions, and reports partial completion.
Creating columns remains a separate existing tool call. Subject refs persist in
this tab's sessionStorage across reloads; unknown older refs still require
rediscovery. This addresses lost in-memory mappings without claiming a reproduced
cause for every reported same-turn reference failure.

### Inline source editing

Edit on page supports selected string, integer and float table fields, with
typed numeric validation and concurrent-edit checks. Document sections mount
the existing collaborative document editor in the authorized preview, preserving
structured rich text and its normal autosave path. Source permissions and private
authoring checks apply before enabling either editor. The iframe has no scripts
or credentials; React and writes are owned by the Atomic host. Changes update
the draft; publication still requires Update site.

## Remaining work

Carried from the #1500 handoff (2026-09-15/17) when it was deleted. In
suggested order; none of these is a regression against `develop`.

1. **Inline rich text in the preview iframe is not fully verified.** Focused
   Chromium and Firefox runs pass, but not every control is covered: mention
   selection and arrow navigation, bubble menus, link and colour popovers, image
   upload, tables, drag handles, undo/redo, cross-block selection, long
   documents. Some shared RTE components still reference the global
   `document`/`window` or portal defaults; audit them against iframe ownership
   rather than loosening the sandbox. Two known flakes:
   - `website-inline-content` / `website-inline-rte`: characters intermittently
     vanish or land in a new paragraph when typing at human speed. The main
     document editor also commits about once per keystroke at that speed, so
     the save scheduler is a suspect; `loro-prosemirror` logs "Cannot find the
     loroNode" around the failures.
   - `website-inline-rte`: a popup (mention list, link field) open inside the
     iframe is destroyed when the server echoes the author's own commit. The
     echo stamps `lastCommit` on the resource's `properties` map; `LoroSyncPlugin`
     subscribes to the whole doc, so it rebuilds the ProseMirror document for a
     change that never touched `doc`. **Do not re-attempt filtering non-local
     events in `updateNodeOnLoroEvent`**: measured, it broke the mention list
     (the Suggestion plugin relies on those rebuild transactions) and did not
     stop the character drop. The tractable fix is to make the tiptap
     Suggestion plugin re-establish itself after a rebuild; then the filter
     becomes viable. Product decision pending.
2. **Preview speed, invalidation and actionable failures.** Measure the
   "Preparing preview" path (resource fetch, image decode/optimisation, render,
   blob URL setup) before optimising; avoid re-fetching every asset on unrelated
   changes; preserve cursor/selection during background updates. Audit the
   Up to date / Unpublished changes state against actual published output,
   never infer "clean" from an unavailable source. Missing-resource errors
   should offer repair or removal of the binding, not a dead end with a DID.
3. **Managed publishing** (the major missing deliverable): a
   destination adapter with the same status/upload/preview/activate semantics,
   account-to-drive ownership, hosting entitlement, durable compare-and-swap
   activation, private object storage and a customer-content origin
   independent of the managed drive process. Prove staging publication,
   private preview, unauthorised denial, activation conflict, failed-build
   preservation, rollback, unpublish, source drive offline and image delivery.
   Live S3/managed delivery has not been demonstrated.
4. **Storage and delivery production work**: retention and reference-aware
   GC (failed uploads, concurrent publication), quota enforcement and
   cap-reached UX, backup and restore covering metadata and blobs, cache and
   serving cost measurements, portable unpublished exports across devices,
   documented manifest compatibility and limits.
5. **Reassess renderer/plugin abstractions** against arbitrary AI designs and
   interactive apps; the static CSP blocks scripts, network, workers and
   forms, and changing that needs an explicit runtime/security design. Forms
   should reuse the implementation from PR #1281 once a compatible revision
   is verified (its merge status was not rechecked). Site deployment, form
   availability and private response rows stay independent; rollback must
   not reopen forms or delete responses.
6. **Authoring polish**: document File embeds, folder-to-gallery, labels and
   icons, responsive layout, accessibility. Screenshot capture and Assistant
   drag/drop were discussed but are not established as delivered.

Harness notes that only matter for these specs: the website preview iframe
wants an origin separate from the app, so the production (embedded-in-server)
topology CI uses breaks the website specs while the Vite topology passes them;
do not compare results across topologies mid-investigation.
