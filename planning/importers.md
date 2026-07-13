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
([`SDK-API-design.md`](./SDK-API-design.md)) are complementary push-side
answers for systems that can call us. Importers are the pull side.

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

## Milestones

### M1: Level 0 assistant import

- Assistant skill + flow: paste/upload small data, map conversationally,
  create resources with existing tools, under one parent for undo.
- First-party parsers exposed as assistant tools: CSV/JSON sampling with
  column stats.

### M2: Transform pipeline (one format, end to end)

- CSV/Excel → transform (TS, plugin-builder toolchain, worker-isolated) →
  validate → preview/approve → commit with Importer/ImportRun provenance.
- Structured validation errors fed back to the LLM; measure iterations-to-
  clean on a corpus of real messy files.

### M3: Format breadth + reuse-biased mapping

- ICS/VCF/mbox/bookmarks/Notion-export/zip parsers (overlaps
  `personal-information-suite.md` Milestone 2 — same parsers, shared).
- Vector-search-assisted property/class matching; code-first schema for
  residue.

### M4: Re-run, update, dedup

- Idempotent re-import via externalId; diff preview for updates; scheduled
  re-fetch *in the browser* (no server execution yet).

### M5: Promotion to server-side connectors

- componentize + Wasmtime execution, schedule + origin-allowlist
  capabilities, release/install lifecycle. Gated on the plugin-platform
  phases and the AtomicNode job primitives.

### Later / optional

- Pyodide engine behind the same contract, lazy-loaded.
- Opt-in cloud execution tier for hosted customers.

## Decisions

- The LLM generates the mapping only; acquisition, parsing, validation,
  preview, and commit are host code. Transforms are pure functions with no
  I/O.
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
