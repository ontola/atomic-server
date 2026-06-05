# LLM-Generated JS Applications and Future WASM Plugins

## Goal

Let Atomic host existing and LLM-generated applications that use Atomic for
persistence, sharing, authorization, and collaboration. The first release
supports browser-built JS/TS applications containing:

- a sandboxed GUI;
- one or more scoped application-state profiles;
- a manifest describing capabilities and configuration.

Generated code must never become installed executable code solely because the
LLM called a normal Atomic write tool. Building, installation, and activation
are separate, auditable capability boundaries, and installation requires
explicit user approval. WASM runtime modules remain an optional future
extension, not a requirement for the initial application platform.

## Current State

Atomic currently has two plugin runtimes joined by one zip package:

| Layer | Artifact | Runtime | Atomic identity | Atomic access |
| --- | --- | --- | --- | --- |
| Class extender | `plugin.wasm` | Server-side Wasmtime component | Dedicated plugin agent | WIT host functions |
| Custom view | `ui.js` and optional `ui.css` | Null-origin sandboxed iframe in Data Browser | User agent for writes; plugin agent only used for access checks | `postMessage` RPC to the parent Data Browser |

There is no source-code model, compiler service, build job, test job, preview
job, or LLM plugin tool. The install flow accepts an already-built zip.

### Package and install lifecycle

1. The frontend reads `plugin.json` from an uploaded zip in
   `chunks/Plugins/plugins.ts`.
2. The install dialog shows manifest metadata, requested permissions, and a
   JSON-schema-backed config editor.
3. `useCreatePlugin` creates an Atomic Plugin resource under the drive, uploads
   the zip as a File resource, then sets `pluginFile`.
4. The built-in server Plugin class extender sees the `pluginFile` change and
   installs the package.
5. The server validates that the zip contains `plugin.wasm` and `plugin.json`,
   allows only `ui.js`, `ui.css`, and `assets/` in addition, and requires the
   `custom-view` manifest permission when `ui.js` exists.
6. Files are extracted under the drive-scoped plugin directory. Wasmtime loads
   the component and registers its exported class URLs as class extenders.
7. Plugin metadata stores the manifest, Plugin resource subject, and the secret
   of a dedicated plugin agent.
8. The frontend refreshes `/plugin-list` after install or update.

Updates replace the package while preserving the plugin agent. The server keeps
backup files and rolls back files and metadata when loading the replacement
fails. Uninstall removes the registered extender and package files.

### Server-side WASM runtime

The WASM ABI is the `atomic:class-extender` component world in
`atomic-plugin/wit/class-extender.wit`.

Exports:

- `class-url`
- `on-resource-get`
- `before-commit`
- `after-commit`

Host imports:

- `get-resource`
- `query`
- `get-plugin-agent`
- `get-config`
- `commit`

Wasmtime creates a fresh instance for calls, enables fuel metering, applies a
memory limiter, and conditionally links WASI HTTP and a storage directory based
on manifest permissions. Server-side commits are signed by the plugin agent and
cannot modify Plugin resources.

The server does not compile source code. "Compiling" during install means
Wasmtime precompiles an already-built component into a cached `.cwasm` file.

### Frontend discovery and view selection

`CustomViewProvider` fetches:

```text
GET /plugin-list?drive=<drive subject>
```

The response maps each installed plugin to its exported WASM classes, UI file
presence, and Plugin resource subject. The provider builds:

- class subject -> `namespace.name`;
- `namespace.name` -> UI plugin data.

`ResourcePage` considers a custom view only when:

- no built-in React page handles the resource; and
- the resource's first `isA` value maps to a plugin.

Consequences:

- A plugin cannot override a built-in page.
- Multiple classes are not properly considered; only the first class selects a
  view.
- Multiple plugins extending the same class silently resolve to the last item
  returned by `/plugin-list`.
- Discovery depends on the server and does not work from the browser's local
  WASM/OPFS node while offline.

### Frontend sandbox

`PluginView` renders the custom view in:

```html
<iframe
  sandbox="allow-scripts allow-downloads allow-pointer-lock allow-presentation"
  referrerpolicy="no-referrer"
>
```

The iframe receives a real `/plugin-ui?...&format=html` response so it can have
its own Content Security Policy. It has a null origin and cannot access parent
DOM, cookies, storage, or JavaScript. Theme variables and reset CSS are sent by
the parent with `postMessage`.

The generated HTML loads one module script and optional CSS. Code splitting is
not supported. UI assets must currently be inlined.

The current iframe CSP includes `connect-src *`, `img-src * data:`, and
`font-src *`. Therefore a custom view can communicate with external services
when their CORS policy permits it. The manifest's `network` permission controls
server-side WASM, but does not control GUI network access.

### Frontend RPC

The `@tomic/plugin` package provides an `RPCClient`. The host-side `RPCServer`
in `views/PluginView/pluginRPC.tsx` supports:

- get page context;
- get resource;
- commit;
- subscribe/unsubscribe;
- navigate;
- pick resource;
- pick file.

`query` and `search` exist in the protocol but return `"not implemented"`.

The documented Commit type includes `push`, but the host commit handler applies
only `set`, `remove`, and `destroy`. GUI writes are made through the user's
store and signed by the user's agent, unlike WASM writes signed by the plugin
agent.

The host automatically permits reads and writes around the current page scope
and checks inherited rights granted to the plugin agent. Outside that scope it
shows a user prompt. Prompt grants are stored in browser local storage under:

```text
atomic.plugins.ui.<namespace.name>
```

These grants are separate from Atomic rights and server WASM permissions. They
are not scoped by drive, Plugin resource, package hash, or version. A plugin
with the same namespace and name on another drive, or a replacement version,
inherits the old GUI grants in that browser profile.

### Current AI agent

AI chat execution is client-side. `RealAIChat` composes Atomic read/write tools,
skill tools, and configured MCP tools, then passes them to `streamText`.

The Atomic tools can inspect schemas and create/edit resources. They cannot:

- create a multi-file source workspace;
- invoke a compiler or package manager;
- run plugin tests;
- create a plugin zip;
- preview a generated GUI;
- install/update/uninstall a plugin through a dedicated approval flow.

MCP can expose such operations today, but there is no first-party plugin
builder protocol or UI.

## Primary Application Use Cases

The initial JS/TS plugin target is broader than a custom resource renderer.
Atomic should host existing applications that want persistence, sharing,
authorization, offline storage, and sync without forcing their internal state
into Atomic properties.

### Collaborative application document: IronCalc

IronCalc already has an internal JSON/JS model and is willing to use Loro for
collaboration. It should own its application-level Loro document while Atomic
provides:

- a stable subject and metadata resource;
- read/write authorization;
- signed update certificates;
- local persistence and offline outbox;
- real-time and peer-to-peer transport;
- presence and ephemeral collaboration messages;
- blob storage for imported/exported files and large assets.

Do not make IronCalc translate every cell or internal operation into Atomic
properties. Do not give it unrestricted access to the Loro document that backs
an Atomic metadata resource: that document contains Atomic properties such as
rights, parent, and class, so arbitrary updates would bypass the host mutation
policy.

Instead introduce a dedicated **application document** with two separately
owned parts:

```text
ApplicationDocument metadata resource (Atomic-owned)
  subject
  isA
  parent
  read / write
  applicationRelease
  payloadSubject

Application payload document (application-owned Loro)
  arbitrary Loro containers and application schema
```

The payload document is opaque to Atomic's property materializer and search
index. Atomic validates that a plugin is allowed to edit that payload subject,
then signs and syncs its Loro deltas. It cannot use payload deltas to mutate the
metadata resource. The payload has no independently editable rights: every
read/write authorization check resolves through its metadata resource.

These payload commits must carry **incremental** Loro updates, not a full
snapshot per edit — otherwise a large collaborative document re-syncs and
re-stores its entire state on every keystroke. See
[`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md)
(fix #1); the same incremental-export path should back app payload documents,
with periodic compaction snapshots rather than a full write each time.

The JS SDK should expose a scoped collaborative-document session rather than a
general commit API:

```ts
const session = await atomic.openLoroDocument({
  document: context.resource.subject,
  mode: 'readwrite',
});

session.doc;                  // application-owned LoroDoc
session.onRemoteUpdate(...);
session.publishLocalUpdate(...);
session.setEphemeralState(...);
```

The host owns the transport, authorization check, update signing, persistence,
rate limits, and lifecycle of the session. The plugin receives neither agent
secrets nor access to unrelated Atomic Loro documents.

Atomic cannot understand or validate application-level semantic operations in
an opaque payload. The app is responsible for its own schema compatibility and
Loro invariants. Atomic remains responsible for authorization, resource limits,
preventing payload updates from escaping their allocated document, and keeping
enough history to recover from a buggy or malicious application release.

### Opaque checkpoint application: photo editor

A photo editor may not have one mergeable internal state object and should not
be required to create one. It can periodically serialize its current project or
image to bytes and ask Atomic to save a checkpoint.

Atomic should provide a blob-document API:

```ts
const document = await atomic.openBlobDocument(context.resource.subject);
const current = await document.readHead();

await document.saveCheckpoint(bytes, {
  mimeType: 'application/x-photo-project',
  expectedHead: current.revision,
});
```

The host:

1. hashes and stores the bytes through `BlobBackend`;
2. creates immutable checkpoint metadata;
3. updates the document head through the normal Loro/outbox path;
4. signs outside the plugin sandbox;
5. preserves conflicting checkpoints when `expectedHead` is stale.

Each `saveCheckpoint` stores **full opaque bytes**, and conflicting heads are
kept as branches — so retained checkpoints grow unbounded without a retention
and blob-GC policy. This is the same dead-weight growth that
[`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md)
describes for retained full Loro snapshots; blob checkpoints need an equivalent
pruning policy (keep recent + tagged revisions, GC unreferenced blobs) so a
chatty editor doesn't accumulate gigabytes of superseded project bytes.

This provides persistence, sharing, offline use, version history, and
coarse-grained collaboration. It does not claim real-time semantic merging.
Concurrent editors produce explicit branches/conflicts that users or the photo
editor can resolve. Preview images and other derived blobs can be attached to a
checkpoint without exposing arbitrary resource mutation.

### State profiles, not unrestricted commits

The first plugin SDK should offer narrow state profiles:

| Profile | Application owns | Atomic owns | Collaboration semantics |
| --- | --- | --- | --- |
| `atomic-properties` | Values for explicitly granted properties | Resource Loro doc, schema, authorization, signing | Property-level Loro merge |
| `loro-document` | Entire dedicated payload Loro doc | Metadata, authorization, signing, persistence, transport | Application-defined real-time CRDT |
| `blob-checkpoints` | Opaque serialized bytes | CAS blobs, revisions, heads, authorization, signing | Checkpoints with conflict preservation |

A release declares which profiles it supports. An installation grants access to
specific document subjects and operations. None of these profiles exposes the
user secret, arbitrary signed commits, or unrestricted access to the Atomic
metadata Loro document.

These profiles should be useful to normal third-party applications regardless
of whether their code was written by an LLM. LLM-generated views are one
consumer of the same constrained application SDK.

## Important Gaps

### Security and consent

- [ ] GUI network access must be capability-controlled. `custom-view` should
  not imply unrestricted `connect-src *`.
- [ ] GUI grants must be keyed by immutable installed artifact identity and
  drive, not only `namespace.name`.
- [ ] Server WASM capabilities, Atomic rights, and GUI RPC grants need one
  understandable permission model.
- [ ] Installing code must be distinct from ordinary Atomic resource writes.
- [ ] Generated packages need provenance, source hash, artifact hash, build
  logs, and test results.
- [ ] The plugin UI endpoints and path construction need a focused security
  audit before accepting LLM-generated names and artifacts.
- [ ] Sign frontend state-profile operations as the user while recording the
  initiating release and artifact hash. Frontend applications must not receive
  a plugin-agent secret.

### Developer/runtime API

- [ ] Replace general frontend `commit()` with scoped state-profile APIs:
  property mutation, dedicated Loro payload sessions, and blob checkpoints.
- [ ] Define application payload documents whose arbitrary Loro roots cannot
  mutate or be materialized as Atomic metadata properties.
- [ ] Define checkpoint revisions, expected-head conflict detection, branching,
  and retention for opaque blob applications.
- [ ] Add host-mediated ephemeral/presence channels for collaborative
  application documents.
- [ ] The current class-extender ABI is event-hook-oriented. It is enough for
  validation and reactions, but not a general command/tool API callable by a
  GUI or LLM.
- [ ] `query` and `search` in frontend RPC must either be implemented or
  removed from the public SDK.
- [ ] Align the frontend Commit API with Loro-backed writes. Remove stale
  `push`/`yUpdate` promises or implement a host mutation API with explicit
  semantics.
- [ ] Support serving package UI assets without granting filesystem or
  unrestricted network access.
- [ ] Define view slots and deterministic conflict resolution instead of
  first-`isA`, default-page-only replacement.
- [ ] Define how plugins execute in browser/local-node and offline runtimes.
  The current WASM plugin runtime is server-only.

### Build and lifecycle

- [ ] Define a source workspace and lockfile format.
- [ ] Build JS/TS in an isolated browser worker with no ambient secrets, a fixed
  SDK/toolchain version, CPU/memory/time/output limits, and network disabled by
  default.
- [ ] Validate source and manifest before building, then validate the resulting
  UI bundle and any optional runtime module before preview.
- [ ] Test the GUI and its declared state profiles against a mock/ephemeral
  Atomic host.
- [ ] Make preview run the exact immutable artifact proposed for installation.
- [ ] Keep installation an explicit user confirmation that displays code diff,
  artifact diff, permissions, tests, and provenance.

## Proposed Model

### Separate source, build, release, and installation

Represent plugin development as Atomic resources:

```text
PluginProject
  sourceArchive / source files
  sdkVersion
  buildDefinition
  owner

PluginBuild
  project
  sourceHash
  builderVersion
  status
  logs
  testReport
  artifactFile
  artifactHash

PluginRelease
  build
  manifest
  schemaBundles
  artifactHash
  provenance

InstalledPlugin
  release
  drive
  grantedCapabilities
  pluginAgent
  approvedBy
```

The current Plugin resource can evolve into `InstalledPlugin`, but it should
reference an immutable release rather than treating an uploaded mutable zip as
the complete lifecycle model. It must not activate merely because the resource
or artifact arrived through sync. Publishing a release, approving installation
for a drive, and activating it on a particular node are separate operations:

1. The publisher signs an immutable release and its provenance.
2. A drive authority explicitly approves a release and capability grant.
3. Each capable verifier node applies local policy before activating it.

The installation record is portable Atomic state. Activation is node-local
runtime state tied to that approved record. Nodes without a compatible or
trusted runtime can store, inspect, and sync the record without executing it.

Project files and mutable build metadata use normal Loro-backed resources and
the ordinary mutation/outbox/sign-at-drain path. Immutable releases, artifact
hashes, and signed provenance are the publication boundary. The LLM must not be
able to trigger activation by writing a reserved property on an ordinary
resource.

### Roles and authority

Keep these identities distinct:

- **LLM agent** edits a project and requests builds or proposals within its
  granted scope.
- **Publisher** signs a release and attests to its source, build, and artifact.
- **Drive authority / installer** approves capabilities for a release on a
  drive.
- **Plugin agent** signs future trusted-runtime-originated Atomic mutations
  after activation; frontend-only applications do not receive or require one.
- **Verifier node** has plaintext access and a trusted runtime capable of
  building, previewing, or executing the release.

Transport identity, artifact possession, and state replication do not confer
execution authority. A synced installation record or raw artifact is inert
until the local node verifies the signed approval and opts into activation.

Capability approvals and revocations are authorization-critical evidence.
Commit retention and state-certificate work must preserve enough evidence to
validate the effective grant even when ordinary historical commits are pruned.

### Runtime capability matrix

Expose runtime availability instead of assuming every Atomic node can execute
every plugin:

| Node role | Store/sync metadata | Fetch artifact | Build JS/TS | Preview GUI | Execute GUI | Execute WASM |
| --- | --- | --- | --- | --- | --- | --- |
| Blind encrypted replica | Yes, opaque | Policy-controlled opaque bytes | No | No | No | No |
| Browser/local OPFS node | Yes | On demand | Yes | Yes | Yes | No initially |
| Native/server verifier | Yes | On demand | Yes when enabled | Yes | Yes | Yes |
| Native/mobile verifier | Yes | On demand | No initially | Possibly | Possibly | No initially |

Build, preview, AI inspection, query, and execution require a trusted verifier
with plaintext access. Granting verifier access to encrypted drive content is
an explicit confidentiality decision and cannot be undone by later revocation.

Plugin projects, releases, installation records, and capability grants should
sync through the transport-neutral Atomic protocol. Artifact and source-archive
bytes are metadata-first, fetched through normal blob policy on demand; their
arrival never activates code.

### Blobs, schemas, and limits

Store source archives, build artifacts, logs, and test bundles through the
`BlobBackend` content-addressed storage path and File resources. The browser
must not depend on a particular S3 or filesystem backend. Record BLAKE3 hashes
and immutable artifact identity in build and release resources so preview and
installation use exactly the reviewed bytes.

Generated plugins that define Atomic classes or properties must produce or
reference a DID-backed `SchemaBundle`. JSON Schema is the developer-facing
authoring and validation boundary; Atomic Class and Property resources remain
the runtime semantics. Schema registration is an explicit reviewed release
step, not a hidden side effect of loading application code.

Apply admission controls before accepting project mutations and build outputs,
not only when executing them. Limits include source file count and size,
artifact size, log and test-report size, build duration, CPU, memory, dependency
count, plugin runtime fuel, and plugin storage quota.

### First-party AI tools

Expose narrow tools to the LLM instead of shell access:

```text
create_plugin_project
read_plugin_project_file
write_plugin_project_file
list_plugin_project_files
build_plugin_project
run_plugin_tests
preview_plugin_build
propose_plugin_install
propose_plugin_update
```

`write_plugin_project_file`, build, test, and preview can be agent operations.
`propose_plugin_install` must produce a pending user action, not install code.
The final install/update operation is executed only after explicit confirmation
in trusted host UI.

### Builder boundary

Start with a browser JS/TS builder running in a dedicated worker. The builder
should:

1. Materialize a project into an isolated in-memory workspace.
2. Use a pinned template and SDK version.
3. Type-check and bundle the GUI to one `ui.js` and optional `ui.css`.
4. Run static validation and state-profile integration tests.
5. Package an immutable UI-only application release.
6. Return artifacts, logs, and provenance.

Do not expose npm, arbitrary build scripts, or dependency network access.
Provide a pinned dependency catalog cached with the application. A future
server/native builder can add optional WASM modules, but it is not on the
critical path for JS/TS applications or LLM generation.

The first supported generated-plugin stack should be deliberately narrow:

- TypeScript + a small DOM helper or SolidJS for GUI;
- browser-hosted pinned TypeScript/bundler toolchain;
- pinned dependencies only;
- no arbitrary build scripts;
- one UI entrypoint and declared state profiles.

The current package loader requires `plugin.wasm`; the JS/TS-first platform
must allow UI-only releases rather than generating a meaningless no-op WASM
component. Optional WASM modules can use a separate native builder and runtime
capability later.

### Unified capability manifest

Replace the flat permission list with explicit capabilities that can be mapped
to both runtime hosts:

```json
{
  "capabilities": {
    "atomic": {
      "read": [{ "scope": "page" }],
      "write": [{
        "scope": "page",
        "properties": ["https://example.com/properties/description"]
      }],
      "query": [],
      "subscribe": [{ "scope": "page" }]
    },
    "documents": {
      "loro": [{ "scope": "page-payload", "mode": "readwrite" }],
      "blobs": [{ "scope": "page", "mode": "checkpoint" }]
    },
    "network": {
      "origins": []
    },
    "storage": {
      "quotaBytes": 1048576
    },
    "runtime": {
      "fuel": "standard",
      "memory": "standard"
    },
    "ui": {
      "slots": ["resource-page"]
    }
  }
}
```

Installed grants should be recorded against:

```text
(drive subject, Plugin resource subject, artifact hash, capability)
```

The host derives:

- Wasmtime linker features and limits;
- plugin-agent Atomic rights;
- iframe CSP;
- allowed frontend RPC methods and scopes;
- preview behavior.

For document capabilities, grants identify the metadata resource and its
dedicated payload or checkpoint stream. A plugin granted `loro-document`
access cannot submit updates to the metadata resource. A plugin granted
`blob-checkpoints` access can create blobs and checkpoint revisions but cannot
change rights, parent, class, or arbitrary properties.

The grant and its revocation status are signed Atomic authorization state.
Frontend local storage can cache a decision for UX, but cannot be the source of
authority. Subjects crossing RPC and capability boundaries must be validated
and represented with the branded `Subject` type rather than arbitrary strings.

### GUI runtime direction

Keep the iframe boundary. It is the strongest part of the current frontend
design and is suitable for generated code.

Change the host protocol:

- Version every RPC request and capability.
- Validate message shapes at runtime.
- Generate an unguessable per-frame channel token.
- Scope grants to installed artifact identity.
- Implement capability checks centrally, not separately in each handler.
- Add structured query/search/mutate APIs only when their authorization
  semantics are defined.
- Generate CSP from granted network and asset capabilities.
- Serve immutable UI files by artifact hash with strong cache headers.
- Support package assets through a read-only `plugin-asset:`/host URL mapping.
- Add explicit view slots and deterministic selection.
- Route discovery, installation status, and runtime availability through
  `AtomicNode` services/events and normal authorized subscriptions instead of
  relying on a bespoke `/plugin-list` refresh.
- Build plugin administration and status UI on reactive resource hooks rather
  than direct `resource.props` reads, so React Compiler cannot make it stale.

For preview, render the uninstalled build in the same iframe host with a
restricted preview capability set and a visible "Preview" frame. Do not relax
the sandbox for development convenience.

## Delivery Plan

### Phase 0: Fix and specify the existing frontend boundary

- [ ] Replace `pluginFile`-change auto-execution with an explicit trusted
  install/activate command. Ordinary writes and synced artifacts must be inert.
- [ ] Add unit tests for `RPCServer` authorization, commits, subscriptions, and
  plugin-resource protection.
- [ ] Implement runtime validation and versioning for RPC messages.
- [ ] Key GUI grants by drive + Plugin subject + artifact/package hash.
- [ ] Make iframe CSP derive from manifest capabilities; default network to
  none.
- [ ] Reconcile docs and implementation for query, search, push, and assets.
- [ ] Define deterministic custom-view selection and multiple-class behavior.
- [ ] Audit `/plugin-ui` and `/plugin-list` authorization and path safety.
- [ ] Use the unified authorized subscription primitive for plugin RPC
  subscriptions.
- [ ] Surface runtime capability and activation status in the frontend.
- [ ] Deprecate unrestricted frontend `commit()` in favor of scoped property
  mutations and exact-diff confirmation.

### Phase 1: Embedded application state APIs

- [ ] Define the application metadata resource and isolated Loro payload
  document protocol.
- [ ] Add `openLoroDocument` with host-mediated sync, persistence,
  authorization, signing, presence, and quotas.
- [ ] Define immutable blob checkpoints, expected-head updates, and conflict
  preservation.
- [ ] Add `openBlobDocument`, local blob persistence, on-demand transfer, and
  checkpoint history.
- [ ] Build reference integrations for an IronCalc-like collaborative document
  and a photo-editor-like opaque checkpoint document.

### Phase 2: Reproducible builder and project format

- [ ] Add a pinned first-party plugin template.
- [ ] Define `PluginProject`, `PluginBuild`, `PluginRelease`,
  `InstalledPlugin`, approval, and provenance schemas.
- [ ] Implement isolated browser-worker build/test/package service.
- [ ] Update the package format and loader to support UI-only application
  releases without `plugin.wasm`.
- [ ] Add an install-time artifact hash to Plugin metadata.
- [ ] Store source archives, artifacts, logs, and reports through `BlobBackend`.
- [ ] Add signed release publication and drive installation approval.
- [ ] Define SchemaBundle packaging and explicit schema registration.

### Phase 3: Trusted preview and manual project UI

- [ ] Add source editor/project files UI.
- [ ] Add build log and test report UI.
- [ ] Add restricted artifact preview using the production iframe runtime.
- [ ] Add install/update review showing permissions and artifact/source diffs.
- [ ] Make artifact transfer on demand and show size before fetching.
- [ ] Keep preview and execution unavailable on blind encrypted replicas.

### Phase 4: LLM tools

- [ ] Add project file read/write tools.
- [ ] Add build/test/preview tools.
- [ ] Add `propose_plugin_install` and `propose_plugin_update`.
- [ ] Add a plugin-authoring skill with the supported ABI, SDK, and GUI rules.
- [ ] Require user confirmation for every install/update proposal.
- [ ] Ensure LLM tools can propose publication/installation but cannot activate
  a release or write reserved activation state.

### Phase 5: Portable runtime

- [ ] Move plugin execution behind an optional `AtomicNode` plugin-runtime
  interface.
- [ ] Decide native/mobile/browser execution support per capability and for
  optional WASM runtime modules.
- [ ] Keep storage/sync of plugin projects and releases available even where
  execution is unsupported.
- [ ] Move discovery and status from bespoke HTTP refreshes to `AtomicNode`
  services/events and transport-neutral subscriptions.

## First Vertical Slice

Build one narrow workflow:

> Install a JS/TS application view that opens a dedicated Loro payload document,
> displays and edits a small shared table, and collaborates between two browser
> contexts.

Constraints:

- JS/TS-only behavior; no WASM requirement.
- Fixed TypeScript/Solid template and pinned `@tomic/plugin`.
- No external dependencies or network capability.
- The application can mutate only its dedicated payload Loro document.
- Atomic metadata, rights, parent, and class remain inaccessible to payload
  updates.
- Host-mediated signed updates, offline persistence, presence, and real-time
  sync work without exposing the user secret.
- Builder bundles and tests the project.
- User previews the exact artifact.
- User explicitly approves installation for the drive.
- The current trusted verifier node explicitly activates the approved release;
  other synced nodes remain inactive until their own policy allows it.

The second vertical slice saves and restores opaque photo-editor checkpoints,
including an intentional concurrent-head conflict. Together they validate the
two primary application-state profiles without first exposing arbitrary
Cargo/npm execution, unrestricted commits, or expanding the server-side ABI.

## Decisions

- Keep custom GUI code in a sandboxed iframe.
- Start with JS/TS-only embedded applications; WASM is not required for the
  first plugin platform.
- Do not give the LLM shell access or direct install privileges.
- Treat build and install as separate capability boundaries.
- Start with a constrained, pinned toolchain and dependency catalog.
- Make artifacts immutable and grants artifact-specific.
- Replace the current WASM-required zip with a release format that supports
  UI-only applications and optional runtime modules.
- Keep plugin support optional in `AtomicNode`.
- Treat artifact arrival, installation approval, and node activation as
  separate events; sync never triggers execution.
- Use normal Loro/outbox writes for project state and signed,
  authorization-critical records for capability approval and revocation.
- Store large plugin bytes through `BlobBackend` and fetch them on demand.
- Run build, preview, AI inspection, and execution only on trusted verifier
  nodes with plaintext access.
- Support both application-owned Loro payload documents and opaque blob
  checkpoints without forcing either into Atomic property-shaped state.
- Sign frontend state-profile operations as the user with application-release
  provenance; never expose a plugin-agent secret to frontend code.

## Open Questions

- If WASM modules are added later, should a release contain independently
  versioned UI and runtime modules?
- Should LLM-generated plugins initially be private drive-local artifacts, or
  can they be published and reused?
- Which pinned dependency catalog is acceptable for browser-built
  applications?
- Should plugins expose callable commands/tools in addition to class lifecycle
  hooks?
- Which concrete use case justifies adding an optional WASM runtime module
  after the JS/TS application-state APIs ship?
