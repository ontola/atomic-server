# Atomic URIs: drop `did:`, own `atomic:`

**Status: Proposal (2026-08-12).** Direction from the zones / DID-open /
share-link consolidation discussion. Not implemented yet.

Atomic’s `did:ad:` identifiers are a **proprietary URI scheme that borrowed
DID vocabulary**. We do not implement [DID Core](https://www.w3.org/TR/did-core/)
(no DID Documents, no standard DID resolution, no method registry process).
Trust is Commits + agents; discovery is pkarr / Iroh / HTTP / known peers.
Staying in beta is the right time to rename before `did:ad:` hardens as the
stable public spelling.

Related: [`zones.md`](./zones.md) (share = subject + routing hints),
[`device-pairing.md`](./device-pairing.md) and
[`pairing-ux-field-test.md`](./pairing-ux-field-test.md) (today emit
`atomic://pair` + `did:ad:node:` — rewrite to `atomic:pair` /
`atomic:node:` under this plan),
[`node-did-canonicalization.md`](./node-did-canonicalization.md) (**Landed**
as `did:ad:node:<hex>`; this plan supersedes the *prefix* only),
[`subject-types-end-to-end.md`](./subject-types-end-to-end.md) (Rust `DidKind`
/ TS brand types — rename when the scheme flips).

## Decision (proposed)

1. **Canonical identity scheme is `atomic:`** (opaque; **no `//`**).
2. **`did:ad:` remains a read alias** for a migration window (dual-parse
   everywhere subjects enter the system). New writes and Copy link emit
   `atomic:` only.
3. **Stop claiming a W3C DID method** in docs and marketing; describe
   *Atomic URIs* (content-addressed / key-derived identifiers).
4. **HTTPS stays a carrier**, not a second identity: clickable web entry wraps
   a canonical `atomic:` subject (+ hints). Invites remain a separate verb.

## Why drop `did`

| Keep (substance) | Drop (costume) |
|---|---|
| Genesis / agent key / node hex / blob hash as identity | `did:` prefix and DID-method framing |
| Commit signatures as trust | DID Documents / DID controllers / universal resolvers |
| Agent → pkarr → NodeID discovery | “We implement the DID spec” |

Costs of keeping `did:ad:` while not implementing DID Core: confusing docs,
can’t register bare `did:` on desktop/iOS (claims every method), and a share
surface split across `did:ad:`, `https://…/app/show`, and `atomic://…`.

## Canonical grammar

Opaque URIs, one scheme, type prefixes where needed. No network authority;
therefore **no `://`**.

```text
atomic:{genesis}                         # resource / zone / drive (genesis sig, base64url)
atomic:agent:{publicKey}                 # Ed25519 pubkey, base64url
atomic:node:{nodeId}                     # 64 hex (Iroh NodeID); transport-internal hex OK
atomic:commit:{signature}                # commit id
atomic:blob:{blake3}                     # 64 hex blake3

atomic:open?subject=…&agent=…&node=…     # open / resolve a resource (OS + paste)
atomic:pair?v=1&node=…&drives=*          # device pairing envelope
```

### Query hints (discovery only; not identity)

Allowed on resource subjects and on `atomic:open`:

| Param | Meaning |
|---|---|
| `agent` | Agent URI → pkarr → NodeID(s) |
| `node` | Direct dial (`atomic:node:…` only) |
| `drive` | **Legacy** sync/routing scope; prefer zone subject + agent/node |

Hints are stripped for storage / equality (`pure_id`); same rule as today’s
`canonicalizeOpenSubject`.

### Encoding

Unchanged from `docs/src/did.md`: URL-safe unpadded base64 for keys and
signatures; hex for blob hashes and node IDs. Identifiers must survive being
placed in query strings without further escaping of the identifier body.

### Rejected spellings (do not produce)

- `atomic://…` — false authority; accept as alias → normalize to `atomic:…`
- `did:ad:…` — accept as alias → normalize to `atomic:…` on ingest when writing
  new links (stores may keep historical strings until a migration pass)
- `iroh:{hex}` as user-facing node id — already rejected
  ([`node-did-canonicalization.md`](./node-did-canonicalization.md))
- Bare HTTP origins as `node=` — node means Iroh NodeID; HTTP fetch is a
  different path (External subject / server origin)

## Alias map (`did:ad:` → `atomic:`)

Lossless string rewrite of the scheme + method prefix:

| Old | New |
|---|---|
| `did:ad:{genesis}` | `atomic:{genesis}` |
| `did:ad:agent:{pk}` | `atomic:agent:{pk}` |
| `did:ad:node:{hex}` | `atomic:node:{hex}` |
| `did:ad:commit:{sig}` | `atomic:commit:{sig}` |
| `did:ad:blob:{hex}` | `atomic:blob:{hex}` |
| `did:ad:…?agent=did:ad:agent:…&node=did:ad:node:…` | rewrite each URI-shaped value |
| `atomic://open?…` | `atomic:open?…` |
| `atomic://pair?…` | `atomic:pair?…` |

Implement as one shared normalizer in Rust (`Subject` parse) and TypeScript
(`@tomic/lib` / data-browser helpers), used at every ingress: HTTP, WS, Iroh,
clipboard, deep link, search paste.

**Equality:** after normalization, `atomic:X` and `did:ad:X` are the same
subject. Prefer storing the canonical `atomic:` form on new saves; do not
rewrite historical Loro/commit bytes in place without an explicit migration.

## What Copy link emits

One product rule (share consolidation from the zones discussion):

> **Produce one link shape.** Accept many on the way in.

| Surface | Emit |
|---|---|
| **Copy link** (Share dialog / Share route) | Prefer **`atomic:{subject}?agent=…&node=…`** when the clipboard consumer is an Atomic client context; for generic web share, emit **HTTPS wrapper** (below). Start with **HTTPS wrapper always** if we need one clipboard behavior everywhere — see options. |
| **HTTPS wrapper** (web-clickable) | `{appOrigin}/app/show?subject={atomic:…}&agent={atomic:agent:…}&node={atomic:node:…}` — subject and hints already canonical. No parallel `atomic:open` on the clipboard. |
| **OS / Tauri handoff** | System open of the HTTPS wrapper *or* register `atomic:` and handle `atomic:open` / bare `atomic:{genesis}`; do **not** offer a second “Copy atomic link” button. |
| **Invite** | Still `{server}/app/invite?token=…&agent=…&node=…` — separate verb; hints use `atomic:` forms. |
| **Pairing** | `atomic:pair?…` only (QR + copy); not a share link. |

### Clipboard options (pick at implement time)

**A — HTTPS always (safest default)**  
Copy link = HTTPS show URL with `atomic:` subject + `agent` (always when
signed in) + `node` (when known). Paste of bare `atomic:` / `did:ad:` still
works in search. Users never see two schemes on the clipboard.

**B — Atomic URI always**  
Copy link = `atomic:{subject}?agent=&node=`. Shortest; bad in email/Slack
without a client. Pair with a landing page that understands the scheme later.

**Recommendation:** ship **A** first; add “Copy Atomic URI” as an advanced
control only if needed. Either way, **stop emitting `atomic://` and `did:ad:`
on new copies.**

### Resolve order (unchanged substance)

For a missing local subject: local → `node` hint → `agent` via pkarr → known
peers. Documented in `didResolve.ts` / zones discovery section; rename helpers
when the scheme flips (`atomicResolve` etc. optional).

## Docs / naming

- Rename public doc narrative from “DID method” → **Atomic URIs**
  (`docs/src/did.md` → e.g. `docs/src/uris.md` or keep filename with a banner).
- Comparison table vs `did:web` becomes optional historical note, not a
  compliance claim.
- `Subject::Did` in Rust may become `Subject::Atomic` (or keep the variant name
  internally with a comment — implementer’s call; user-facing strings change
  first).

## Migration checklist

- [ ] Spec this grammar in `docs/` (status: accepted) and demote DID wording.
- [ ] Shared normalize/parse in `atomic_lib` + `@tomic/lib` (dual-read
      `did:ad:` + `atomic://` → canonical `atomic:`).
- [ ] Emit `atomic:` from genesis subject derivation, agent subject, node
      APIs, blob subjects, Copy link, invites, pairing QR.
- [ ] Update `buildShareLink` / `parseDidOpenInput` / PairingLinkHandler /
      Tauri + Android scheme handlers for `atomic:` (keep `atomic://` alias).
- [ ] Server `/resolve-agent`, `/iroh-sync`, `/server` nodeId: accept both,
      return `atomic:`.
- [ ] Pkarr publish path: agent key material unchanged; only the URI string
      form changes.
- [ ] Tests: round-trip alias map; Copy link snapshot; e2e paste `did:ad:` and
      `atomic:`; update `testdata/` fixtures.
- [ ] Flutter / bridge string checks for `did:ad:` prefixes.
- [ ] After one release dual-reading: optional store rewrite tool; then
      deprecate write of `did:ad:`.

## Non-goals

- Implementing DID Core later “to justify the prefix.”
- Per-zone DHT records as the default way to resolve a bare subject (still
  agent/node/peers — [`zones.md`](./zones.md)).
- Registering the `did:` scheme on desktop/iOS.
- Merging invite tokens into resource open links.

## Open questions

- **OQ1 — Clipboard default A vs B** (HTTPS wrapper vs bare `atomic:`).
- **OQ2 — How long to dual-read `did:ad:`** in CI and released clients
  (recommend ≥ one major after emit flip).
- **OQ3 — In-place rewrite of existing OPFS/redb subjects** vs normalize only
  at the edges (edges-only is safer; full rewrite needs a tool + backup story).
- **OQ4 — Property/class URLs** on `https://atomicdata.dev/...` stay HTTPS
  (ontology); out of scope for this rename.
