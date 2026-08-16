# Issued agents — keys for apps and plugins

> **Status:** Proposal (2026-08-15). Phase 1 (create / list / revoke in User
> Settings) is in progress in the data-browser. Last-used tracking, rotation,
> expiry, and a dedicated `AccessGrant` class are later phases.
>
> Unifies the "grants-as-agents" idea in
> [`android-data-reuse.md`](./android-data-reuse.md) §5 / Phase 3 and the
> extension-agent grant in
> [`atomic-assistant-browser-extension.md`](./atomic-assistant-browser-extension.md).
> Distinct from [`device-pairing.md`](./device-pairing.md) (same agent, your
> devices) and from invites (other people).

## Goal

Treat extra agents as **keys**: mint a new identity, give it only the rights
the job needs, hand the secret to an app, and keep a private list of what
exists, what it can do, and (later) when it was last used.

The motivating case: a Raycast extension that should read every workspace,
without ever holding the account secret.

## Principle: no new token primitive

An Atomic Agent already *is* a token.

- The **secret** is the credential (`{privateKey, subject}` base64).
- The **DID** (`did:ad:agent:{publicKey}`) is the principal.
- **`read` / `write` on resources** are the scopes. Enforcement is the
  existing rights walk (`docs/src/hierarchy.md`,
  [`authorization-sync.md`](./authorization-sync.md)).
- **Revocation** is removing that DID from those lists. The key still exists;
  it can no longer read or write anything you granted.

Do not invent a parallel permission model, a bearer-token scope language, or
a server-side API-key table. A grant maps to a real Agent. The same rule is
already written down for Android third-party apps and for the browser
extension: *no parallel permission model*.

`/app/token` is **not** this. That page mints a short-lived Authentication
Resource signed by the *current* agent — it is "act as me for a while", with
the same rights as the account. Fine for a personal CLI talking to your own
node. Never give it to a plugin.

## Four identity products

These are easy to conflate. They are not the same product.

| Product | Who it is | Secret | Typical grant | Where |
| --- | --- | --- | --- | --- |
| **You** | Primary agent | Never leave the device; non-extractable in the browser | Implicit creator write | User Settings, recovery |
| **Your devices** | The same agent, another node | Must not travel in a QR / deep link | Same rights as you (it *is* you) | [`device-pairing.md`](./device-pairing.md) |
| **Other people** | Their agent | They already have one | Invite → add their DID to `read` / `write` | Share dialog |
| **Apps / plugins** | A **new** agent you issued | Shown once, given to the app | Minimum rights for that job | **This plan** — User Settings → App keys |

First-party apps that run *on the same device as a trusted host* (Android
Binder, a future desktop daemon) should still **not** receive a secret: the
host signs as you after checking the caller. Issued agents are for code that
is not you and is not that host — Raycast, a CI job, a browser extension
talking to a hosted node, a local script.

## What exists today

Already in the protocol and libraries:

- Anyone can mint an Ed25519 agent; the subject is `did:ad:agent:{publicKey}`.
- `Agent.buildSecret` / `Agent.fromSecret` is the portable credential.
- Drive (and resource) `read` / `write` arrays are the ACL. Rights inherit
  down the parent tree and are additive.
- Invites grant rights to *someone else's* agent.
- The personal drive is the per-user home index (`drives`, `sharedWithMe`,
  `favorites`) — the right place for a private registry.
- Well-known folders inside a drive are found by `localId` (`drafts`,
  `forks`) or by a pointer property (`commentsFolder`, `aiChatsFolder`).

Missing:

- A first-class mint flow that does **not** switch the signed-in session.
- A private list of agents *you* issued (as opposed to people you shared
  with).
- Show-once secret UX (the account secret is a recovery concern; an app key
  is a credential).
- Last-used for **read-only** keys (they never write commits).
- Language that says "key" to a person and "agent secret" to a developer.

## Data model

### Phase 1 (ships with the first UX)

No new ontology. Reuse what the personal drive already does for drafts.

- A private folder on the **personal drive**, found by `localId: app-keys`.
  No public `read`. The folder is the registry.
- Each issued identity is a real `Agent` resource:
  - subject `did:ad:agent:{publicKey}`
  - `name` (e.g. `Raycast`)
  - `publicKey`
  - `read: [publicAgent]` so anyone can resolve the key for signature checks
  - `parent` = the App keys folder, so the registry is just the folder's
    children
- The **genesis of that Agent resource is signed by you**, not by the new
  key. You own the profile (name, description, revocation mark). The issued
  key does not need write on itself.
- Scopes are the live ACL: the DID is pushed onto each chosen **resource's**
  `read` (and `write` if asked) — a workspace, a folder, a page. Rights
  inherit down the parent tree, so a folder grant is that folder and its
  children, not the rest of the workspace. The rights lists are the source
  of truth. The issued agent also records the target subjects (so revoke
  can find a folder-level grant, not only the workspaces the UI has loaded).
  The folder is only the index of "ones I minted".
- The secret is **not** stored. Shown once at creation. Lost secret → mint
  a new key and revoke the old one (Phase 2 will call this rotate).
- Revoked keys stay in the folder, name suffixed ` (revoked)`, and are
  removed from every known workspace ACL.

Parenting an Agent under a folder is a deliberate exception to "agents are
top-level". User agents stay parentless. Issued agents are *your* objects;
putting them in the personal-drive tree is what makes the list sync to every
device you own, without a new property.

### Phase 2 — `AccessGrant` class

When last-used, expiry, and per-grant notes outgrow a name + ACL scan,
introduce a private wrapper in the same folder (or replace the parented-Agent
trick):

```text
AccessGrant
  name            "Raycast"
  description     "Read-only for the Raycast extension"
  agent           did:ad:agent:…        (atomicURL)
  targets         [drive, …]            (resourceArray)  — cache; ACL wins
  write           false
  createdAt       (genesis)
  lastUsedAt      timestamp             — server-written, rate-limited
  expiresAt       timestamp?            — optional
  revoked         boolean
```

The Agent resource stays public and parentless again (back to the usual
rule). The grant is private. Revocation still means "remove from ACLs";
`revoked` is the UI bit.

`issuedAgents` as a ResourceArray on the personal drive is an alternative
index if a folder of children becomes awkward. Same pattern as `favorites`.

Do not put the secret on the grant. If we ever offer "show secret again",
it is an encrypted copy under the user's vault key
([`encrypted-vault-format.md`](./encrypted-vault-format.md)), never a
plaintext property.

## Secret handling

| Rule | Why |
| --- | --- |
| Show once, copy, blur by default (`SecretCodeBlock`) | Same shoulder-surf problem as the account secret |
| Never write the secret into a resource | Personal drive can later be shared, synced to a less-trusted node, or leaked through a "read everything" key |
| Never put it in a QR, deep link, or invite URL | [`device-pairing.md`](./device-pairing.md) already rejected this for the account secret |
| Developer docs say `Agent.fromSecret(secret)` | The credential *is* an agent secret; apps should not grow a second login type |
| Rotate = new agent + same grants + revoke old | The DID is the principal; you cannot rotate a key in place |

"Reuse" means: keep using the same issued agent. Add another workspace to
its ACL. Do not mint a second Raycast key unless the first is burned.

## Last-used

Read-only keys never create commits. Last-used **cannot** come from the
commit log.

It has to come from authentication: HTTP signed headers, cookie / bearer
Authentication Resources, and WebSocket `AUTHENTICATE`. On a successful
auth whose agent is in the App keys registry, the server writes
`lastUsedAt` on the grant (or, in Phase 1, we simply do not show it).

Write at most once per hour per agent so a chatty client does not generate
a commit storm. Optional later: `lastUsedFrom` (a client-declared name
like `raycast-atomic/0.1`), never trusted for authorization.

Until that lands, the list shows name, access level, and revoked-or-not.
"Which ones were used" is Phase 2.

## UX

Lives on **User Settings** (`/app/agent`), not on Share. Share is "who else
can see this resource". App keys are "what identities did I mint".

Language (see [`sync-onboarding-ux.md`](./sync-onboarding-ux.md)):

| Say | Not |
| --- | --- |
| App key | Agent, token, API key (in the UI) |
| Your account secret | Agent secret (in the UI) |
| Workspace | Drive |
| Read / Read and write | `read` / `write` |

Developer-facing docs and the copied blob may say "agent secret".

### Create

1. Name (required) — `Raycast`
2. Access — Read only / Read and write
3. Access to — workspaces as checkboxes (default all current ones), plus
   a search box for any folder, page, or other resource. A later resource
   is not granted until you add it.
4. Create → the current session stays *you*. A new keypair is minted, the
   Agent resource is published, rights are pushed, the secret is shown
   once.

### List

Each row: name, Read / Read and write, Revoke. Revoked rows stay, marked.

### Reuse

On an existing key: grant it additional resources without minting a new
secret. That is the whole reuse story for v1.

### Share dialog (later)

"Create an app key for this" as a third action next to Copy link and
Create invite. Same helper, one target pre-selected.

## "Read everything"

Rights inherit down a workspace. Granting `read` on a drive grants `read`
on its children.

There is no server-wide "read all drives" bit. "Everything" is "every
workspace I can currently write to". New workspaces are a new grant.

When [`zones.md`](./zones.md) lands, the grant target becomes a zone root
instead of a drive. The UX word stays "workspace" until zones have a
user-facing name.

A key with read on the personal drive can see the App keys folder (names
and DIDs, not secrets). That is the cost of "read everything". Narrower
keys should not be granted the personal drive.

## Revocation

1. Remove the DID from `read` / `write` on every workspace we know about
   (personal + saved drives; later, scan any target cached on the grant).
2. Mark the registry entry revoked.
3. Do not destroy the Agent resource. Old commits still need the public
   key. The DID is permanent; only the grant dies.

There is no way to make a leaked secret "forget" itself. Anyone holding it
can still *sign*. They just fail authorization.

## Relation to existing work

- **Android third-party apps** ([`android-data-reuse.md`](./android-data-reuse.md)):
  a grant is an issued agent bound to `(package, cert)`. Same object. The
  Settings list is the cross-platform grant collection; Binder is only the
  local enforcement transport.
- **Browser extension**
  ([`atomic-assistant-browser-extension.md`](./atomic-assistant-browser-extension.md)):
  "generate a non-extractable extension agent, grant minimum rights" is
  this flow with a non-extractable key instead of a copyable secret.
- **Device pairing** ([`device-pairing.md`](./device-pairing.md)): out of
  scope. Pairing must never carry an issued-agent secret either.
- **Invites**: the other direction — someone else brings their own agent.
- **`/app/token`**: deprecate as a plugin credential. Relabel as "sign in
  as you (short-lived)".
- **Zones / authorization-sync**: issued agents are ordinary principals.
  No special case in `check_rights`.

## Phasing

### Phase 1 — mint, list, revoke, reuse

- [x] This document.
- [x] `issueAccessAgent` / `revokeAccessAgent` / `grantAccessAgent` in
      `@tomic/lib` (session stays the current agent).
- [x] App keys folder (`localId: app-keys`) on the personal drive.
- [x] User Settings card: create (name, read/write, any resource), show
      secret once, list, revoke, add access to an existing key.
- [x] Unit tests on the helper. Docs: agents page + this plan.
- [x] Relabel `/app/token` so it is not mistaken for a scoped key.

### Phase 2 — activity and rotation

- [ ] Rate-limited `lastUsedAt` on successful auth of a registered
      issued agent.
- [ ] Rotate (new agent, copy grants, revoke old).
- [ ] Optional expiry (`expiresAt`); server rejects auth after it.
- [ ] `AccessGrant` class if the folder-of-agents index is not enough.

### Phase 3 — consume the same grant everywhere

- [ ] Android consent screen writes an `AccessGrant` (or the Phase 1
      folder entry) instead of a one-off agent.
- [ ] Extension grant UI uses the same helper.
- [ ] Share dialog: "Create an app key for this".
- [ ] Optional encrypted secret copy in the vault, for "show again".
- [ ] Auto-grant to new workspaces for keys marked "all my workspaces".

## Open questions

- Should "all my workspaces" auto-grant on `createDrive`? Convenient, and
  a surprise if you mint a new private workspace. Default off; a checkbox
  on the key is enough.
- Do we ever store the secret? GitHub-style show-once is the safer
  default. "Show again" is a vault feature, not a graph property.
- Class-level or "search but not bodies" scopes still wait on zones and
  search filtering. Resource-level grants (folder, page, workspace) ship
  now — that is the existing rights walk.
- Groups of agents ([docs issue 73](https://github.com/atomicdata-dev/atomic-data-docs/issues/73))
  would let several keys share a grant. Not needed until someone is
  minting many keys for one job.

## Testing

| Layer | What |
| --- | --- |
| **protocol** | Already covered: rights on drives (`lib/tests/drive_rights.rs`), agent DID auth |
| **glue** | `issueAccessAgent` / `revokeAccessAgent` / `grantAccessAgent` against `testStore` — mint does not call `setAgent`, secret round-trips, ACL push/remove |
| **flow** | Settings create → secret shown → list row → revoke. E2E only if the helper tests are not enough to catch a session-switch bug |

A test that creates an issued agent and then asserts `store.getAgent()` is
still the original DID is load-bearing. Switching the session is the
failure mode this feature exists to avoid.
