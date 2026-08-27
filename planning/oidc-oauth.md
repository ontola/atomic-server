# OIDC / OAuth after DID and local-first

> **Status:** Proposal (2026-08). Reconsiders
> [#277](https://github.com/ontola/atomic-server/issues/277) (filed 2022-01
> against HTTP-origin Agents). Companion to
> [`encrypted-vault-format.md`](./encrypted-vault-format.md) (recovery
> envelope), [`device-pairing.md`](./device-pairing.md) (same key, many
> devices), [`foss-public-host-mode.md`](./foss-public-host-mode.md) (who may
> enroll a Drive),
> [`authorization-sync.md`](./authorization-sync.md) (session certs as
> delegation), [`genesis-self-verifying.md`](./genesis-self-verifying.md)
> (compact signed certs), and
> [`personal-information-suite.md`](./personal-information-suite.md)
> (connector OAuth).
>
> The 2022 issue mixed three problems. This document splits them and says
> where OpenID Connect and OAuth belong on `atomic-server`.
>
> **Decision:** OIDC-only login mints a **session Agent** (short-lived
> Ed25519, private key in the browser) certified by a **root Agent**
> (CA, private key stays on this node). One click, nothing to memorize.
> Commits stay Ed25519. Not a JWT in `signature`, not root-key download.

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
| A new device registers another public key on the same Agent | A new device gets a **new session Agent**, certified by the same root. `write` lists still name the root |
| The server is the identity provider of last resort | Commits are still client-signed (by the session key). This node is CA for OIDC-only roots |
| “Link agent ↔ user” is a new table | Binding is `(iss, sub) → wrapped root Agent` on the node that configured the IdP |

Two layers, independent:

```text
Agent (root)    = long-lived Ed25519. The person. DID in `write` lists.
                  For OIDC-only users, the private key stays on this node.
Session Agent   = short-lived Ed25519. This browser. Signs commits and AUTH.
                  Certified by the root. Private key never leaves the device.
OIDC session    = proof to this node that it may issue a SessionCert.
                  Cannot sign a commit.
```

## Three problems that were one issue

### 1. Protocol identity — who may read or write

Answered. Agents are DIDs; writes are signed commits; reads are
signed Authentication Resources (cookie / bearer / per-request /
WS `AUTH` / Iroh `AUTH`). An OIDC access token is not an Atomic
principal. Putting one in `Authorization` on a resource GET would be
a second, weaker auth stack next to Ed25519.

Do not build this. Dedicated OIDC endpoints are a different matter (D1).

### 2. Human login / recovery — prove you are the same person on a new device

What #277 wanted, and what a “Sign in with Google” button still means
to people: **one click, nothing to memorize or write down.**

That cannot be a ciphertext the client still needs a passkey or recovery
code to open. Then OIDC is a lookup, not a login, and everyone who
showed up for SSO is asked for a second credential they didn’t want.

Two “nothing to memorize” restores exist. They have different trust:

| Restore | User holds | Who can impersonate |
| --- | --- | --- |
| Passkey + PRF | platform authenticator | whoever has that passkey |
| OIDC-only | nothing extra | whoever can complete OIDC as that `sub` **and** this node (IdP admin, stolen IdP session, node operator) |

OIDC-only is custodial **of the root**, on purpose. The node holds the
root wrapping key and, after a valid ID token, signs a SessionCert for
a pubkey the **browser generated**. Do not derive keys from IdP claims.
Do not download the root to JS. Do not make the user unwrap a second
secret.

Passkey-only onboarding (no IdP) stays the restore for nodes that never
configured one. A passkey wrapper on the root envelope is optional
insurance if this node dies — not part of the OIDC button.

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
| **OIDC relying party** | Validate an ID token; sign a SessionCert for a browser pubkey | Treat the token as `x-atomic-*`; HKDF keys from `sub`; download the root |
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

The server **may** validate OIDC on dedicated endpoints (`/oidc/*`).
That cookie is not `atomic_session` and does not pass `check_read` /
`check_write`. It **is** enough to ask the node to sign a SessionCert
for a browser-generated pubkey — see D2.

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
Agent. `(iss, sub)` is the index key for a wrapped secret, not an Agent
subject, not a `publicKey` on an Agent resource, not a second auth
stack.

The client still mints the **root** Ed25519 key on first visit (or the
node does, same custodial outcome). The node stores it wrapped and
**does not send it to the browser.** After OIDC, the browser mints a
**session** keypair and the root signs a SessionCert over that pubkey
(notAfter, root DID). That is a CA, not “add another key to the Agent
resource.”

`write` lists still name the **root**. Verifiers accept a commit
signed by a session key iff the attached cert chains to that root and
`createdAt` is inside the cert’s window.

The node could still issue a session to itself and impersonate; that
is the custodial bargain for OIDC-only. It does not have to *send* the
root to JS, and it must not sign content commits as the user.

### D4. SCIM is the IdP’s job

[#277](https://github.com/ontola/atomic-server/issues/277) asked about
[SCIM](https://scim.cloud/). The directory is the operator’s IdP.
`atomic-server` does not grow a user table to SCIM into. Deprovisioning
is “the IdP no longer issues tokens,” so the node refuses to sign new
SessionCerts. Existing session keys work until `notAfter`. Historical
commits stay valid.

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
| `atomic_oidc_session` | this node, after a valid ID token | “sign a SessionCert for this pubkey” |
| `atomic_session` | the client, Ed25519 AUTH resource **from the session Agent** | resource `GET`, commits, WS — today’s AUTH |

The OIDC cookie never passes `check_read` / `check_write`. The session
Agent’s AUTH does, once the cert chains to a root that has rights.

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

### 4a. First visit (no root stored yet)

`GET /oidc/root` under that cookie returns 404. The node mints the
**root** Agent, wraps it with a node-held KEK, stores it keyed by
`(iss, sub)`. The private key does not go to the browser.

The browser generates a **session** keypair and `POST /oidc/session`
with the session pubkey. The node unwraps the root, signs a
`SessionCert` (compact binary, same family as
[`genesis-self-verifying.md`](./genesis-self-verifying.md)):

```text
sessionPubKey (32) ‖ notBefore ‖ notAfter ‖ rootPubKey (32)
  — Ed25519-signed by the root
```

The browser keeps the session private key (IndexedDB, like today’s
agent) and the cert. AUTH and commits are signed by the session
Agent. Each commit carries the cert (or a hash + the verifier already
has it). `write` lists name the root; `validate_signature` grows a
chain check: session sig, then cert sig, then `createdAt` inside the
window, then rights for the **root**.

No recovery code, no passkey, nothing to copy. OIDC was the login.

### 4b. Returning device / refresh

Same cookie, same root on the node. The browser always mints a **new**
session keypair (new device, new tab cluster, refresh before
`notAfter`). `POST /oidc/session` again. Old session keys die at
`notAfter` without a revoke list for v1 (short TTL is the revoke).

The high-value endpoint is cert issuance, not “download my root.”
HTTPS-only, no cache, short OIDC cookie, audit, rate limit. A stolen
OIDC cookie can mint sessions until it expires; it does not export
the CA.

### 5. After that, signing is local

Commits, resource GET, WS AUTH are the session Agent + cert. The OIDC
cookie is unused on those paths. Offline works until `notAfter`, then
the outbox cannot sign new commits until OIDC mints a new cert.

Iroh `AUTH` today is same-agent (byte-equal DID). Session DIDs differ
per device, so AUTH must accept “cert chains to the same root” as the
person — otherwise two OIDC browsers cannot peer-sync. That is the
same-agent special case becoming the grant/cert case
[`authorization-sync.md`](./authorization-sync.md) already wants.

### Optional extra wrappers (not on the OIDC path)

The root envelope *may* also carry a passkey wrapper so the identity
survives this node dying. The OIDC button must not require it.

### Deprovision

The operator removes the person in the IdP. The next `/oidc/start`
fails, so the node will not sign new SessionCerts. Session keys
already in browsers work until `notAfter`. Historical commits stay
valid.

### Owner mode

`createDrive` is still `admit_drive_write` on the **root** DID (the
cert’s issuer). On an Owner node that must be `ATOMIC_OWNER_AGENT`.
OIDC success is not a Drive grant. A session cert does not widen
enrollment.

## Is this a good pattern?

Split the question. The **login** is conventional. The **thing we hand
the browser** is not, and that is where the danger lives.

### The login is conventional

“Sign in with the company IdP, nothing else to memorize” is how almost
every org app works. Password-manager SSO, “trusted device after Okta,”
Vault/KMS unwrap-after-OIDC, and “Sign in with Google” crypto wallets
(Magic, Privy, Web3Auth) all do a version of this. Users who asked for
#277 are asking for that, not for a second factor we invented.

Passkeys are the other conventional “nothing to memorize” login. They
keep the secret in the authenticator. OIDC-only cannot: the IdP has no
hardware key to give us, so **someone we host** has to be able to
unwrap. That someone is this node.

### Releasing the root Agent is unconventional, and it is dangerous

OIDC is designed to mint **short-lived, revocable** access tokens.
Atomic Agents are **long-lived and non-rotatable**: the DID *is* the
public key. `SecretEnvelope` already treats that as load-bearing
(“an Ed25519 agent key can never be rotated”).

`GET /oidc/secret` turns a session proof into that immortal key. After
one successful download:

| Event | Conventional OIDC app | This pattern |
| --- | --- | --- |
| Stolen session cookie | Attacker acts until expiry / revoke | Attacker has the Agent **forever** |
| IdP admin impersonates | They get a session; revoke ends it | They can download the signing key |
| Node disk + KEK stolen | Reset passwords, drop sessions | Every OIDC user’s identity leaks |
| XSS on the origin | Session token, bounded | Signing key in JS, unbounded |
| Deprovision in the IdP | Immediate on the server | New browsers blocked; every device that already unwrapped keeps working |

That last row is not a bug in the walkthrough. It is what “the key
*is* the person” means. Deprovision cannot un-sign history, and it
cannot reach a laptop that already has the secret.

So: **good as a login, bad as a key-distribution protocol.** That is
why this plan does not download the root. The CA pattern below is the
decision.

### Decision: root Agent as CA, session Agent as the cert

This is SSH user certificates / SPIFFE, not X.509 in the browser. The
root is the CA; the session key is a leaf. Genesis certs already
taught us compact Ed25519-signed blobs; SessionCert is the same idea
for Agents.

```text
IdP
  → node checks ID token
    → browser generates session keypair
      → node (holding the root) signs SessionCert {sessionPub, notAfter}
        → browser signs commits as the session Agent, attaches the cert
          → verifiers: session sig + cert sig + window + root’s rights
```

Important CA detail: the **browser** generates the session private
key. The node only signs the cert. If the node also generated the
session secret, it would be a signing oracle for that window (pattern
B).

Revoke = stop issuing, wait for TTL. XSS steals a key that expires.
New device = new session key, not another copy of the root. Node
compromise still lets the operator issue new certs (they have the
CA). It does not dump every laptop’s session key.

Draft PR #1275 (app keys) is the same shape for plugins. OIDC session
Agents are that primitive aimed at humans.

Root-key `GET /oidc/secret` is **not** the fallback to ship. Delay
OIDC until SessionCert verifies, or don’t do OIDC.

### What this is not

It is not “OIDC as Atomic AUTH.” Commits still need an Ed25519
signature. The OIDC token only authorizes **cert issuance**.

## Session tokens as signatures

A natural next idea: skip the Agent secret entirely for OIDC users and
let a session token (JWT) *be* the thing that signs writes.

That is how ordinary web apps work. It is not a small variant of
[How it works](#how-it-works). Commits today are Ed25519 over
deterministic JSON-AD; the public key *is* the signer DID; any replica
verifies with no issuer, no clock, no network
(`Commit::validate_signature`). Session tokens are the opposite:
bearer, expiring, issuer-bound, JWKS-bound.

Three ways to “let the token sign,” and what each actually changes:

### A. Put a JWT in `commit.signature`

Every verifier — this node, a phone on Iroh, a future replica, history
playback — must accept something that is not Ed25519.

Changes:

- `validate_signature` in Rust and TS, WASM, Flutter.
- Genesis: resource DIDs and genesis certs are Ed25519 signatures over
  a cert. A JWT cannot mint `did:ad:{sig}` without a new DID form.
- History: a commit lives forever; a JWT expires. Re-verifying a 2026
  commit in 2029 needs the IdP’s (or this node’s) JWKS **as of
  `createdAt`**, not today’s keys. You have to persist key history.
- Replay: a still-valid JWT stored on a commit *is* a bearer
  credential. Anyone who fetched history can use it until `exp`.
- Peers: a desktop that never talked to this IdP cannot verify unless
  it trusts this node as a CA and can reach JWKS.
- Offline: you cannot mint a JWT without the IdP. OIDC-only users
  become online-only writers. Sign-at-drain / outbox assume a local
  key.

You also get two classes of resource: self-verifying Agent-authored
ones, and issuer-bound session-authored ones that some replicas cannot
check.

### B. Token authorizes the *node* to sign as the user

Browser sends an unsigned patch plus the session cookie. The node
holds the Agent secret and signs the commit.

The commit log stays Ed25519. Peers verify as today. The token never
appears in history.

Changes:

- The node becomes a signing oracle — a principal it currently is not.
  `save()` is no longer local; every write needs this node.
- Offline and P2P catch-up from a device that only has a cookie: no
  writes.
- XSS or a stolen cookie can ask the node to sign until the session
  ends — no key in JS, but the node will sign whatever the session
  sends. Same blast radius as a session, which is the *point* of
  tokens, plus the node sees every plaintext patch.
- Contradicts “the client holds the key and signs.”

This is custodial *signing*, stronger (worse) than custodial *key
release*.

### C. Token mints a short-lived Ed25519 session agent

OIDC succeeds → browser generates a session keypair → node (holding
the root) signs a SessionCert. Commits stay Ed25519. `write` lists
still name the root. Verifiers chain session → cert → root.

Changes:

- New principal type (issued/session agent) and how rights inherit
  from the root Agent. Draft PR #1275 was the app-key version.
- Browser holds a key again, but it expires. XSS steals a bounded
  credential.
- Offline works until TTL, then you need OIDC again (or the root).
- Root can stay on the node. Deprovision = stop issuing, wait out TTL.

This is the **decision** — see
[Decision: root Agent as CA](#decision-root-agent-as-ca-session-agent-as-the-cert).

## Why the original flow cannot be copied

| 2022 step | Keep / change |
| --- | --- |
| OAuth client in AtomicServer `.env` | **Keep**, as the operator’s IdP (D2). Not a required third-party auth vendor |
| Front-end asks the server which providers it supports | **Keep**, via `GET /server`. No providers ⇒ no buttons |
| Client gets a token, server creates a user | **Change.** Node stores `(iss, sub) → root Agent`. Browser gets a SessionCert, not the root |
| Attach a public key to the Agent resource | **Drop.** Root DID is one key. Session is a new Agent + cert, not a keyring on the root |
| Store agent ↔ user on the server | **Keep as root envelope index**, not as the Agent resource |

The “endpoint for adding a new public key to an Agent” TODO on #277 is
obsolete in form. Device pairing shares the existing key.

Email as a way to *add keys* ([#276](https://github.com/ontola/atomic-server/issues/276))
is the same obsolete form. A session proof does not mutate the Agent
resource.

## What “Sign in with {IdP}” is allowed to do

Allowed:

1. One-click OIDC on a node that advertised providers.
2. Store the **root** Agent on this node, wrapped, never in JS.
3. After OIDC, sign a SessionCert for a **browser-generated** session
   pubkey. The session Agent signs commits and AUTH.
4. `write` lists name the root. Verifiers chain session → cert → root.
5. Optionally offer a passkey wrapper on the root envelope. Never
   require it for the OIDC button.

Forbidden:

1. Treat an OIDC token as proof of write on a Drive.
2. Put a JWT in `commit.signature`, or let the node sign content
   commits as the user.
3. Download the root Agent secret to the browser.
4. Derive keys from IdP claims (`sub`, email, ID token).
5. Show provider buttons on a node that has not configured an IdP.
6. Treat OIDC success as authorized-to-create on an Owner node, unless
   a separate enroll grant says so.

## Sequencing

Passkey-only restore (no IdP) and OIDC-only restore (custodial on this
node) are both “nothing to memorize.” They do not block each other.
Connector OAuth is a different product.

1. This decision (this file): SessionCert + root-as-CA.
2. Compact SessionCert (binary, genesis-cert family) and verify in
   `Commit::validate_signature` + AUTH (HTTP, WS, Iroh): signer may be
   a session Agent if the cert chains to a root with rights.
3. OIDC RP: env, `/server` advertisement, callback, `POST /oidc/session`
   issues the cert. HostMode enrollment unchanged. First-run UX is one
   button.
4. Optional passkey wrapper on the root, offered after login, not
   required.
5. Optional: IdP group / domain → authorized-to-create (Owner-mode
   expansion). Explicit flag, fail closed.
6. Connector OAuth on the node when the personal-information suite
   needs an always-on token holder.
7. App-key issued agents (PR #1275 shape) can share the SessionCert
   verifier. Not a blocker for OIDC.

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
- JWT in `commit.signature`
- Downloading the root Agent to JS
- Multi-public-key Agent resources (a session Agent is a new DID + cert,
  not a second key on the root resource)
- SCIM against `atomic-server` itself (the operator’s IdP is the directory)
- A hard-coded Google/GitHub client on nodes with no IdP configured
