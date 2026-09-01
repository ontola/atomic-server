# Automated Importers: Getting Existing Data Into Atomic

## Status

Analysis / proposal (2026-07-13). Not started.

## Goal

Make "get my existing data into Atomic" a non-developer task. Today the answer
is "convert it to JSON-AD yourself": no importer tools, no integrations. The
merits that make people *want* Atomic data — URL-strict schemas, browseability,
authorization, search, format conversion — only pay off after the data is in.

The core idea under analysis: let an LLM write the import code, with a real
feedback loop (run, fail, fix), so the long tail of formats and sources doesn't
require us — or the user — to be developers.

## Framing: Three Different Jobs

Import requests hide three distinct problems that need different machinery:

1. **Small one-shot imports** ("here are my 30 contacts as a CSV"). No code
   should be involved at all — see "Level 0" below.
2. **Large or messy one-shot imports** (Notion export, Google Takeout, a
   decade of bookmarks, a 50k-row Excel with merged cells). This is where
   LLM-generated transform code earns its keep: too big for direct tool calls
   (token cost), needs determinism and re-runnability.
3. **Continuous sync** (live APIs, OAuth, cursors, two-way). This is the
   connector architecture in
   [`personal-information-suite.md`](./personal-information-suite.md) and
   needs durable scheduled jobs, secret storage, and conflict handling. An
   LLM-written importer can be *promoted* into a connector (see below), but
   the big providers (Google, Microsoft) deserve first-party connectors
   regardless — those are products, not generated artifacts.

Webhook ingestion (#976) and easy write APIs
([`SDK-API-design.md`](./SDK-API-design.md),
[`ecosystem-integrations.md`](./ecosystem-integrations.md)) are complementary
push-side answers for systems that can call us. Importers are the pull side.

## Key Architectural Claim: the LLM Writes Only the Mapping

The mistake to avoid is treating "the importer" as one generated program that
fetches, parses, transforms, and writes. Decompose the pipeline and it becomes
clear that generated code is only needed in the middle:

```text
acquire  -> parse       -> map/transform      -> validate  -> preview  -> commit
(host)      (host,         (LLM-generated,       (host,       (host UI)   (host,
 upload/     first-party    pure function)        schema       user        provenance,
 fetch/      parsers for                          oracle)      approves)   idempotent)
 OAuth)      CSV/XLSX/JSON/
             ICS/VCF/HTML/
             mbox/zip)
```

- **Acquire** is host code: file upload, URL fetch, or a credentialed API
  call. Secrets and network access never enter generated code.
- **Parse** should be first-party and deterministic for the container formats
  that cover most real imports (CSV, Excel, JSON, ICS, VCF, bookmarks HTML,
  mbox, zip trees). The LLM must not re-derive a CSV parser per import; it
  receives already-parsed records.
- **Transform** is the generated artifact: a pure function
  `(records, context) -> JSON-AD resources`. No I/O, no store access, no
  network, no clock. Bytes-in/JSON-out.
- **Validate / preview / commit** are host code again: schema validation,
  a human-readable diff ("2,140 Bookmarks, 12 rows skipped: bad dates"),
  explicit approval, provenance-stamped idempotent writes.

This shrinks the sandbox problem from "run an untrusted ETL program" to "run
an untrusted pure function", and it shrinks the generated code from an ETL
pipeline to a mapping — fewer tokens, tighter feedback loop, smaller failure
surface.

### Level 0: no code at all

For small data, the assistant should import *directly* with its existing
tools: `get_user_classes`/`get_schema` for the target model,
`create_resource` in the compact dialect
([`json-ad-compact.md`](./json-ad-compact.md)) for the rows. Paste 30
contacts, get 30 resources. Rule of thumb: below ~100 records, direct tool
calls; above that, generate a transform. Level 0 ships value with zero new
infrastructure and is also how the feedback loop gets bootstrapped — the
assistant learns the target shape by doing a sample by hand first.

## Trusted Importers as Skills

Decision (2026-07-14): before any client-publishing story, Ontola authors,
validates, and tests first-party importers and distributes them as **skills**.
This flips the bootstrap order — the trusted artifacts establish the shape
that client-created importers later inherit, instead of building review
machinery for strangers' code first. Skills already exist in the assistant
(`read_skill`/`create_skill`); distribution is just resources in an
Ontola-published catalog drive.

The skill is the packaging and orchestration layer; a pinned transform is the
execution payload inside it. A skill whose endpoint is "the assistant maps
records via tool calls" would just be Level 0 with better documentation:
token cost per import, no determinism, and nothing concrete for "validated
and tested" to refer to.

```text
ImporterSkill
  instructions      how to run the flow, known pitfalls, mapping judgment
                    (e.g. Notion: databases → tables, pages → documents,
                     select columns → tags, relation columns → links)
  transformSource   the tested pure transform, pinned by content hash
  fixtures          sample inputs + expected JSON-AD outputs
  targetOntology    classes it maps into
  version, publisher signature
```

Semantics:

- **Deterministic by default.** "Import my Notion export" runs the standard
  pipeline with the embedded transform — no LLM in the data path, exactly
  what was tested. The LLM writes code only when the user's data *deviates*;
  the adapted transform goes through the same validate/preview loop.
- **Fixtures make trust verifiable, not claimed.** Any node can re-run
  `transform(fixture) === expected` locally before trusting a skill. Trust
  travels with the artifact — essential once the same format carries
  community importers.
- **One artifact shape across the lifecycle.** A client-created importer is
  an unverified instance of the same skill: generated for an unseen source,
  proven on the user's data, published, and *promoted* to trusted by review
  of transform + fixtures. Promotion to a scheduled server-side connector
  compiles the same transform.
- **Provenance is a signature.** "Verified by Ontola" must be a publisher
  signature on the skill, not a string in its body — skills are
  instruction-level supply chain, and third-party ones arrive eventually.

## Runtime Analysis

Where does the generated transform run? Assessment of the candidates:

| Option | LLM fluency | Payload | Sandbox | Data-wrangling libs | Verdict |
| --- | --- | --- | --- | --- | --- |
| Cloud container (Gemini/Codex-style) | best | n/a | fine (theirs) | everything | **Reject as default.** Ships user data to a third party, costs money, needs an account — and contradicts the self-hosted no-phone-home stance. Acceptable later as an opt-in accelerator for hosted SaaS, never the base layer. |
| Plain JS in the page | high | 0 | none | npm (unpinned) | **Reject as stated**, but the premise "no way to sandbox JS" is too pessimistic — see below. |
| **JS/TS in an isolated worker or QuickJS-in-WASM** | high | ~1–2 MB | strong | pinned catalog | **Recommended first runtime.** |
| Pyodide (Python in WASM) | high | ~15–60 MB lazy, cacheable | good (WASM) | pandas/openpyxl — the best there is | **Recommended second runtime** for heavy/messy tabular data. |
| AssemblyScript | low | small | good | ~none | **Reject.** Thin ecosystem, LLMs are mediocre at it, and the module-vs-component mismatch the issue notes is real friction for zero payoff. |
| MoonBit | low today | small | good | young | **Watch, don't bet.** Promising design, but importer UX shouldn't depend on a young language and package registry. Revisit in a year. |
| JupyterLite | — | huge | — | — | **Reject.** It's a notebook GUI around the Pyodide kernel; we want the kernel, and we already have our own GUI. |

### On sandboxing JS

Browser JS *can* be sandboxed well enough for a pure transform, and we already
own most of the machinery:

- The **null-origin sandboxed iframe** built for plugin views
  ([`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md)) already isolates
  untrusted JS from DOM, storage, and cookies, with CSP-controlled network.
  A transform iframe gets `connect-src 'none'`.
- A **dedicated Web Worker** adds CPU containment: runaway loops are killed by
  `terminate()` after a time budget.
- For defense in depth, **QuickJS compiled to WASM** (the Figma-plugins
  approach) runs the transform inside an interpreter with a memory cap, no
  ambient globals, and deterministic behavior — at a ~1–2 MB payload instead
  of Pyodide's tens of MB.

Since the transform has no authority to abuse (no network, no store, no
secrets — the host holds all of those), even the iframe/worker tier is
adequate to start; QuickJS is an upgrade path, not a prerequisite.

### Why JS/TS first, Python second

- The plugin platform is already committed to a **pinned browser-hosted
  TypeScript toolchain** (builder boundary in `llm-wasm-gui-plugins.md`).
  Importer transforms reuse that builder, its pinned dependency catalog, and
  its worker isolation — one toolchain to secure, not two.
- Typed transforms compose with generated ontologies: the builder can
  typecheck the mapping against the target classes
  ([`json-schema-code-first.md`](./json-schema-code-first.md)), turning a
  whole class of LLM mistakes into compile errors *before* the run — the
  cheapest feedback in the loop.
- Pyodide earns its 15–60 MB exactly once the input is a gnarly Excel file or
  needs real dataframe surgery. Load it lazily, cache it, and keep the same
  contract: parsed records in, JSON-AD out. It is an alternative engine
  behind the same pipeline, not a different architecture.

## The Feedback Loop

The strict schema is the piece the user's framing undersells: Atomic classes
and datatypes are a **machine-checkable test oracle** for generated code. The
loop:

1. Host parses the source and hands the LLM a *sample* (first N records +
   inferred column stats), never the full data.
2. LLM proposes target mapping: reuse existing classes where possible, define
   new ones code-first for the residue (see "Schema mapping" below).
3. LLM writes the transform; builder typechecks it against the target
   ontology.
4. Host runs it on the sample; validation (`lib/src/validate.rs` semantics:
   datatypes, required properties, classtype of links) produces structured
   errors that go straight back to the LLM. Iterate until clean.
5. Host runs the full input, streams validation stats, and renders a preview:
   per-class counts, sample rendered resources, skipped-row report.
6. **User approves. Nothing is committed before this point.**
7. Host commits with provenance (below). The transform source and its content
   hash are stored with the run, so the import is reproducible and auditable.

Steps 1–5 are safe to run fully autonomously; the approval gate is the only
mandatory human step.

## Provenance and Idempotency

Imports must be re-runnable (source file updated, mapping improved) and
undoable. Model:

```text
Importer
  name, sourceFormat, transformSource, transformHash, targetOntology

ImportRun
  importer, startedAt, sourceBlob (original bytes), stats, status

imported resources
  parent: a folder under the ImportRun (or a user-chosen destination)
  externalId: stable ID from the source (row key, provider ID, filename+line)
```

- **Idempotency**: derive resource identity from `(importer, externalId)` so a
  re-run updates instead of duplicating. Records without a natural key fall
  back to content hash, with duplicates surfaced in the preview.
- **Undo**: an import is a subtree; destroying the run's folder removes it.
  Imports never mutate pre-existing resources without showing that as an
  explicit, separately-approved diff.
- **Audit**: original bytes kept as a blob, transform kept by hash — the trio
  (bytes, code, output) makes any import explainable after the fact.

## Schema Mapping: Reuse First

Generic ETL maps into private tables. Atomic's differentiator is mapping into
*shared* semantics — that's where browseability and interop come from. The
mapping step should therefore be biased hard toward reuse:

1. Search existing classes/properties first — `get_user_classes` plus vector
   search (#539/#1007, `server/src/vector_search/`) over class and property
   descriptions ("this column looks like `dueDate` on `Task`").
2. Only define new schema for the residue, via code-first `defineSchema`, so
   the new classes land in the drive as normal signed resources the assistant
   can rediscover later.
3. Prefer linking over copying: an imported contact's employer should become a
   link to an `Organization` resource (created or found), not a string.

## Security Analysis

The transform sandbox is the *easy* part. The real risks:

- **SSRF via acquisition.** "Import from URL" executed by the server can reach
  internal networks and metadata endpoints. URL fetches need an explicit user
  confirmation showing the resolved target, plus the usual private-range
  blocking. Browser-side fetch is naturally CORS-constrained but leaks the
  user's IP/cookies context — prefer host-side fetch with guards.
- **Secrets.** OAuth tokens and API keys are held by the host acquisition
  layer only. They never appear in LLM context, generated code, prompts, or
  logs. A generated transform that "needs" a credential is a design error —
  restructure so the host fetches and the transform maps.
- **Prompt injection via imported data.** Sample records shown to the LLM are
  attacker-controlled content (a CSV cell can contain instructions). The
  containment is structural, not model-level: the transform can't reach the
  network or the store, the LLM's write path is the same preview/approval
  gate as everything else, and imported *content* is never treated as
  instructions by the host. This is the same trust boundary the assistant
  already needs for reading any drive data, but imports make it acute.
- **Blast radius.** All writes land under an ImportRun subtree with one
  approval; mass-undo is one destroy. No importer ever gets drive-wide write
  scope.

## Promotion Path: Importer → Connector

A proven one-shot transform can graduate to a scheduled connector without a
rewrite:

- Compile the same JS/TS transform to a WASI component (`componentize-js`) —
  or Python via `componentize-py` — and run it in the existing server-side
  Wasmtime runtime (#1130), on a schedule, with host-provided fetch scoped to
  a manifest-declared origin allowlist and host-held credentials.
- Packaging, capability review, installation, and provenance reuse the
  `PluginRelease` / `InstalledPlugin` lifecycle from
  [`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md) — an importer is a
  plugin with a `transform` entry point instead of (or beside) `ui.js`, plus
  `schedule` and `network.origins` capabilities.
- This also gives `personal-information-suite.md` its long-tail connector
  story (niche providers, internal company APIs) while first-party connectors
  cover the big ones. The runtime primitives it lists (job scheduler, cursor
  state, secret storage) are the dependency here too.

This ordering keeps the LLM feedback loop where it's cheap (browser, no
compile step for iteration) and moves code server-side only after it's frozen,
reviewed, and approved — consistent with "sync never activates code".

## Build Plan

Ordered by dependency; each milestone is independently shippable.

### M1: Chat ingestion + Level 0

- File upload into the assistant chat, landing as a blob/handle that tools
  can reference without dumping bytes into context.
- First-party parser tools: zip tree, CSV (type inference + column stats),
  JSON, Markdown/HTML. `sample_records` returns a stratified sample + stats,
  never the full file.
- Level 0 flow: map conversationally, create resources with existing tools
  (`create_table` already handles dynamic classes/properties for tabular
  data), everything under one parent for undo.

### M2: Deterministic transform pipeline

- **Runtime**: pure transform `(records, context) -> resources[]` executed in
  a worker inside a null-origin iframe with `connect-src 'none'` (the iframe
  CSP covers its workers — this is how "no network" is actually enforced),
  time budget via `terminate()`, source pinned by content hash. Contract
  types published as a small `@tomic/importer` package.
- **Validation**: TS batch validator matching `lib/src/validate.rs` semantics
  (datatype, required, classtype), producing structured per-record errors
  that feed back to the LLM. Measure iterations-to-clean on real messy files.
- **Preview + commit**: per-class counts, sample rendered resources (reuse
  existing card views), skipped-row report, destination picker, approval
  gate; batched resumable commit; `Importer`/`ImportRun` provenance ontology
  with `externalId`. Measure ClientDb bulk-write throughput here — it decides
  whether commits need chunking.

### M3: Importer skills + the Notion importer

- `ImporterSkill` class (extending the existing skill resource): transform
  source + hash, fixtures, target ontology, version, publisher signature.
- Fixture runner: host verifies `transform(fixture) === expected` before
  first use; result shown in the import UI.
- Signed Ontola catalog drive + discovery (assistant finds the right skill by
  source format / description search) and update flow.
- **Notion export-zip importer as the first trusted skill** — the forcing
  function for M1–M3: databases → tables, pages → documents, nesting →
  folders, files → File resources. Ontola QA = a fixture corpus from real
  exports plus a review checklist. Export-zip first; the API/token route is
  deferred (below).

### M4: Breadth + re-run

- More parsers: ICS/VCF/mbox/bookmarks HTML (overlaps
  `personal-information-suite.md` Milestone 2 — same parsers, shared).
- Vector-search-assisted class/property matching; code-first schema for the
  residue.
- Idempotent re-import via `externalId`; diff preview for updates to
  previously imported resources.

### M5: Client-created importers + promotion

- Assistant authors a *new* ImporterSkill for an unseen source (same artifact,
  unverified), user proves it on their data, publishes it; review promotes it
  to trusted. Needs the store/gallery and the plugin-platform release
  machinery ([`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md) Phases
  2–3).
- Promotion to scheduled server-side connectors: componentize + Wasmtime
  (#1130), schedule + origin-allowlist capabilities. Gated on AtomicNode job
  primitives.

### Deferred / unowned prerequisites

- **API/token importers** (Notion API, etc.) need secret storage and
  host-side credentialed fetch with an origin allowlist — listed as runtime
  needs in `personal-information-suite.md` but currently designed nowhere.
  Notion's API sends no CORS headers, so browser-side fetch is not an option;
  internal integration tokens (paste-a-token) beat OAuth brokerage for v1.
- Pyodide engine behind the same transform contract, lazy-loaded.
- Opt-in cloud execution tier for hosted customers.

## Decisions

- The LLM generates the mapping only; acquisition, parsing, validation,
  preview, and commit are host code. Transforms are pure functions with no
  I/O.
- Ontola-authored **trusted importer skills** come before any client
  publishing: skill = instructions + hash-pinned transform + verifiable
  fixtures + publisher signature. Deterministic by default; the LLM only
  adapts the transform when data deviates.
- JS/TS is the first transform runtime (pinned plugin-builder toolchain,
  worker/iframe isolation, QuickJS-in-WASM as hardening path). Pyodide is a
  second engine for heavy tabular work, not the foundation.
- No cloud execution by default; self-hosted imports never leave the node.
- Every import is gated on a human-approved preview and lands as a
  provenance-stamped, undoable subtree.
- Secrets never enter LLM context or generated code.
- AssemblyScript and MoonBit: not now. JupyterLite: no.

## Open Questions

- Sample selection for the LLM: first-N is often unrepresentative (headers,
  footers, mixed types deep in the file). Column-stats + stratified sampling,
  and how much of that the host computes vs. the LLM requests.
- How large can browser-side full runs get (500 MB Takeout zips) before we
  need streaming transforms or chunked commit batches — and what the ClientDb
  write-throughput ceiling is for bulk import.
- Where do reusable importers live once written — private per-drive, or a
  shareable gallery with the same provenance/review rules as plugin releases?
- PDF/image/audio sources ("import my receipts"): that's extraction, not
  mapping — LLM-per-record rather than code-per-source. Different cost model;
  out of scope here but the pipeline should not preclude it.
- Does Level 0 need write batching in the assistant tools (one commit per
  resource today) to keep 100-record imports fast and atomic?
