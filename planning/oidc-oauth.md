# OIDC / OAuth after DID and local-first

> **Status:** Proposal (2026-08). Reconsiders
> [#277](https://github.com/ontola/atomic-server/issues/277) (filed 2022-01
> against HTTP-origin Agents). Companion to
> [`cloud-sync-managed-node.md`](./cloud-sync-managed-node.md) (account session
> vs agent), [`encrypted-vault-format.md`](./encrypted-vault-format.md)
> (recovery), [`device-pairing.md`](./device-pairing.md) (same key, many
> devices), [`foss-public-host-mode.md`](./foss-public-host-mode.md) (no
> control plane in FOSS), and
> [`personal-information-suite.md`](./personal-information-suite.md)
> (connector OAuth).
>
> The 2022 issue mixed three problems. This document splits them and says
> where OpenID Connect still belongs.

## Goal

Decide, against the current identity model, whether Atomic should speak OIDC
or OAuth, where that code would live, and what “Sign in with Google / Okta”
is allowed to mean.

The 2022 goal — *use an existing account, don’t mint a new one* — is still
real. The proposed mechanism is not.

## What #277 assumed (2022)

Atomic identity was a server-hosted Agent URL. The server was the place an
account lived. OIDC was a way to skip creating that account:

1. AtomicServer reads OAuth client secrets from `.env`.
2. The data-browser shows “Sign in with Google” if the server advertises a
   provider.
3. The browser obtains a token; the server validates it with the IdP.
4. The server creates or looks up a user and attaches a client-generated
   public key to that Agent.
5. Commits still need a private key, minted on the client.

The issue already knew step 5. Everything else assumed a server-owned user
record that a public key could be *added to*.

That world is gone.

## What is true now

| Then | Now |
| --- | --- |
| Agent subject is an HTTP URL on a server | `did:ad:agent:{pubkey}` — the key *is* the identity |
| Creating an account means creating an Agent on that server | Creating an account means generating a keypair locally. The personal-drive DID is derived from it |
| A new device registers another public key on the same Agent | A new device imports the **same** secret (or unwraps it from a passkey / recovery envelope). Same-agent AUTH is the trust gate |
| The server is the identity provider of last resort | The server stores, forwards, and serves. It never signs as the user. FOSS has no email, no portal, no phone-home |
| “Link agent ↔ user” is a new table | Already exists on the **control plane**: enrollment `agent_subject`, `IdentityReconcileGate`, passkey-wrapped recovery |

Two identity layers already exist and are independent
([`cloud-sync-managed-node.md`](./cloud-sync-managed-node.md)):

```text
Agent  = Ed25519 keypair in the client. Signs commits, HTTP, WS AUTH, Iroh AUTH.
Account session = email + cookie on the control plane (atomic-saas).
                 Pays, enrolls a drive on a managed node, holds the
                 wrapped recovery envelope. Cannot sign a commit.
```

OIDC can only ever sit on the second layer. It cannot become the first.

## Three problems that were one issue

### 1. Protocol identity — who may read or write

Answered. Agents are DIDs; writes are signed commits; reads are
signed Authentication Resources (cookie / bearer / per-request /
WS `AUTH` / Iroh `AUTH`). An OIDC access token is not an Atomic
principal. Putting one in `Authorization` would be a second, weaker
auth stack next to Ed25519.

Do not build this.

### 2. Human login / recovery — prove you are the same person on a new device

This is the remaining product. It is already shaped:

- **FOSS:** secret or passkey. Owner is `ATOMIC_OWNER_AGENT`. Invites grant
  rights to an existing agent. No IdP.
- **Hosted:** magic-link email creates a control-plane session; that session
  may create a drive enrollment and store a passkey-wrapped (or recovery-code
  wrapped) copy of the agent secret. The session does not hold the raw key.

“Sign in with Google” is a **better magic-link**, not a better Agent.

Passkey + PRF (roadmap, [`docs/src/roadmap.md`](../docs/src/roadmap.md)) is
the higher-leverage version of the same problem: one prompt restores the
identity without an IdP at all. OIDC does not replace that work. It serves
orgs that *mandate* an IdP.

### 3. Calling other companies’ APIs — Gmail, Calendar, Graph

OAuth-as-connector. Orthogonal to identity. Already scoped in
[`personal-information-suite.md`](./personal-information-suite.md) and
[`importers.md`](./importers.md). Tokens live with the host acquisition
service, never in the protocol, never as the user’s Atomic credential.

Do not mix this with #277.

A fourth, inverted problem showed up later and is also not #277:
**Atomic as the authorization server** (an app asks the user to mint an
issued agent / app key, OAuth-shaped consent, redirect back). That is
“Sign in *with Atomic*”, not “Sign in to Atomic with Google”. Closed draft
PR #1275 explored it; it does not belong in this issue.

## Decisions

### D1. The data plane does not speak OIDC

`atomic-server`, `atomic_lib`, and the commit / AUTH / invite paths never
accept, issue, or validate OIDC tokens.

Consequences:

- No `ATOMIC_OIDC_*` env vars on the open server.
- No `openidconnect-rs` (or equivalent) in this repo.
- No “if the server has OAuth secrets, show a Google button” branch in
  `RegisterSignIn` / `GettingStartedFlow` for FOSS.
- Invite JWTs ([#544](https://github.com/ontola/atomic-server/issues/544))
  stay what they are: signed grant tokens, not user sessions.

An OIDC token cannot authorize a commit, a `GET`, a WS `AUTH`, or an Iroh
`AUTH`. Authorization stays
[`authorization-sync.md`](./authorization-sync.md): signature + rights +
(eventually) grant chain.

### D2. Control-plane SSO is the remaining “Sign in with existing account”

`atomic-saas` already has a session independent of the agent. Magic-link is
today’s identity provider. Google / GitHub / a generic OIDC client
(Keycloak, Okta, Entra, Authentik) replace that hop:

```text
IdP (OIDC)
  → control-plane session cookie  (same as magic-link today)
    → unwrap or create the recovery envelope
      → client holds the agent secret and signs
```

The data-browser already redirects account creation to the portal when
`accountCreationTarget` says the node is managed. SSO UI lives on the
portal, not in the FOSS welcome screen. That keeps FOSS guardrail #3
(control-plane client stays out of open `atomic-server`).

Linking: one control-plane user ↔ one primary agent, same as
`IdentityReconcileGate` today. The IdP subject (`sub` + `iss`) is a
property of the **user row**, not of the Agent resource.

The control plane still must not learn the raw agent secret. Envelope
wrappers (passkey PRF, recovery code, and — if we ever add it — a
server-held wrap under a user-specific key the IdP does not have) stay
the only thing stored. An IdP outage must not be an identity-loss event
if a passkey or recovery code exists; an IdP compromise must not let the
attacker sign commits.

### D3. FOSS `atomic-server` does not grow an IdP adapter

A public FOSS node’s owner is an agent DID
([`foss-public-host-mode.md`](./foss-public-host-mode.md)). Collaborators
arrive via invites. There is no email, no user table, no place to put an
OIDC `sub`.

Self-hosted operators who want “employees sign in with Okta” are asking
for a **control plane**, not a flag on the data plane. Until someone
builds a separable FOSS account adapter (a new product), the answer is:
use invites, or run the hosted/control-plane path.

Do not quietly reintroduce the 2022 `.env` OAuth client on `atomic-server`
to satisfy this. That would make the node an identity broker, store
client secrets, and create Agent records from IdP claims — the exact
coupling DID was meant to kill.

### D4. SCIM is control-plane user provisioning, not Agent minting

[#277](https://github.com/ontola/atomic-server/issues/277) asked about
[SCIM](https://scim.cloud/). SCIM creates and deprovisions **users** in
an org directory. In this model that directory is the control plane.

SCIM must not mint agent keypairs. A provisioned user is an empty account
that can later enroll a device (passkey / generated identity).
Deprovisioning revokes the control-plane session and drive enrollments;
it cannot un-sign historical commits. Tombstone the user’s access, don’t
pretend the DID never existed.

Sequence: orgs on the control plane, then OIDC, then SCIM. Not before.

### D5. Connector OAuth stays in the importer/host, never in AUTH

Google Calendar tokens are not identity. They are credentials for a
connector process that produces **client-signed** Atomic resources. See
[`personal-information-suite.md`](./personal-information-suite.md). The
Agent that signs those resources is still the user’s DID, not `sub` from
Google’s userinfo endpoint.

## Why the original flow cannot be repaired

| 2022 step | Why it fails now |
| --- | --- |
| Check OAuth secrets in AtomicServer `.env` | Secrets on the data plane; FOSS phone-home / broker role; D1/D3 |
| Front-end asks the server which providers it supports | FOSS server has no providers. Hosted: ask the **portal** |
| Client gets a token, server creates a user | Users are not Agents. The client creates the Agent. The server verifies signatures |
| Attach a public key to the Agent resource | `did:ad:agent:{pubkey}` has exactly one key. A second key is a second Agent. Multi-device is secret-sharing, not key-adding |
| Store agent ↔ user on the server | Already a control-plane binding. Duplicating it in `atomic-server` splits source of truth |

The “endpoint for adding a new public key to an Agent” TODO on #277 is
**done in spirit and obsolete in form**. Device pairing shares the
existing key; it does not grow a keyring on the Agent class.

Email magic-link as a way to *add keys* ([#276](https://github.com/ontola/atomic-server/issues/276))
is the same obsolete form. Email proves the control-plane user; it does
not mutate the Agent resource.

## What “Sign in with Google” is allowed to do

Allowed:

1. Create or resume a **control-plane session** (hosted only).
2. After that session exists, unlock a wrapped recovery envelope the
   client already knows how to decrypt with a passkey / recovery code, or
   start a new local identity and store a new envelope.
3. Show the portal’s provider buttons, then return to the app with the
   same `session_token` cookie magic-link already sets.

Forbidden:

1. Treat an OIDC token as proof of write on a Drive.
2. Let the IdP or the control plane sign commits, Iroh `AUTH`, or
   HTTP `x-atomic-*` headers.
3. Derive the agent secret from IdP claims (Google can then impersonate
   forever; so can anyone who steals the IdP client secret).
4. Skip passkey / recovery because “they have Google”.
5. Surface provider buttons on a FOSS welcome screen.

## Sequencing

Passkey + PRF restore is on the public roadmap and helps FOSS **and**
hosted. Control-plane OIDC helps hosted orgs that already have an IdP.
They do not block each other; passkey is the default restore, OIDC is
the org login.

Suggested order, none of it in this repo until the control plane grows
the IdP client:

1. This decision (this file). Retarget #277; do not implement OIDC here.
2. Passkey PRF as a first-class unwrap of the existing envelope
   (`encrypted-vault-format.md` already allows additional wrappers).
3. Generic OIDC on **atomic-saas** (one client config, many IdPs),
   session cookie unchanged, envelope path unchanged.
4. Convenience providers (Google, GitHub) as pre-set OIDC clients on
   the portal.
5. SCIM after control-plane orgs exist.
6. Connector OAuth when the personal-information suite needs it.
7. Optional later: Atomic-as-IdP / issued agents for third-party apps
   (the inverted OAuth). Not this issue.

The discarded 2022 PR is not a starting point. Joepio already said so on
the issue; this document is the replacement.

## Open questions

1. **Self-hosted SSO without a control plane.** A university running
   stock `atomic-server` plus Keycloak. D3 says no for v1. A future FOSS
   “account adapter” would be a separate crate/binary, not env vars on
   the data plane. Leave closed until someone asks with a design that
   doesn’t mint Agents from `sub`.
2. **One IdP user, several Agents.** Today’s reconcile gate assumes one
   primary. Keep 1:1 for SSO v1. Extra identities are local (anonymous
   Agents) and unbound to the account.
3. **Solid WebID-OIDC interop.** [`docs/src/interoperability/solid.md`](../docs/src/interoperability/solid.md)
   listed “no OIDC” as a gap. The gap is not “Atomic should speak OIDC”;
   it is “Solid pods authenticate with WebID-OIDC, Atomic authenticates
   with Ed25519 DIDs”. A mapping layer (if anyone wants Solid interop) is
   a translator, not a second auth stack inside Atomic. Out of scope
   here.

## What not to open as follow-up in this repo

- `ATOMIC_OIDC_CLIENT_ID` / LogTo / Auth0 env on `atomic-server`
- Google button in `GettingStartedFlow` for unmanaged nodes
- Multi-public-key Agent resources
- Server-side JWT sessions as a substitute for signed AUTH
- SCIM against `atomic-server` itself
