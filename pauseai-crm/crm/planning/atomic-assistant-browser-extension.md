# Atomic Assistant Browser Extension

> **Status:** Proposal (2026-07-14).
>
> This plan covers a Chromium-first browser extension that can read the current
> webpage, help fill forms from explicitly selected Atomic data, and persist AI
> conversations as Atomic resources. The core experience must work locally and
> must not require an AtomicServer.eu Server subscription. Vault and Server are
> optional availability upgrades, not prerequisites.

## Goal

Ship an Atomic Assistant browser extension that:

- runs `atomic_lib` as WASM with an extension-owned OPFS database;
- works offline after installation and local setup;
- reads a user-approved representation of the active webpage;
- maps form fields to user-approved personal information and previews fills;
- fills approved fields without automatically submitting the form;
- persists conversations using the existing Atomic AI chat model;
- can exchange selected data with Atomic Data Browser without requiring a
  desktop installation or paid hosted server;
- can optionally use Vault or a managed/self-hosted AtomicServer for backup,
  catch-up, and always-on sync.

The first release is successful when a user can install the extension, create
or import a local autofill profile, use it to fill a form while offline, close
and reopen the browser, and recover the conversation and profile from the
extension's OPFS database.

## Product Boundary

The extension follows the Atomic SaaS local-first tiers instead of creating a
new server requirement:

| Tier | Atomic Assistant behavior |
| --- | --- |
| Free / local | Extension OPFS, offline form fill, local AI chats, explicit pairing with the user's own Atomic clients when reachable |
| Vault | Optional encrypted backup and device catch-up; all profile lookup and AI context materialization remains client-side |
| Server | Optional always-on sync, collaboration, public URLs, and API/integration availability |

Hosted model inference is a separate commercial and privacy decision. A user
may use a locally configured model, bring their own provider key, or use a
future hosted AI plan; none of those choices should change ownership of the
Atomic drive.

## Non-goals For Version 1

- Fully autonomous browsing across multiple sites.
- Automatically submitting forms.
- Filling passwords, payment-card fields, one-time codes, or security answers.
- Clicking purchase, send, publish, delete, or consent actions.
- Running arbitrary page JavaScript supplied by the model.
- Giving a webpage, content script, or model provider the user's Atomic agent
  secret.
- Mirroring every resource from a user's personal drive into the extension.
- Shipping Firefox/Safari support before the Chromium runtime is proven.
- Making serverless browser P2P a prerequisite for the local-only MVP.

## Existing Building Blocks

Use the current implementations rather than copying their behavior:

- `browser/lib/src/client-db.ts`: `ClientDbWorker`, WASM, OPFS persistence,
  queries, and leader coordination.
- `browser/lib/src/store.ts`: resources, agent identity, local outbox, signed
  commits, WebSocket/HTTP routing, local-only drives, and reconciliation.
- `browser/data-browser/src/chunks/AI/RealAIChat.tsx` and
  `ClientOnlyTransport.ts`: client-side model execution and chat interaction.
- `browser/data-browser/src/chunks/AI/useAtomicTools.ts`: Atomic read, query,
  schema, create, and edit tools.
- `browser/data-browser/src/chunks/AI/chatConversionUtils.ts`: persistence of
  existing `AiChat`, `AiMessage`, and message-part resources.
- `lib/defaults/ai.json`: the adopted AI chat schema.
- `planning/atomic-lib-runtime.md`: the target `AtomicNode` WASM surface.
- `planning/unified-sync.md`: signed `COMMIT` for persisted writes and
  reconciliation for replica catch-up.
- `planning/device-pairing.md`: pairing codes are routing only and must never
  carry an agent secret.
- `planning/encryption.md`: browser cache encryption and logout/session
  isolation remain production blockers for sensitive local data.

## Current Gaps

1. `ClientDbWorker` has not been proven inside a Manifest V3 extension origin.
2. OPFS is origin-private; the extension cannot open Atomic Data Browser's
   OPFS file.
3. There is no scoped Data Browser to extension pairing bridge.
4. The browser `Store` is a client, not a complete browser-to-browser sync
   responder.
5. AI chat code is coupled to Data Browser React hooks and UI.
6. No page-observation or browser-action tool boundary exists.
7. Autofill-specific personal data has no adopted Atomic schema yet.
8. Private OPFS data is not yet encrypted and isolated across logout/agent
   changes.
9. Webpage prompt injection, sensitive-field classification, and action
   confirmation need a dedicated security model.

## Architecture

```text
Active webpage
  content script
    - semantic page snapshot
    - stable element handles
    - restricted fill/click executor
          |
          | versioned messages
          v
Extension service worker
    - active-tab permission broker
    - per-site grants
    - routes messages; holds no plaintext drive database
          |
          v
Extension runtime host
    - Atomic Store / future AtomicNode
    - atomic_lib WASM + ClientDbWorker
    - extension-origin OPFS
    - agent keys and local outbox
    - model/tool execution
          |
          +---- side panel UI
          |
          +---- optional local pairing bridge
          |
          +---- optional WS/Vault/peer transport
```

The runtime host may initially be the side-panel extension page. Background
sync requires a separately tested offscreen-document or equivalent lifecycle;
do not assume a Manifest V3 service worker can keep the WASM database open.

### Trust boundaries

- **Page:** untrusted. It can influence labels, text, DOM state, and model
  context but never receives keys or broad Atomic query results.
- **Content script:** minimally trusted executor. It receives only the values
  approved for a specific field/action and never owns Atomic credentials.
- **Extension runtime:** trusted verifier. It owns OPFS, identity, rights
  checks, model configuration, and approvals.
- **Model provider:** data recipient only for the content explicitly selected
  by the user. Personal values should be tokenized whenever the model only
  needs to choose a mapping.
- **Sync transport:** routing and state transfer, not mutation authority.
  Persistent Atomic writes remain signed commits.

## Data Model

### Existing adopted model

Reuse `AiChat`, `AiMessage`, and AI message-part resources. Do not create a
parallel `AssistantChat` transcript format. A local assistant drive or folder
contains the chats, and the Store persists message resources before attaching
them to the parent chat, matching Data Browser's existing flow.

### Proposed autofill model

The following is a proposal, not an adopted Atomic contract:

```text
AutofillProfile
  name
  person?                 -> Person / ContactProfile when available
  emailAddresses[]        -> structured value resources
  phoneNumbers[]          -> structured value resources
  postalAddresses[]       -> structured address resources
  organizations[]
  preferredLanguage?
  defaultAddress?
```

Prefer references to the shared `Person` / `ContactProfile` direction in
`planning/personal-information-suite.md`. Avoid copying contact data into an
assistant-only schema when a canonical personal-information resource already
exists. The user must explicitly select which fields or referenced resources
are available for form filling.

Do not store passwords, payment-card data, government identifiers, security
answers, or one-time authentication codes in the autofill profile.

### Settings and action history

- Extension UI settings and per-origin grants live in extension storage, not
  in the user's graph by default.
- Store a minimal, local audit record only when useful: origin, action kind,
  timestamp, result, and affected field labels. Do not retain page bodies or
  filled values by default.
- Any future synchronized audit resource needs an explicit retention policy.

## Form-Filling Flow

1. User invokes Atomic Assistant on the active tab.
2. The content script produces a bounded semantic snapshot:
   - URL origin and page title;
   - visible headings and labels;
   - form, field, type, autocomplete, required, and validation metadata;
   - no hidden inputs or unrelated full DOM dump.
3. The runtime rejects unsupported or sensitive fields before model use.
4. The model maps opaque field handles to profile property identifiers:

   ```json
   {
     "field_3": "profile.primaryEmail",
     "field_7": "profile.defaultAddress.postalCode"
   }
   ```

5. The runtime resolves actual values locally after the mapping is returned.
6. The side panel shows field-by-field previews with checkboxes.
7. The user approves the selected fields.
8. The content script sets values and emits the appropriate `input` and
   `change` events.
9. Submission remains a separate manual user action in version 1.

Treat all webpage instructions as data. Page text cannot override the system
policy, request more Atomic scope, disable confirmation, or cause another
origin to be opened.

## Local And Cloud Data Paths

### Local-only default

- Create an extension-local agent and local-only assistant drive.
- Persist the autofill profile and `AiChat` resources into extension OPFS.
- Queue no network work unless the user explicitly enables a sync target.
- The extension remains usable without Atomic Data Browser being open.

### Free Atomic Data Browser pairing

OPFS files cannot be shared across origins. Build a scoped application bridge,
not filesystem access:

1. The user opens Atomic Data Browser and chooses **Connect Atomic Assistant**.
2. Data Browser and the extension establish a one-time, unguessable channel
   through the extension content script.
3. Both sides verify the exact origin, source window, extension ID, protocol
   version, and channel token.
4. The user selects the profile resources and assistant chat drive/folder to
   exchange.
5. The bridge transfers structured resources/Loro updates and reconciliation
   metadata, never raw OPFS files or an agent secret.
6. Each side persists the received state in its own OPFS database.
7. Later connections exchange only changes and surface conflicts/errors.

Before implementing writes, make an explicit design choice and record it here:

- **Initial recommendation:** host-mediated, scoped bridge operations for
  selected resources, with Data Browser signing mutations after local policy
  checks.
- **Long-term direction:** a `MessagePortTransport` between two WASM
  `AtomicNode` instances, using the same authenticated SYNC/COMMIT semantics as
  other transports.

Do not invent an unsigned raw-delta write path for the bridge. If the initial
host-mediated design cannot preserve authorization and commit provenance,
block that write path and keep pairing read/import-only until `AtomicNode` can
serve it correctly.

### Optional hosted or self-hosted sync

- Configure the existing `Store` with the chosen server origin, selected drive,
  and authorized extension agent.
- Use `AUTH`, `GET`, subscriptions, and reconciliation for reads/catch-up.
- Use signed `COMMIT` messages for chats and profile edits; HTTP remains only a
  fallback transport.
- A managed Server plan supplies always-on availability but must never be
  checked as a prerequisite in extension feature code.
- Cloud Vault can become the encrypted backup/catch-up transport when its
  accepted architecture is implemented; it is not a dependency for the MVP.

## Identity And Authorization

- Never transfer the user's primary agent secret through a webpage, QR code,
  content script, or extension message.
- Generate a non-extractable extension agent where possible.
- For hosted/self-hosted sync, grant that agent the minimum rights needed:
  read selected profile resources; read/write the chosen AI-chat folder.
- Keep profile read access and chat write access separately revocable.
- Node IDs, extension IDs, origins, and pairing tokens are routing/session
  identifiers, not authority.
- Every bridge or remote mutation is either signed by the authorized extension
  agent or host-mediated and signed after the trusted host checks its scope.
- Logout/revocation drops in-memory keys, closes transports, and makes cached
  private data unreadable. Public release is blocked until encrypted cache or
  an equally strong session-isolation mechanism exists.

## Delivery Plan

### P0 — Extension runtime feasibility spike

- [ ] Create a disposable Chromium MV3 extension under `browser/extension/`.
- [ ] Use the existing pnpm/Vite toolchain; bundle all JavaScript and WASM
      locally to satisfy extension CSP.
- [ ] Prove `atomic_wasm.js` loads from `chrome-extension://`.
- [ ] Prove a dedicated worker can open, write, flush, close, and reopen OPFS.
- [ ] Prove `navigator.locks` and `BroadcastChannel` behavior in extension
      pages, or document a simpler single-runtime replacement.
- [ ] Determine whether the runtime lives in the side panel, an offscreen
      document, or both; measure suspension/restart behavior.
- [ ] Prove authenticated WebSocket access to a development AtomicServer from
      an extension origin.
- [ ] Verify signed cross-origin HTTP fallback without relying on setting a
      cookie for another origin.
- [ ] Add a Playwright persistent-context smoke test that reloads the extension
      and confirms OPFS data survives.

**Exit:** one resource survives a full browser restart in extension OPFS and an
authenticated development sync round-trip works. If this fails, revise the
runtime host before building UI.

### P1 — Extension shell and permission broker

- [ ] Add a side-panel chat shell using existing Atomic UI primitives where
      practical.
- [ ] Add a Manifest V3 service worker that routes versioned messages.
- [ ] Request `activeTab`/`scripting` access on user invocation; do not request
      blanket access to every site at install time.
- [ ] Add per-origin allow/revoke controls and a visible active-origin status.
- [ ] Keep content scripts stateless and credentials-free.
- [ ] Add runtime validation for every cross-context message.
- [ ] Add a development page showing runtime, OPFS, agent, and permission
      health without displaying secrets.

**Exit:** side panel opens on an allowed test page, reads a harmless snapshot,
and loses access after the user revokes the site.

### P2 — Local Atomic workspace and chat persistence

- [ ] Create/import a non-extractable extension agent.
- [ ] Initialize a local-only assistant drive in extension OPFS.
- [ ] Extract a UI-independent assistant core from `RealAIChat`,
      `ClientOnlyTransport`, and Atomic tool construction; keep Data Browser and
      extension as separate UI hosts.
- [ ] Reuse `AiChat` / `AiMessage` persistence helpers, moving shared code into
      an appropriate browser package instead of importing Data Browser internals.
- [ ] Save user and assistant messages incrementally; avoid creating empty chat
      resources.
- [ ] Restore conversations after extension/browser restart.
- [ ] Add local query/list/delete flows for assistant chats.
- [ ] Verify offline message creation followed by a fast reload does not lose
      messages.

**Exit:** chats persist locally and can be reopened offline with no server or
desktop app installed.

### P3 — Autofill profile

- [ ] Decide whether the first schema extends existing Person/Contact resources
      or introduces the proposed `AutofillProfile` wrapper.
- [ ] Add a profile editor that makes every available field explicit.
- [ ] Add import from a selected Atomic resource/bundle without importing the
      whole drive.
- [ ] Add field-level enable/disable controls.
- [ ] Add local token resolution so the model maps property identifiers rather
      than receiving raw personal values when possible.
- [ ] Add export/delete/reset controls before storing real personal data.
- [ ] Reject sensitive categories that are outside version 1.

**Exit:** a user can create or import a profile, restart offline, inspect it,
and delete it completely.

### P4 — Safe webpage reading and form filling

- [ ] Build the bounded semantic snapshot extractor.
- [ ] Assign stable, unguessable per-snapshot element handles; expire them on
      navigation or meaningful DOM replacement.
- [ ] Implement field classification and block password/payment/OTP/security
      fields independently of the model.
- [ ] Implement `inspect_page`, `list_form_fields`, and `propose_form_fill`
      tools with runtime schemas.
- [ ] Implement a preview diff showing current and proposed values.
- [ ] Implement approved field writes with framework-compatible input/change
      events.
- [ ] Handle normal inputs, textareas, selects, checkboxes, and radio groups.
- [ ] Treat cross-origin iframes and closed shadow roots as unsupported in v1;
      report them clearly.
- [ ] Do not implement `submit_form` in v1.
- [ ] Add fixtures for plain HTML, React-controlled inputs, validation errors,
      dynamic forms, and malicious prompt-injection text.

**Exit:** the extension correctly fills approved fields in all supported
fixtures, never fills blocked fields, and never submits a form.

### P5 — Free local pairing with Atomic Data Browser

- [ ] Specify a versioned `AtomicAssistantBridge` request/response protocol.
- [ ] Add an explicit **Connect Atomic Assistant** flow in trusted Data Browser
      UI; do not auto-enable a bridge just because the extension is installed.
- [ ] Establish a channel token and validate origin, source, extension ID,
      message type, payload size, and protocol version on both sides.
- [ ] Let the user select profile resources and an AI-chat destination.
- [ ] Implement initial profile import/export through structured resources.
- [ ] Implement incremental chat exchange using the adopted AI chat model.
- [ ] Preserve signed mutation provenance or keep the bridge read-only where
      provenance cannot yet be preserved.
- [ ] Queue changes while the Atomic tab is closed and reconcile when it next
      opens.
- [ ] Add revoke/unpair and local-data deletion flows on both sides.
- [ ] Add two-origin E2E coverage: Data Browser OPFS and extension OPFS start
      different, pair, exchange allowed data, reject an ungranted resource,
      diverge offline, and reconcile.

**Exit:** a Free user can exchange the selected profile and AI chats with Data
Browser without a desktop app, hosted node, or agent-secret transfer.

### P6 — Optional sync targets

- [ ] Add self-hosted/managed AtomicServer connection setup using the existing
      Store transport.
- [ ] Add extension-agent authorization/grant UI with separate profile-read and
      chat-write scopes.
- [ ] Reconcile extension OPFS after offline edits and verify conflicts with two
      clients.
- [ ] Surface connection state without blocking local reads/writes.
- [ ] Discover capabilities rather than branching on SaaS plan names inside
      core extension code.
- [ ] Add Vault backup/catch-up only after the client-side vault implementation
      exists and has its own threat-model verification.
- [ ] Verify cancelling a paid target leaves the complete local workspace
      usable.

**Exit:** paid/self-hosted targets improve availability, but disabling them does
not disable Assistant or remove the local source of truth.

### P7 — Security, privacy, and release hardening

- [ ] Complete a threat model covering hostile pages, model prompt injection,
      compromised providers, malicious extensions, message spoofing, stolen
      browser profiles, and revoked Atomic rights.
- [ ] Encrypt private OPFS content or otherwise meet the session-isolation
      requirements in `planning/encryption.md`.
- [ ] Add redaction tests proving raw profile values are not sent to the model
      for mapping-only flows.
- [ ] Add CSP tests proving no remote executable code can load.
- [ ] Cap snapshot size, tool calls, model tokens, bridge messages, and local
      audit retention.
- [ ] Add a clear action indicator whenever the extension is inspecting or
      modifying a page.
- [ ] Add accessible keyboard navigation and screen-reader labels.
- [ ] Add localization using the existing browser workflow.
- [ ] Package a reproducible unsigned build for review, then complete Chrome
      Web Store privacy disclosures.
- [ ] Run a Firefox feasibility spike only after the Chromium release gates are
      green.

## Test Strategy

### Unit tests

- Semantic snapshot extraction and size bounds.
- Sensitive-field classification.
- Profile-token mapping and local resolution.
- Message schema validation and channel-token checks.
- Site grant evaluation and revocation.
- Chat resource conversion and incremental persistence.
- Prompt-injection policy cases.

### Integration tests

- `ClientDbWorker` lifecycle in an extension origin.
- OPFS flush and reopen after worker/page suspension.
- Offline chat/profile writes and outbox behavior.
- Signed WS commit with HTTP fallback.
- Data Browser bridge with allowed and denied subjects.
- Revoked extension agent can no longer read/write a remote target.

### Extension E2E tests

Use Playwright with a persistent Chromium context and the unpacked extension:

- install/open side panel;
- grant and revoke the active tab;
- read a fixture page;
- preview and fill a React-controlled form;
- verify no submit occurred;
- restart Chromium and reload chats/profile from OPFS;
- run offline;
- pair with `http://localhost:6747/app/dev-drive` and exchange selected data;
- inject hostile page instructions and verify they cannot widen scope or skip
  confirmation.

## Release Gates

Version 1 must not ship until all are true:

- [ ] No Server subscription or desktop app is required for the local workflow.
- [ ] Profile and chats survive a browser restart offline.
- [ ] The extension cannot fill sensitive fields or submit forms.
- [ ] Every fill is previewed and explicitly approved.
- [ ] Page/content-script contexts never receive agent keys or unrestricted
      Atomic query access.
- [ ] Private cached data becomes unreadable after logout/revocation.
- [ ] Pairing transfers neither raw OPFS files nor an agent secret.
- [ ] Local writes remain usable after any cloud target is disabled.
- [ ] The extension E2E suite covers persistence, permission revocation,
      malicious page content, and pairing.

## Likely File Layout

```text
browser/
  extension/
    manifest.json
    src/background/
    src/content/
    src/runtime/
    src/sidepanel/
    e2e/
  assistant-core/          # only if extraction merits a package boundary
    src/chat/
    src/tools/
    src/policy/
    src/protocol/
```

Do not create `assistant-core` pre-emptively. First extract one concrete shared
chat/tool boundary from Data Browser; create the package only when both hosts
use it without importing app-specific React state.

## Open Decisions

- [ ] Chromium-only v1, or Chromium plus Firefox from the first public beta?
- [ ] Side-panel-only runtime, or offscreen runtime for background sync?
- [ ] Adopt a dedicated `AutofillProfile` class or treat it solely as a scoped
      view over Person/Contact resources?
- [ ] Which model modes ship: local model, bring-your-own-key, hosted Atomic AI,
      or a combination?
- [ ] Should page summaries ever be persisted, or only explicit user/assistant
      messages and approved tool results?
- [ ] Is the first Data Browser bridge host-mediated, or should P5 wait for a
      WASM `AtomicNode` responder and `MessagePortTransport`?
- [ ] What encrypted-key recovery UX is required for extension-only local data?

## Progress

- [x] Product direction agreed: browser extension, local-first, OPFS-backed.
- [x] Server subscription classified as optional, not a core requirement.
- [x] Existing Store, ClientDb, AI tool, and `AiChat` reuse paths identified.
- [ ] P0 extension runtime feasibility spike started.
