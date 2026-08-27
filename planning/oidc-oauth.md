# OIDC / OAuth after DID and local-first

> **Status:** Proposal (2026-08). Reconsiders
> [#277](https://github.com/ontola/atomic-server/issues/277) (filed 2022-01
> against HTTP-origin Agents). Companion to
> [`encrypted-vault-format.md`](./encrypted-vault-format.md) (recovery
> envelope), [`device-pairing.md`](./device-pairing.md) (same key, many
> devices), [`foss-public-host-mode.md`](./foss-public-host-mode.md) (who may
> enroll a Drive), and
> [`personal-information-suite.md`](./personal-information-suite.md)
> (connector OAuth).
>
> The 2022 issue mixed three problems. This document splits them and says
> where OpenID Connect and OAuth belong on `atomic-server`.

## Goal

Decide, against the current identity model, whether this repo should speak
OIDC or OAuth, where that code would live, and what “Sign in with Google /
Okta / Keycloak” is allowed to mean.

The 2022 goal — *use an existing account, don’t mint a new one* — is still
real. The proposed mechanism (server-owned user, extra public keys on an
HTTP Agent) is not.

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

That world is gone. The useful part of steps 1–3 is not.

## What is true now

| Then | Now |
| --- | --- |
| Agent subject is an HTTP URL on a server | `did:ad:agent:{pubkey}` — the key *is* the identity |
| Creating an account means creating an Agent on that server | Creating an account means generating a keypair locally. The personal-drive DID is derived from it |
| A new device registers another public key on the same Agent | A new device imports the **same** secret (or unwraps it from a passkey / recovery envelope). Same-agent AUTH is the trust gate |
| The server is the identity provider of last resort | The server stores, forwards, and serves. It never signs as the user |
| “Link agent ↔ user” is a new table | Binding is `(iss, sub) → agent DID + wrapped envelope` on the node that configured the IdP |

Two layers, independent:

```text
Agent   = Ed25519 keypair in the client. Signs commits, HTTP, WS AUTH, Iroh AUTH.
Session = proof to this node that a person may fetch their wrapped envelope.
          OIDC and passkey assertion are session proofs.
          Neither can sign a commit.
```

OIDC sits on the session layer. It cannot become the Agent.

## Three problems that were one issue

### 1. Protocol identity — who may read or write

Answered. Agents are DIDs; writes are signed commits; reads are
signed Authentication Resources (cookie / bearer / per-request /
WS `AUTH` / Iroh `AUTH`). An OIDC access token is not an Atomic
principal. Putting one in `Authorization` on a resource GET would be
a second, weaker auth stack next to Ed25519.

Do not build this. Dedicated OIDC endpoints are a different matter (D1).

### 2. Human login / recovery — prove you are the same person on a new device

- **Any node:** secret or passkey. Owner mode: `ATOMIC_OWNER_AGENT`.
  Invites grant rights to an existing agent.
- **Node with an IdP configured:** OIDC proves the person to *this* node,
  which may then hand back the wrapped envelope it already stores for
  `(iss, sub)`.

“Sign in with Google / Keycloak” is a way to find your envelope on this
node, not a better Agent.

Passkey + PRF (roadmap, [`docs/src/roadmap.md`](../docs/src/roadmap.md))
is the restore that needs no IdP at all. OIDC does not replace it. It
serves operators whose org *mandates* an IdP — a university running
Keycloak next to `atomic-server` is the motivating case.

### 3. Calling other companies’ APIs — Gmail, Calendar, Graph

OAuth-as-connector. Orthogonal to identity. Already scoped in
[`personal-information-suite.md`](./personal-information-suite.md) and
[`importers.md`](./importers.md). Refresh tokens need an always-on
process that is not a browser tab — that is `atomic-server` (or a plugin
it loads).

The Agent that signs the resulting resources is still the user’s DID,
not `sub` from Google’s userinfo.

A fourth, inverted problem is also not #277: **this node as an
authorization server** (an app asks the user to mint an issued agent /
app key, OAuth-shaped consent, redirect back). That is “Sign in *with
Atomic*”. Closed draft PR #1275 explored it. It belongs on the node the
user is signed into.

## Why the node should speak OAuth

Talking to the operator’s own IdP, or to Google as *their* OAuth client,
is local config — the same class of thing as `ATOMIC_OWNER_AGENT` and
`HostMode`. It does not depend on any other Atomic service. Absent
config, the node never contacts an IdP.

The three OAuth roles that belong on an always-on node:

| Role | What the node does | Not this |
| --- | --- | --- |
| **OIDC relying party** | Validate an ID token from the operator’s IdP; bind `(iss, sub)` to an envelope | Treat the token as `x-atomic-*` |
| **OAuth client** (connectors) | Hold refresh tokens, run sync, commit as the user’s Agent | Use Google `sub` as the Agent |
| **OAuth authorization server** (later) | Consent + issued agent for a third-party app | Replace the user’s Agent with a bearer token |

## Decisions

### D1. Commits and resource AUTH do not speak OIDC

`POST /commit`, resource `GET`/`PUT`, WS `AUTH`, and Iroh `AUTH` never
accept an OIDC token. Authorization stays
[`authorization-sync.md`](./authorization-sync.md): signature + rights +
(eventually) grant chain.

Invite JWTs ([#544](https://github.com/ontola/atomic-server/issues/544))
stay signed grant tokens, not user sessions.

The server **may** validate OIDC on dedicated endpoints (`/oidc/*`,
envelope fetch, a session cookie that means “this browser proved an
IdP identity *to this node*”). That cookie is not `atomic_session` and
does not pass `check_read` / `check_write`.

### D2. Optional OIDC/OAuth is a node feature

`atomic-server` grows an optional relying party, configured by the
operator, advertised on `GET /server` next to `hostMode` /
`acceptsNewDrives`. Absent config, behaviour is unchanged: no provider
buttons, no IdP traffic, no Google client id shipped by us.

Suggested env (names not load-bearing):

```env
ATOMIC_OIDC_ISSUER=https://auth.example.edu
ATOMIC_OIDC_CLIENT_ID=...
ATOMIC_OIDC_CLIENT_SECRET=...   # confidential client; public+PKCE is fine too
ATOMIC_OIDC_BUTTON_LABEL=Sign in with university
```

Discovery: the data-browser asks `/server` whether this node has
providers, the same way it already asks `acceptsNewDrives`. Buttons
render only for **this** node’s configured IdP. An origin with no IdP
config never shows “Sign in with Google”.

See [How it works](#how-it-works) for the HTTP walkthrough.

HostMode is unchanged in v1. OIDC does not, by itself, let a stranger
`createDrive` on an Owner node. Enrollment is still
`ATOMIC_OWNER_AGENT` (or Open). A later, explicit flag can map an IdP
group or `email_verified`+domain onto authorized-to-create — that is an
Owner-mode expansion, not implied by configuring an issuer.

### D3. Do not mint Agents from `sub`

The coupling DID killed: a server-owned user record that *is* the
Agent. `(iss, sub)` is a key for the envelope index, not an Agent
subject, not a `publicKey` on an Agent resource, not a second auth
stack.

Multi-device stays secret-sharing (or envelope unwrap), not “add another
public key to the Agent.”

### D4. SCIM is the IdP’s job

[#277](https://github.com/ontola/atomic-server/issues/277) asked about
[SCIM](https://scim.cloud/). The directory is the operator’s IdP.
Deprovisioning is “the IdP no longer issues tokens,” so envelope fetch
fails. `atomic-server` does not need a parallel user table to SCIM into.
It must not mint agent keypairs from a directory event either.
Deprovisioning cannot un-sign historical commits.

### D5. Connector OAuth is not identity

Refresh-token holding, background sync, and provider SDKs belong on
the always-on node (or a plugin), because that is the process that stays
up. See [`personal-information-suite.md`](./personal-information-suite.md).

Do not mix connector tokens with the OIDC session in D2. A Google
Calendar refresh token is not proof of who may read a Drive.

## How it works

This is authorization-code OIDC. The **node** is the relying party
(confidential client). The browser never sees `ATOMIC_OIDC_CLIENT_SECRET`.
PKCE is still used so a stolen redirect cannot be exchanged. Endpoint
paths below are illustrative.

There are two cookies, and they are not interchangeable:

| Cookie | Who minted it | What it unlocks |
| --- | --- | --- |
| `atomic_oidc_session` | this node, after a valid ID token | `GET`/`PUT` on that user’s envelope only |
| `atomic_session` | the client, Ed25519 Authentication Resource | resource `GET`, commits, WS — today’s AUTH |

The OIDC cookie never passes `check_read` / `check_write`.

### 0. Operator

Set issuer, client id, secret, redirect URI
(`https://<this-node>/oidc/callback`) on the IdP and in the node env.
On boot the node fetches
`{issuer}/.well-known/openid-configuration` and caches JWKS. If that
fails, the node boots but advertises no providers (fail closed on the
feature, not on the process).

### 1. Welcome screen

`GET /server` already drives `accountCreationTarget`. It grows an
optional `oidcProviders: [{ label }]` (absent ⇒ today’s UI). The
welcome screen shows **Sign in with {label}** only when that array is
non-empty. No IdP config, no button, no IdP traffic.

### 2. Start

The button hits `GET /oidc/start` on **this** node. The node mints
`state`, `nonce`, and a PKCE verifier, stores them (signed cookie or
short-lived server record), and 302s to the IdP’s `authorization_endpoint`
with `client_id`, `redirect_uri`, `scope=openid`, `state`, `nonce`,
`code_challenge`.

### 3. Callback

IdP authenticates the person and 302s to
`/oidc/callback?code=…&state=…`. The node:

1. Checks `state`.
2. Exchanges `code` + `code_verifier` at the token endpoint
   (client secret stays on the node).
3. Validates the ID token: signature against JWKS, `iss`, `aud`,
   `nonce`, expiry.
4. Reads stable `(iss, sub)` — not email as the key (emails get
   reused; `sub` does not).
5. Sets httpOnly `atomic_oidc_session` bound to that pair.
6. 302s back into the app (`/app/welcome` or a dedicated restore
   route).

A failed validation is 401 and no cookie.

### 4a. First visit (no envelope yet)

`GET /oidc/envelope` under that cookie returns 404. The app runs the
existing create-identity path: mint Ed25519 locally, wrap it with
passkey and/or recovery code (`SecretEnvelope` in `lib/src/vault/`),
`PUT /oidc/envelope` with the ciphertext. The node stores it keyed by
`(iss, sub)`. It never sees plaintext. Then the client builds
`atomic_session` as it does today and uses the Agent.

### 4b. Returning device (envelope exists)

`GET /oidc/envelope` returns the ciphertext. The app prompts passkey
or recovery code, unwraps locally, `saveAgentToIDB`, builds
`atomic_session`. Same Agent as the first device — same secret, not a
second key on the Agent resource.

If unwrap fails, OIDC cannot help. The IdP proved *who sat down*; it
does not hold the DEK.

### 5. After that, Atomic is unchanged

Commits, resource GET, WS, Iroh AUTH are the Ed25519 Agent. The OIDC
cookie is unused on those paths. Signing out of the Agent clears
`atomic_session` as today. Signing out of the IdP is the IdP’s
session; the node should also drop `atomic_oidc_session` on an
explicit “disconnect this node login” action so a shared browser
cannot fetch the envelope.

### What a new browser does not get for free

OIDC on a brand-new browser gets you the **ciphertext**. Opening it
still needs a wrapper that browser can satisfy (a passkey registered
to this origin, or the recovery code). That is the point: Google
cannot impersonate the Agent if the IdP or the node is compromised.

### Deprovision

The operator removes the person in Keycloak. The next `/oidc/start`
fails at the IdP, so a new browser cannot fetch the envelope. A
device that already unwrapped the secret keeps working until that
copy is deleted — same as stealing a secret JSON today. Historical
commits stay valid; you cannot un-sign them.

### Owner mode

After unwrap, `createDrive` is still `admit_drive_write`. On an Owner
node that means the Agent DID must be `ATOMIC_OWNER_AGENT`. OIDC
success is not a Drive grant.

## Why the original flow cannot be copied

| 2022 step | Keep / change |
| --- | --- |
| OAuth client in AtomicServer `.env` | **Keep**, as the operator’s IdP (D2). Not a required third-party auth vendor |
| Front-end asks the server which providers it supports | **Keep**, via `GET /server`. No providers ⇒ no buttons |
| Client gets a token, server creates a user | **Change.** Client creates the Agent. Server stores `(iss, sub) → envelope` |
| Attach a public key to the Agent resource | **Drop.** `did:ad:agent:{pubkey}` has exactly one key |
| Store agent ↔ user on the server | **Keep as envelope index**, not as the Agent resource |

The “endpoint for adding a new public key to an Agent” TODO on #277 is
obsolete in form. Device pairing shares the existing key.

Email as a way to *add keys* ([#276](https://github.com/ontola/atomic-server/issues/276))
is the same obsolete form. A session proof does not mutate the Agent
resource.

## What “Sign in with {IdP}” is allowed to do

Allowed:

1. Create or resume a **node session** after the operator configured
   that IdP.
2. Fetch or store a wrapped recovery envelope keyed by `(iss, sub)`.
   Unwrap still needs passkey / recovery / first-run mint on the client.
3. Show provider buttons on the welcome screen **of a node that
   advertised providers**.

Forbidden:

1. Treat an OIDC token as proof of write on a Drive.
2. Let the IdP or the node sign commits, Iroh `AUTH`, or
   HTTP `x-atomic-*` headers.
3. Derive the agent secret from IdP claims.
4. Skip passkey / recovery because “they have Google.”
5. Show provider buttons on a node that has not configured an IdP
   (never ship a built-in Google client to random origins).
6. Treat OIDC success as authorized-to-create on an Owner node, unless
   a separate enroll grant says so.

## Sequencing

Passkey + PRF restore helps every node and needs no IdP. OIDC is the
org-login path. Connector OAuth is a different product. They do not
block each other.

1. This decision (this file).
2. Passkey PRF as a first-class unwrap of the existing envelope.
3. **OIDC relying party** in this repo: env, `/server` advertisement,
   callback, envelope index, welcome buttons when configured. HostMode
   enrollment unchanged.
4. Optional: IdP group / domain → authorized-to-create (Owner-mode
   expansion). Explicit flag, fail closed.
5. Connector OAuth on the node when the personal-information suite
   needs an always-on token holder.
6. Optional later: this node as an authorization server / issued agents.
   Not this issue.

The discarded 2022 PR is not a starting point. The envelope format
already is (`lib/src/vault/`).

## Open questions

1. **One IdP user, several Agents.** Keep 1:1 `(iss, sub)` → one
   envelope for v1. Extra identities stay local and unbound.
2. **Confidential client vs public + PKCE.** Resolved for v1: the node
   is the confidential client; the browser never holds the secret. PKCE
   is still used on the redirect. See [How it works](#how-it-works).
3. **Solid WebID-OIDC interop.** The gap is not “Atomic should speak
   OIDC on every GET”; it is “Solid pods authenticate with WebID-OIDC,
   Atomic authenticates with Ed25519 DIDs”. A mapping layer is a
   translator. Out of scope here.

## What not to open as follow-up

- OIDC tokens on `POST /commit` or resource `GET`
- Multi-public-key Agent resources
- Server-side JWT sessions as a substitute for signed AUTH
- SCIM against `atomic-server` itself (the operator’s IdP is the directory)
- A hard-coded Google/GitHub client on nodes with no IdP configured
