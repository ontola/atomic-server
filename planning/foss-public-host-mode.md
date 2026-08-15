# FOSS public host mode — expose HTTP, do not host strangers

> **Status:** Proposal (2026-08-15). Companion to
> [`cloud-sync-managed-node.md`](./cloud-sync-managed-node.md) (managed
> allowlist), [`unified-sync.md`](./unified-sync.md) Open Question 5
> (bootstrap admission), and [`sync-onboarding-ux.md`](./sync-onboarding-ux.md)
> (welcome / pairing copy).
>
> This is the FOSS-side answer to the same abuse the managed node already
> closes: a reachable node must not become a free sync hub. The open core
> already has the *mechanism* (`SyncPolicy` / `AllowlistPolicy`). FOSS never
> installs it. That is the gap.

## Goal

A person can put a stock `atomic-server` on the public internet — a site, a
wiki, their own workspace reachable from a phone — **without** letting
strangers store a workspace on it.

Two things that must stay true:

- **Public read of what the owner shared stays public.** `ATOMIC_HOME_DRIVE`,
  the public Agent on a Drive, invite links, and ordinary `check_read` do not
  change.
- **FOSS never phones home.** No control plane, no email, no portal. The
  owner is a local agent DID persisted on the node. Guardrail #3 in
  `cloud-sync-managed-node.md` is not renegotiated here.

## The hole today

FOSS boots `OpenPolicy`: every drive is admitted, there is no quota, and a
drive that does not exist locally is treated as a bootstrap and accepted
(`import_sync_push` and `admitted_for_drive` both carve this out;
`unified-sync.md` OQ5). Combined with the current welcome screen, a public
FOSS node is an open registration form for free storage.

Anyone who can reach the origin can:

| Path | What happens |
| --- | --- |
| Welcome → **Create account** | `NewIdentitySection` mints a DID agent and `store.createDrive()` POSTs a genesis commit. `OpenPolicy` admits it. The stranger now has a private workspace on *your* disk. |
| `POST /commit` genesis | Same write, no UI required. |
| Iroh `SYNC_PUSH` of a new drive | `/server` advertises `did:ad:node:…`. AUTH is only identity proof. A missing drive hits `Err(_) => true` and is imported. |
| `PUT /blob/{hash}` | Gated by `admit_drive_write`. Under `OpenPolicy` that is a no-op, so a freshly minted drive can also take file bytes. |

What is *already* fine, and must not be “fixed”:

- ACL on **existing** resources (`check_read` / `check_write`). A stranger
  cannot read a private Drive just because they can reach the host.
- `--public-mode` is the opposite of this feature (skip auth). Do not reuse
  the name or the flag.
- Managed nodes already install `AllowlistPolicy` from the control plane.
  This plan is the self-hosted equivalent, populated locally.
- Unsolicited Iroh peers are not written to the known-peers table (F9).
  Connection ≠ enrollment.

The old `/setup` invite is no longer the onboarding path.
`AppState` no longer creates a root Drive; the data-browser’s new-identity
flow does. Docs that still tell people to accept `/setup` are describing a
vestige. There is **no owner** on a FOSS node today — the first visitor and
the hundredth are the same to `OpenPolicy`.

## What “sync with it” means

**Host a workspace** = this node stores and serves a Drive (commits, Loro
snapshots, blobs) as an always-on replica.

That is what we gate. These are different, and stay allowed:

- A visitor **reads** a Drive the owner marked public.
- A collaborator the owner **invited** reads and writes *that* Drive
  (ordinary hierarchy rights). They do not get a blank Drive of their own.
- The owner’s **other devices** sign in as the same agent and push/pull
  the owner’s Drives over HTTPS or Iroh.

A later “host your friend’s workspace here” invite is a different product
(multi-tenant FOSS). Out of scope until someone asks for it.

## Decision: `HostMode { Open, Owner }`

| Mode | Who may enroll a new Drive | Default |
| --- | --- | --- |
| **Open** | Anyone. Today’s `OpenPolicy`. | `ATOMIC_DOMAIN` is `localhost` / loopback / a private IP |
| **Owner** | Only an **authorized-to-create** agent. `AllowlistPolicy` with **zero** grace, persisted on disk. | Everything else (public hostname, `--https`, an explicit flag) |

Override: `--host-mode=open|owner` / `ATOMIC_HOST_MODE`. Never infer
silently from `--https` alone without logging the chosen mode at boot —
a tunnel used for local dev must be able to stay Open.

**Do not** use `AllowlistPolicy`’s 10-minute bootstrap grace in Owner
mode. That window is how a stranger dumps a Drive before anyone notices.
Managed nodes need grace because enrollment is eventually consistent with
a control plane. FOSS enrollment is local and synchronous.

### Who is authorized to create a Drive

Narrower than “has write on some hosted Drive”:

1. The **owner agent** — the DID that claimed the node (setup token or
   `ATOMIC_OWNER_AGENT`).
2. Later, and only if we add it: agents the owner explicitly grants a
   `createDrive` / host right. Not v1.

A collaborator with `write` on Drive D may write to D. They may not
genesis a new Drive on this node. Treating “write on an enrolled Drive”
as “may enroll” is the abuse vector with extra steps.

The owner’s second device is the same agent DID (they imported the
secret). Creating another Drive auto-enrolls because the signer *is* the
owner.

### How a Drive gets on the allowlist

On a successful Drive genesis whose signer is authorized-to-create:
persist the Drive subject in the allowlist (redb `PluginMeta`, reload on
boot). Existing Drives at the moment the node flips Open → Owner are
snapshotted in. After that, strangers get `NotEnrolled` on every write
path that already consults `admit_decision`:

- `commit.rs::validate_and_build_response` (`POST /commit`, WS `COMMIT`)
- `engine::import_sync_push`
- `peer::admitted_for_drive` (Iroh live `UPDATE` / `DESTROY`)
- `handlers/blob.rs::put_blob`

Agent subjects (`did:ad:agent:…`) stay exempt, keyed on
`commit.subject.is_agent_did()` — never on a claimed `IS_A`. That
exemption is small; it is not a Drive. Rate-limit it (below) so it
cannot become unbounded profile spam.

### Bootstrap (closes OQ5 for Owner)

Replace `Err(_) => true` (“missing Drive ⇒ admit”) with:

- **Open:** keep today’s carve-out.
- **Owner:** admit a missing Drive iff the authenticated signer is
  authorized-to-create; then enroll it. Otherwise `NotEnrolled`.
  `ForAgent::Public` never creates a Drive.

This is “reject-until-known”, not first-writer-wins. First-writer-wins
on a public socket is a claim race.

## Setup UX

Three real journeys. The welcome screen must be able to tell them apart
from `/server` (see [Node advertisement](#node-advertisement)).

### 1. Localhost (Open) — do not touch

`Create account` → local DID → `createDrive` → it lands. This is the
FOSS path `managedServer.ts` exists to protect. E2E `before` /
`devDrive` stay on it.

### 2. Local first, then expose — the good path

1. Owner creates the account on localhost (Open).
2. They set a domain / HTTPS / `--host-mode=owner` (or the UI “Make this
   reachable on the internet” writes the same config).
3. On the flip: snapshot every Drive already on disk into the allowlist;
   persist the current agent as owner if none is set.
4. Restart (or hot-install the policy). Strangers are rejected.
   The owner’s secret still works from any browser.

Copy, in the owner’s language from `sync-onboarding-ux.md`:

> Visitors can see what you have shared. They cannot store their own
> workspace on this always-on device.

### 3. VPS first (Owner, no owner yet) — the dangerous path

A fresh node on a public address has no owner. The first `Create
account` would otherwise *be* the claim.

**Setup token** (WordPress / Ghost / Home Assistant pattern):

- On first boot in Owner mode with no owner, mint a high-entropy token.
  Persist it. Print once:

  `Owner setup: https://example.com/app/welcome?setup=<token>`

- `/setup` and the welcome `Create account` path accept that token
  **once**. From a loopback peer, the token is optional (so
  `ssh -L` / a local proxy still works without fishing in logs).
- From any other peer, missing/wrong token → the Create-account control
  is hidden and the server rejects the genesis. Do not advertise a
  working `/setup` URL on the public welcome page.
- Accepting consumes the token and writes `owner_agent` + enrolls the
  new Drive.

Headless alternative: `ATOMIC_OWNER_AGENT=did:ad:agent:…` in the env.
No token, no race. Useful for image-based deploys where the agent
already exists.

`--initialize` on a publicly bound Owner node is a footgun (it would
mint a fresh claim). Require an extra `--confirm-initialize` (or only
honor `--initialize` from a local CLI) and log a warning that names the
bind address.

### After the owner exists

Welcome screen on an Owner node:

- **No** “Create account” that creates a Drive on this node.
- **Sign in** (secret / passkey) — the owner on a new browser.
- **I have an invite** — existing resource-invite flow, if they arrived
  on one.
- If `ATOMIC_HOME_DRIVE` is set and the public Agent may read it: skip
  welcome and show the site. That is the public-website case.

A stranger who pastes their own secret signs in as themselves and sees
nothing they may read — same as today — and cannot `createDrive` here.
`promoteLocalDrive` / “use this always-on device” must fail with the
same sentence the welcome page used, not a generic 403.

### Collaborators and second devices

| Person | How they get in | What they can host |
| --- | --- | --- |
| Owner, new browser | Sign in with the secret | Their Drives (auto-enroll new ones they genesis) |
| Owner, phone | Pairing code (routing) + same-agent AUTH, or HTTPS + secret | Same |
| Collaborator | Resource invite → `read`/`write` on a Drive | That Drive only |
| Stranger | Nothing | Nothing |

Pairing stays routing-only (`device-pairing.md`). The gate is the
signer, not the NodeID.

## Node advertisement

`GET /server` already tells the client whether the node is managed.
Add three facts (absent ⇒ treat as Open, so old nodes keep working):

| Property | Meaning |
| --- | --- |
| `hostMode` | `open` \| `owner` |
| `acceptsNewDrives` | `true` only in Open, or Owner with no owner yet *and* the request carries a valid setup token (the welcome page asked with it) |
| `ownerSet` | whether an owner agent is persisted |

In Owner mode, **do not** give `ForAgent::Public` the Iroh node id or
the peer list. Those are a device inventory and a dial target. The
owner’s signed-in session still gets them (Sync page, pairing QR). A
stranger with a leaked NodeID can still *attempt* an Iroh connect;
writes fail admission. Hiding the id removes the convenient listing.

`accountCreationTarget` grows a third branch:

- managed + portal → portal (unchanged)
- FOSS Open → local Create account (unchanged)
- FOSS Owner + `acceptsNewDrives: false` → no create; Sign in / invite
- FOSS Owner + valid `?setup=` → one-shot local Create account, then
  lock

Keep this pure and unit-tested next to `managedServer.test.ts`. Do not
infer “locked” from `managed: false` alone — that is every FOSS node.

## Protection against malicious users

Admission is the load-bearing gate. These are the leftovers that
admission does not cover.

1. **Claim race** — setup token, loopback exception, no public `/setup`
   link. First-writer-wins is not acceptable on `:443`.
2. **`--initialize`** — extra confirm when bound non-loopback in Owner
   mode.
3. **Agent spam** — the agent-DID exemption lets anyone persist a tiny
   Agent resource. Either require the signer to be the owner / an
   invite-accept, or rate-limit unknown-agent `POST /commit` (token
   bucket per IP + per agent). Unbounded profile writes are the
   residual.
4. **Expensive public endpoints** — `/search`, `/query`, `/commit`,
   `/blob`, WS upgrade. A public website needs some of these; a
   stranger does not need unlimited blob PUTs. Cheap per-IP limits on
   the write endpoints, independent of ACL.
5. **Iroh slot exhaustion** — leave Iroh on (phones may use it). Do
   not persist unknown peers (already true). Optional follow-up: after
   AUTH, close the stream if the agent is not the owner and has
   `check_read` on no hosted Drive. Public-site visitors do not need
   Iroh; they use HTTP.
6. **Do not treat CORS as a write gate.** Writes are signed. Permissive
   CORS stays; it is how a public page is read from another origin.
7. **Optional disk cap** for the whole node, even for the owner, so a
   stolen secret cannot fill the disk. Nice-to-have; not v1.

`--public-mode` remains a documented footgun: “skip auth, do not bind
this to the internet.” Owner mode is the flag people actually want
when they say “public but mine.”

## What we will not do

- Put a control-plane client, heartbeat, or portal URL into the open
  `atomic-server` binary.
- Require email to claim a FOSS node.
- Change the localhost Create-account path.
- Equate “has write on a shared Drive” with “may enroll a new Drive.”
- Reuse `--public-mode` or name the feature “public mode.”
- Make the node sign as a principal to pull private Drives
  (`cloud-sync-managed-node.md` — the node relays and serves).

## Implementation sketch

Small, in this order. Each step is independently shippable and
testable.

### Phase 1 — policy on the node (no UI)

- `HostMode` on `Opts` / `Config`. Default: Open on loopback/private
  domain, Owner otherwise. Log the choice.
- On Owner boot: `Db::set_sync_policy(AllowlistPolicy)` with
  `set_grace(Duration::ZERO)`, load persisted `{ owner_agent,
  allowed_drives }` from `PluginMeta`.
- On Open → Owner flip (or first Owner boot with existing data):
  snapshot every Drive already stored into `allowed_drives`.
- Drive genesis by the owner agent → persist + enroll.
- Close the missing-Drive carve-out in Owner mode (OQ5).
- `/server` emits `hostMode`, `acceptsNewDrives`, `ownerSet`. Redact
  node id + peers for `Public` when Owner.

Tests (protocol / glue):

- Owner rejects a stranger’s Drive genesis over `POST /commit`,
  `SYNC_PUSH`, and Iroh live write.
- Owner accepts the owner agent’s second Drive and enrolls it.
- Collaborator with `write` on an enrolled Drive can commit there and
  cannot genesis a new Drive.
- Open mode (localhost default) still admits a stranger Drive — existing
  e2e `devDrive` / `createDrive` stay green.
- Snapshot-on-flip: a Drive created under Open still admits after the
  policy is installed.

### Phase 2 — claim + welcome

- Setup token mint / consume; loopback exception; `?setup=` on welcome.
- `ATOMIC_OWNER_AGENT` env.
- `--confirm-initialize` when Owner + non-loopback.
- `accountCreationTarget` third branch + `managedServer.test.ts`.
- Welcome: hide Create account when `acceptsNewDrives === false`.
- `createDrive` / `promoteLocalDrive` error copy when the node refuses
  enrollment.

Tests (flow):

- Welcome unit: Owner + `ownerSet` → no Create account.
- Welcome unit: Owner + `?setup=` → Create account once.
- Server: genesis without token from a non-loopback peer is
  `NotEnrolled`.
- Browser e2e stays on localhost Open; add one Owner-mode server
  integration test rather than a full Playwright public-bind.

### Phase 3 — abuse leftovers

- Rate-limit unknown-agent `/commit` and `/blob`.
- Optional: refuse Iroh streams whose AUTH agent has no `read` on any
  hosted Drive.
- Docs: installation “going public” section; FAQ “how do I put this on
  the internet without hosting other people”; retire `/setup` as the
  primary onboarding story.

## Docs and copy

- `docs/src/atomicserver/installation.md` — new subsection after
  HTTPS: default Owner on a public domain, setup-token log line,
  localhost-then-expose, `ATOMIC_OWNER_AGENT`, `ATOMIC_HOST_MODE=open`
  escape hatch for a *deliberate* multi-user FOSS node.
- `docs/src/atomicserver/gui.md` — stop leading with `/setup`.
- `docs/src/atomicserver/faq.md` — “How do I make my data private, yet
  available online?” already points at the public Agent. Add: the node
  being reachable is not the same as the node hosting strangers.
- `planning/unified-sync.md` OQ5 — Owner mode is reject-until-known;
  Open keeps the carve-out.
- `planning/sync-onboarding-ux.md` — welcome branches; language:
  “always-on device,” not “sync hub.”

## Open questions

1. **Should Owner be the default as soon as `ATOMIC_DOMAIN` is not
   localhost, or only when `--https` / a non-loopback bind is set?**
   Leaning: non-localhost domain. A `ATOMIC_DOMAIN=example.com` HTTP
   node on a VPS is already public to anyone who finds the port.
2. **May the owner grant `createDrive` to another agent in v1?** No.
   Invite-to-a-Drive covers collaboration. Host-your-own-Drive is
   multi-tenant and needs its own invite type.
3. **Disable Iroh in Owner mode?** No for v1. HTTPS is enough for the
   browser; phones still pair. Redacting the NodeID from public
   `/server` is the first cut.
4. **Name.** `hostMode` / Owner, not “public mode,” not “locked,” not
   “registration.” The node is not a product with accounts; it has an
   owner.
)
