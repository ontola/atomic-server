# Public docs refresh (0.41 local-first)

> **Status:** Draft in progress (2026-08-04). Audit of what the public docs
> must catch up on after the local-first / DID / sync / CMS / presence work.
> Product docs live in `docs/`; this file tracks the gap analysis and the
> drafting checklist.

The public docs are uneven. Spec/protocol pages that rode the rewrite
(`websockets.md`, `commits/concepts.md`, much of `did.md`,
`schema/translations.md`) are largely current. **Product-facing and GUI docs
are the weak spot**: tables, CMS, presence, pairing, and local-first UX are
thin, empty, or absent from the TOC, while overview pages still claim Mainline
DHT resolution and leave WIP banners on shipped identity.

## What shipped (docs must reflect)

| Area | Shipped reality | Docs before this refresh |
| --- | --- | --- |
| Local-first | Browser WASM + OPFS (per-agent encrypted), Flutter via `atomic_lib`, offline edits + outbox | Feature bullet only; no architecture page; Store docs still server-URL-centric |
| Sync protocol | Binary WS v2 + Iroh QUIC; QR/pairing codes; server = always-on peer | Solid wire ref (`websockets.md`); no user-facing sync/pairing guide |
| `did:ad` | Production identity for agents, resources, commits, blobs, nodes | Full page but `_status: work in progress_`; discovery narrative overclaims Mainline DHT / Reticulum |
| Tables | Views (table/kanban/calendar/timer), filters, templates, computed columns, aggregates, row actions, LocalizedText columns | ~30-line page: sort/copy/CSV only |
| i18n | `LocalizedText` shipped; document-level model documented; full Translate UX partial | Spec page good; GUI support not spelled out |
| CMS | Website templates, Drafts (location), Forks (`originalSubject` + merge) | Stub `headless-cms.md`; usecase page is 2021 marketing; `commits/suggestions.md` is obsolete HTTP Inbox design |
| Presence | Drive presence, cursors, follow-me, meetings, table cell rings, facepile | Almost undocumented; EPHEMERAL tag only |

Discovery **today**: pkarr announce + Iroh (`discovery_n0` / local network).
Reticulum is proposal-only. Marketing copy that says "resolve over Mainline DHT"
should say peer discovery (pkarr) + sync (Iroh / WS).

## Checklist

### New / rewritten pages

- [x] `atomicserver/gui/tables.md` — full feature guide
- [x] `atomicserver/cms.md` — Website, drafts, forks, publishing, i18n
- [x] `atomicserver/gui/presence.md` — presence, follow-me, meetings
- [x] `atomicserver/local-first.md` — OPFS/WASM, encryption, offline
- [x] `atomicserver/gui/sync-and-pairing.md` — QR, devices, cloud
- [x] `commits/suggestions.md` → Forks (shipped model)

### Corrections

- [x] `did.md` — remove WIP banner; split identity (shipped) vs discovery transports
- [x] `commits/intro.md` — drop "prone to change" disclaimer
- [x] `atomic-server.md` / `roadmap.md` — Mainline DHT overclaim
- [x] `SUMMARY.md` + `extended-table.md` — surface new pages
- [x] `atomic-data-overview.md` / `get-started.md` — monorepo links, local-first blurb
- [x] `usecases/headless-cms.md` — binary size, drafts/forks, link to CMS page
- [x] `authentication.md` — `did:ad:agent:` example
- [x] `atomicserver/when-to-use.md` — aggregates exist on tables
- [x] `atomicserver/gui.md` — passkeys / recovery; link new GUI pages
- [x] `schema/translations.md` — GUI support subsection
- [x] sled → redb leftovers (`plugins.md`, `interoperability/sql.md`)
- [x] Delete or replace empty `headless-cms.md` stub

### Deferred (follow-ups)

- [ ] `@tomic/lib` Store docs for ClientDb / DID subjects
- [ ] `@tomic/react` presence hooks (`useDrivePresence`, `useResourcePresence`)
- [ ] Broader `atomic-data-browser` → monorepo link sweep across usecases
- [ ] Document-level Translate action / TranslationsBar when that UX ships

## Priority rationale

Highest leverage for readers: Tables rewrite, CMS + Presence + Sync +
Local-first pages, then factual fixes (DID status, discovery, sled, aggregates).
Wire protocol docs stay as the reference; product pages link into them.
