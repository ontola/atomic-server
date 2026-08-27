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
>
> **OIDC-only login:** people who pick “Sign in with {IdP}” must not also
> have to remember a recovery code or register a passkey. Completing OIDC
> is the credential. That makes this node custodial for that identity —
> say so, don’t hide it behind a second factor the user didn’t ask for.

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
| A new device registers another public key on the same Agent | A new device gets the **same** secret: passkey unwrap, or OIDC-only release from this node. Same-agent AUTH is the trust gate |
| The server is the identity provider of last resort | Commits are still client-signed. OIDC-only restore means this node can unwrap the signing key after a valid IdP login |
| “Link agent ↔ user” is a new table | Binding is `(iss, sub) → wrapped agent secret` on the node that configured the IdP |

Two layers, independent:

```text
Agent   = Ed25519 keypair. Signs commits, HTTP, WS AUTH, Iroh AUTH.
          Lives in the client after login.
Session = OIDC proof to this node. Enough, by itself, to release that
          Agent secret to the client. Cannot be sent as resource AUTH.
```

OIDC never becomes the Agent. It is allowed to **release** the Agent
secret. That is the whole product.

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

OIDC-only is custodial on purpose. The node holds a wrapping key,
unwraps after a valid ID token, and hands the Agent secret to the
client. Do not derive the secret from IdP claims (`sub` is public; ID
tokens get logged). Do not make the user also unwrap.

A passkey or recovery wrapper on the same envelope is **optional** —
useful if this node dies — not part of the OIDC path. Passkey-only
onboarding (no IdP) stays the restore for nodes that never configured
one.

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
| **OIDC relying party** | Validate an ID token; release the Agent secret for `(iss, sub)` | Treat the token as `x-atomic-*`; HKDF the secret from `sub` |
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
`check_write`. It **is** enough to release the Agent secret for that
`(iss, sub)` — see D2.

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

The client still mints the Ed25519 key on first visit. The node does
not generate it, and does not derive it from IdP claims. After that,
the node *holds a wrapping key* so OIDC-only restore works. Holding
is not minting, and it is not signing: the client still signs every
commit. The operator of this node could unwrap and sign if they
chose; that is the custodial bargain, not a protocol change.

Multi-device is the same secret released again, not a second key on
the Agent.

### D4. SCIM is the IdP’s job

[#277](https://github.com/ontola/atomic-server/issues/277) asked about
[SCIM](https://scim.cloud/). The directory is the operator’s IdP.
`atomic-server` does not grow a user table to SCIM into. Deprovisioning
is “the IdP no longer issues tokens,” so the node refuses to release
the secret. A device that already has the key keeps working until that
copy is deleted. Historical commits stay valid.

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
| `atomic_oidc_session` | this node, after a valid ID token | release of that user’s Agent secret |
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

### 4a. First visit (no secret stored yet)

`GET /oidc/secret` under that cookie returns 404. The app mints Ed25519
locally (the user never sees it), then `PUT /oidc/secret` with the
agent secret JSON. The node wraps it with a **node-held KEK**
(`WrapperKind` to add next to the existing passkey / recovery wrappers
in `lib/src/vault/secret_envelope.rs`) and stores the envelope keyed
by `(iss, sub)`. Then the client builds `atomic_session` as today.

No recovery code, no passkey prompt, nothing to copy. OIDC was the
login.

The node sees plaintext at PUT and at later release. At rest the
secret is wrapped. Disk theft of the redb without the node KEK does
not yield signing keys; the operator who holds the KEK can unwrap
without OIDC. That is inherent to OIDC-only. Do not paper over it
with a client-side factor the user didn’t ask for.

### 4b. Returning device

`GET /oidc/secret` unwraps on the node and returns the agent secret
over HTTPS. The app `saveAgentToIDB`, builds `atomic_session`. Same
Agent as the first device. No second prompt.

This endpoint is the whole prize: no-cache, httpOnly cookie, short
TTL, audit log, rate limit. It is “download my signing key after SSO,”
and it is dangerous for the reasons in
[Is this a good pattern?](#is-this-a-good-pattern). A session/issued
agent with TTL is the same button with a bounded blast radius.

### 5. After that, Atomic is unchanged

Commits, resource GET, WS, Iroh AUTH are the Ed25519 Agent. The OIDC
cookie is unused on those paths. Signing out of the Agent clears
`atomic_session` as today. An explicit “disconnect this node login”
drops `atomic_oidc_session` so a shared browser cannot release the
secret again.

### Optional extra wrappers (not on the OIDC path)

The same envelope *may* also carry a passkey or recovery wrapper so
the identity survives this node dying. The OIDC button must not
require them. Showing “also save a passkey” after first login is
fine; blocking login until they do is not.

### Deprovision

The operator removes the person in the IdP. The next `/oidc/start`
fails at the IdP, so a new browser cannot get the secret. A device
that already unwrapped keeps working until that copy is deleted —
same as a copied secret JSON. Historical commits stay valid.

### Owner mode

After the client has the Agent, `createDrive` is still
`admit_drive_write`. On an Owner node that means the Agent DID must
be `ATOMIC_OWNER_AGENT`. OIDC success is not a Drive grant.

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

So: **good as a login, bad as a key-distribution protocol.** Shipping
the root Agent to JS after SSO is the social-login-wallet pattern.
Security engineers dislike it for the table above; product engineers
ship it because the UX is what people wanted. Both reads are true.

### The less dangerous sibling (same UX)

Keep the one-click OIDC button. Do **not** give the browser the root
secret.

```text
IdP
  → node checks ID token
    → node (holding the root Agent) mints a short-lived device/session
      key — an issued agent with TTL and scoped rights
      → browser signs as that session agent
        → root never leaves the node (ideally: node KEK in OS keyring / HSM)
```

Revoke = stop issuing, wait for TTL. XSS steals a key that expires.
New device = new session key, not another copy of the root. This is
how SSH certificates, SPIFFE, and cloud IAM already work. It needs
issued/session agents as a real protocol object (draft PR #1275 was
the app-key version of the same shape). Until that exists, OIDC-only
has to choose: delay the feature, or accept root-key release and the
table above.

v1 in [How it works](#how-it-works) still describes root-key release
because it is implementable on today’s Agent. It is not the shape we
should be proud of. Prefer session keys if that work lands first; if
we ship root release anyway, the endpoint is a key-exfiltration API
and must be treated like one (HTTPS-only, no cache, short cookie TTL,
audit, rate limit, no derive-from-`sub`).

### What this is not

It is not “OIDC as Atomic AUTH.” Commits still need an Ed25519
signature. The danger is **custody of that key**, not a second auth
stack on `GET`.

## Why the original flow cannot be copied

| 2022 step | Keep / change |
| --- | --- |
| OAuth client in AtomicServer `.env` | **Keep**, as the operator’s IdP (D2). Not a required third-party auth vendor |
| Front-end asks the server which providers it supports | **Keep**, via `GET /server`. No providers ⇒ no buttons |
| Client gets a token, server creates a user | **Change.** Client mints the Agent. Node stores `(iss, sub) → secret`, wrapped with a node-held KEK, and releases it after OIDC |
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
2. On first visit, mint the Agent locally and store it on this node
   under `(iss, sub)`, wrapped with a node-held KEK.
3. On later visits, **release that Agent secret** to the client with
   no other prompt.
4. Show provider buttons on the welcome screen **of a node that
   advertised providers**.
5. Optionally offer a passkey/recovery wrapper on the same envelope.
   Never require it for the OIDC button to succeed.

Forbidden:

1. Treat an OIDC token as proof of write on a Drive.
2. Let the IdP or the node sign commits, Iroh `AUTH`, or
   HTTP `x-atomic-*` headers. The client signs. The node may *hold*
   the key; it must not use it as a principal.
3. Derive the agent secret from IdP claims (`sub`, email, ID token).
4. Show provider buttons on a node that has not configured an IdP
   (never ship a built-in Google client to random origins).
5. Treat OIDC success as authorized-to-create on an Owner node, unless
   a separate enroll grant says so.

## Sequencing

Passkey-only restore (no IdP) and OIDC-only restore (custodial on this
node) are both “nothing to memorize.” They do not block each other.
Connector OAuth is a different product.

1. This decision (this file).
2. **Prefer session/issued agents** if that protocol work is available:
   OIDC mints a TTL key; root stays on the node. Same one-click UX.
3. Else **OIDC relying party + root-key release** (the walkthrough):
   env, `/server`, callback, node-held KEK, `GET /oidc/secret`. Treat
   that endpoint as key exfiltration. HostMode enrollment unchanged.
   First-run UX is one button.
3. Optional extra wrappers (passkey / recovery) on the same envelope,
   offered after login, not required.
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
