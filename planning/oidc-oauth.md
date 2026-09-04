# OIDC / OAuth after DID and local-first

> **Status:** Proposal (2026-08). Reconsiders
> [#277](https://github.com/ontola/atomic-server/issues/277) (filed 2022-01
> against HTTP-origin Agents). Nothing in this file is implemented.
> Companion to
> [`encrypted-vault-format.md`](./encrypted-vault-format.md) (recovery
> envelope), [`device-pairing.md`](./device-pairing.md) (same key, many
> devices), [`foss-public-host-mode.md`](./foss-public-host-mode.md) (who may
> enroll a Drive),
> [`authorization-sync.md`](./authorization-sync.md) (auth checkpoints,
> delegation), [`genesis-self-verifying.md`](./genesis-self-verifying.md)
> (compact signed certs), and
> [`personal-information-suite.md`](./personal-information-suite.md)
> (connector OAuth).
>
> **Decision:** OIDC-only login mints a **session Agent** (short-lived
> Ed25519, private key in the browser) certified by a **root Agent** (CA,
> private key stays on this node). One click, nothing to memorize. Commits
> stay Ed25519. Not a JWT in `signature`, not root-key download.
>
> **Known weakness, on purpose:** the session cert window is checked
> against `createdAt`, which the signer chooses. A stolen session key is
> only bounded on live-ingest paths. See
> [Revocation and the `createdAt` problem](#revocation-and-the-createdat-problem).

## Goal

Decide, against the current identity model, whether this repo should speak
OIDC or OAuth, where that code would live, and what "Sign in with Google /
Okta / Keycloak" is allowed to mean.

The 2022 goal, *use an existing account, do not mint a new one*, is still
real. The 2022 mechanism (server-owned user record, extra public keys on an
HTTP Agent) is not: the Agent subject is now `did:ad:agent:{pubkey}`, the
key *is* the identity, and "creating an account" is generating a keypair
locally. There is no user record to attach a key to.

## What changed since 2022

| Then | Now |
| --- | --- |
| Agent subject is an HTTP URL on a server | `did:ad:agent:{pubkey}`. The key *is* the identity |
| Creating an account creates an Agent on that server | Creating an account generates a keypair locally. The personal-drive DID is derived from it |
| A new device registers another public key on the same Agent | A new device gets a **new session Agent**, certified by the same root. `write` lists still name the root |
| "Link agent to user" is a new table | Binding is `(iss, sub) → wrapped root Agent` on the node that configured the IdP |

Three layers, independent:

```text
Agent (root)    = long-lived Ed25519. The person. DID in `write` lists.
                  For OIDC-only users, the private key stays on this node.
Session Agent   = short-lived Ed25519. This browser. Signs commits and AUTH.
                  Certified by the root. Private key never leaves the device.
OIDC session    = proof to this node that it may issue a SessionCert.
                  Cannot sign a commit.
```

## Three problems that were one issue

1. **Protocol identity** (who may read or write). Answered: Agents are DIDs,
   writes are signed commits, reads are signed Authentication Resources. An
   OIDC access token is not an Atomic principal. Do not build a second,
   weaker auth stack next to Ed25519.
2. **Human login and recovery** (prove you are the same person on a new
   device, with nothing to memorize). This is what #277 wanted. OIDC-only
   restore is **custodial of the root, on purpose**: the node holds the root
   and, after a valid ID token, signs a cert for a pubkey the **browser**
   generated. Passkey + PRF is the other "nothing to memorize" restore and
   stays available on nodes with no IdP.
3. **Calling other companies' APIs** (Gmail, Calendar, Graph). OAuth as a
   connector. Orthogonal to identity; scoped in
   [`personal-information-suite.md`](./personal-information-suite.md). The
   Agent that signs the imported resources is the user's DID, not Google's
   `sub`.

A fourth, inverted problem is not #277: **this node as an OAuth
authorization server** ("Sign in *with Atomic*", closed draft PR #1275).
Same cert primitive, different product.

## Decisions

### D1. Commits and resource AUTH do not speak OIDC

`POST /commit`, resource `GET`/`PUT`, WS `AUTH`, and Iroh `AUTH` never
accept an OIDC token. The node **may** validate OIDC on dedicated
`/oidc/*` endpoints. That cookie is not `atomic_session`, never passes
`check_read` / `check_write`, and is only enough to ask the node to sign a
SessionCert for a browser-generated pubkey.

Invite JWTs ([#544](https://github.com/ontola/atomic-server/issues/544))
stay signed grant tokens, not user sessions.

### D2. Optional OIDC is a node feature, one IdP per node in v1

Configured by the operator, advertised on `GET /server` next to
`hostMode` / `acceptsNewDrives`. Absent config: no buttons, no IdP traffic,
no Google client id shipped by us. Suggested env (names not load-bearing):

```env
ATOMIC_OIDC_ISSUER=https://auth.example.edu
ATOMIC_OIDC_CLIENT_ID=...
ATOMIC_OIDC_CLIENT_SECRET=...        # node is the confidential client; PKCE still on
ATOMIC_OIDC_BUTTON_LABEL=Sign in with university
ATOMIC_OIDC_SESSION_TTL=24h          # SessionCert notAfter - notBefore
```

HostMode is unchanged. OIDC success does not let a stranger `createDrive`
on an Owner node; enrollment is still `ATOMIC_OWNER_AGENT` (or Open). A
later explicit flag can map an IdP group or `email_verified` + domain onto
authorized-to-create. Not implied by configuring an issuer.

### D3. Do not mint Agents from `sub`

`(iss, sub)` is the index key for a wrapped root, not an Agent subject, not
a `publicKey` on an Agent resource. Do not derive keys from IdP claims. The
root is minted once (browser or node, same custodial outcome), stored
wrapped on the node, and **never sent to the browser on the login path**.
After OIDC the browser mints a **session** keypair and the root signs a
SessionCert over it. That is a CA, not "add another key to the Agent".

`write` lists name the root. The session DID never appears in an ACL and
never gets an Agent resource.

### D4. SCIM is the IdP's job

The directory is the operator's IdP. `atomic-server` grows no user table.
Deprovisioning is "the IdP stops issuing tokens", so the node stops signing
certs. Existing certs live until `notAfter` (see
[After login](#after-login-what-an-oidc-user-can-and-cannot-do) for what
that means in practice).

### D5. Connector OAuth is not identity

Refresh tokens for Gmail or Calendar live on the always-on node (or a
plugin), never mixed with the OIDC session cookie. A Calendar refresh token
is not proof of who may read a Drive.

### D6. Export the root, then unlink OIDC

OIDC-only is a choice, not a trap. While signed in, Settings offers:

1. **Export identity.** Step-up OIDC (fresh ID token, not the cookie), then
   the node unwraps the root and shows the secret once. The client installs
   it as the live Agent; session certs become unnecessary. Audit it.
2. **Unlink {IdP}.** This `(iss, sub)` gets no more certs and the node
   **deletes its wrap** of the root, so a later disk theft cannot keep
   issuing as them.

Export before unlink; unlink without a copy is a lockout, and the UI says
so in one sentence. After unlink, "Sign in with Google" for that `sub` must
**not** mint a new root (identity split). Fail closed. Re-link is opt-in:
prove the root (sign a challenge) and complete OIDC.

Operator unsetting OIDC for the whole node is separate: warn first, since
anyone who never exported cannot open a new browser.

### Allowed and forbidden, in one place

Allowed: one-click OIDC on a node that advertised a provider; store the root
wrapped on this node; sign a SessionCert for a browser-generated pubkey;
rights on the root; optional passkey wrapper on the root envelope, never
required; export + unlink.

Forbidden: OIDC token as proof of write; JWT in `commit.signature`; the
node signing content commits as the user; root download as the login path;
keys derived from IdP claims; provider buttons on a node with no IdP;
OIDC success as authorized-to-create on an Owner node.

## How it works

Stock authorization-code OIDC. The node is the relying party (confidential
client, PKCE still used). The browser never sees the client secret. We do
not invent a flow; what we refuse is the *next* OAuth step, `Authorization:
Bearer` on `POST /commit`. A valid `id_token` is an authentication event
that we token-exchange (RFC 8693's idea) into an Ed25519 cert. Same cut as
SSH CAs, SPIRE, and cloud STS.

Two cookies, not interchangeable:

| Cookie | Minted by | Unlocks |
| --- | --- | --- |
| `atomic_oidc_session` | this node, after a valid ID token | "sign a SessionCert for this pubkey", export, unlink |
| `atomic_session` | the client, Ed25519 AUTH from the **session** Agent | resource `GET`, commits, WS. Today's AUTH |

0. **Operator** sets issuer, client id, secret, redirect
   (`https://<node>/oidc/callback`). On boot the node fetches
   `/.well-known/openid-configuration` and caches JWKS. Failure: boot, but
   advertise no providers.
1. **Welcome.** `GET /server` grows `oidcProviders: [{ label }]`. The
   welcome screen shows the button only when the array is non-empty.
2. **Start.** `GET /oidc/start` mints `state`, `nonce`, PKCE verifier, and
   302s to the IdP's `authorization_endpoint` with `scope=openid`.
3. **Callback.** `/oidc/callback?code&state`: check `state`, exchange
   `code` + verifier at the token endpoint, validate the ID token (JWKS,
   `iss`, `aud`, `nonce`, `exp`), read `(iss, sub)` (never email as the
   key), set httpOnly `atomic_oidc_session`, 302 back into the app. Failure
   is 401 and no cookie.
4. **Session.** The browser generates a session keypair and
   `POST /oidc/session { sessionPubKey }`. The node:
   - on first visit for this `(iss, sub)`, mints the root, wraps it with a
     node-held KEK, stores it; **and mints the personal Drive**, because
     `GenesisCert::private_drive_subject` signs with the root *private* key
     (`lib/src/genesis.rs`), which the browser does not have;
   - unwraps the root and signs a `SessionCert` over the session pubkey;
   - responds `{ sessionCert, rootDid, personalDrive }`.
   The browser keeps the session private key (IndexedDB, like today's
   agent), the cert, the root DID (public), and the personal-drive subject.
   It never derives the personal drive locally under OIDC.
5. **Signing is local.** Commits, resource GET, WS and Iroh AUTH are signed
   by the session Agent with the cert attached. The OIDC cookie is unused on
   those paths.
6. **Returning device / refresh.** Same cookie, same root. The browser
   always mints a **new** session keypair (new device, or refresh before
   `notAfter`) and calls `POST /oidc/session` again. The node can use its
   `refresh_token` to re-validate with the IdP without a redirect; when the
   OIDC cookie is gone it is one redirect, which is instant against a live
   IdP session.

The high-value endpoint is cert issuance, not root download. HTTPS-only,
short OIDC cookie, audit, rate limit.

## How an implementation checks signatures and rights

Today "who signed" and "who has rights" are the same DID.
`Commit::validate_signature` takes the pubkey out of `did:ad:agent:{pubkey}`
and verifies Ed25519 over deterministic JSON-AD; `hierarchy::check_write`
asks whether that same DID is in `write`; AUTH
(`get_agent_from_auth_values_and_check`) returns
`ForAgent::AgentSubject(signer)` and every transport consumes it. Session
keys split the two layers. One helper, used at every call site, or a
disposable session DID lands in an ACL and outlives its cert.

### The helper

```text
effective_agent(signer, cert, t) → ForAgent
```

| Input | Result |
| --- | --- |
| No cert (secret / passkey / exported root) | `ForAgent::AgentSubject(signer)`. Today's path, byte-identical |
| Cert present | `SessionCert::verify(cert, signer_pub, t)`; return `AgentSubject(did:ad:agent:{rootPub})` |

`t` is `commit.createdAt` on a commit and the AUTH timestamp on a live
request. `hierarchy::check_rights` does **not** grow a cert case; it keeps
comparing a DID to `read` / `write` / self.

### On the wire

**Commit.** New optional field, inside the signed JSON-AD so it is bound to
this mutation:

```text
signer      = did:ad:agent:{sessionPub}
signature   = Ed25519_session(canonical JSON-AD)     // unchanged
sessionCert = compact bytes (below), always inline    // 145 bytes, ~196 chars
```

Always inline, never "hash + the verifier already has it": history replay
in 2029 must verify without a side store.

**AUTH** (HTTP `x-atomic-*`, cookie, WS, Iroh `encode_auth`): today's four
fields plus `sessionCert`. `publicKey` / `agent` are the session key.

No IdP, no JWKS, no network at verify time. A replica that never spoke to
Google can accept the commit.

### SessionCert layout

Same family as genesis certs (`lib/src/genesis.rs`): version byte,
little-endian integers, fixed layout, golden vectors shared across Rust /
TS / WASM like `genesis_test_vectors.json`. Domain-separated by version so
a genesis cert cannot be replayed as a session cert.

```text
offset  size  field
0       1     version        0x01
1       32    sessionPubKey  Ed25519 raw
33      8     notBefore      i64 unix ms LE
41      8     notAfter       i64 unix ms LE
49      32    rootPubKey     Ed25519 raw
81      64    signature      Ed25519 by root over bytes [0, 81)
```

`SessionCert::verify(bytes, claimed_session_pub, t) → root DID`:

1. Decode; reject unknown version, truncation, trailing bytes.
2. `sessionPubKey` equals the claimed signer (compare decoded bytes, as
   `public_keys_match` does).
3. Ed25519 verify under `rootPubKey` over `[0, 81)`.
4. `notBefore <= t <= notAfter`.
5. Return `did:ad:agent:{base64url(rootPubKey)}`. No store lookup.

### Commit path (`lib/src/commit.rs`)

`validate_signature`: steps 1 and 2 unchanged (extract session pubkey,
verify Ed25519). New step 3: if `sessionCert` is present,
`SessionCert::verify(..., commit.created_at)`, fail closed. Absent: stop,
signer is the person.

`apply_commit` with `validate_rights` computes `effective` **once** and
uses it at all three sites that read `commit.signer` today:

- `check_append` / `check_write` via `validate_for_agent`.
- The genesis `write`-list insert, which today pushes `signer_str`
  regardless of `validate_for_agent`. It must push the **root**, or every
  OIDC browser leaves a dead session DID in every document it creates.
- The `NotEnrolled` branch that builds
  `ForAgent::AgentSubject(commit.signer)` for `may_enroll_drive`.

`commit.signer` stays the session DID on the stored Commit resource (which
device signed). `createdBy`, implicit creator, and personal-drive derivation
use `effective`. `sync::engine` sets `validate_for_agent` to the root and
**does not** auto-create an Agent resource for the session DID.

### AUTH path (`lib/src/authentication.rs`)

`check_auth_signature` and timestamp freshness (`ACCEPTABLE_TIME_DIFFERENCE`)
are unchanged. `get_agent_from_auth_values_and_check` still requires the
header pubkey to match `agent`; then, if `sessionCert` is present, verifies
with `t = auth.timestamp` and returns the **root**. HTTP GET
(`server/src/helpers.rs`), the `atomic_session` cookie, WS `AUTHENTICATE`,
`sync::engine::handle_frame`, and the peer auth-back in `sync::peer` all
call this one function, so every transport inherits the remap.

Iroh rights are already per-subject: `sync::peer` says a peer's identity is
"`check_read`'s answer, per subject, not whether they are us", and
`sync::engine` says the commit signature, not the connection's AUTH, is the
gate. So two OIDC devices with different session keys sync as today once
AUTH returns the root. The one same-agent assumption left is
`own_agent_update_frame`, which sends the local Agent resource so both
devices merge it under "Agents can always edit themselves". Under OIDC that
frame must carry the **root** Agent resource, not a session stub, and the
client keeps two notions: *who I am* (root DID, no private key) and *what I
sign with* (session).

### Who is checked against what

| Question | Function | Principal |
| --- | --- | --- |
| Did this key sign these bytes? | `validate_signature` / `check_auth_signature` | Session pubkey |
| Is this cert a live delegation? | `SessionCert::verify` | Root pubkey (issuer) |
| May they read / write? | `check_read` / `check_write` | **Root** DID |
| May they enroll a Drive? | `admit_drive_write` / `may_enroll_drive` | **Root** DID |
| Whose home is this? | `GenesisCert::private_drive_subject` | **Root** key, on the node |
| Who shows up as author? | `createdBy` | **Root** DID |

### Dual-accept and old replicas

No `sessionCert`: byte-identical to today. A commit **with** the field is a
protocol bump: `Commit::from_resource` reads named properties only, so an
old verifier re-serializes without `sessionCert` and the signature fails.
That is fail-closed. Do not move the cert to an unsigned envelope to "stay
compatible"; a stripped cert makes the session DID look like a stranger.

### Tests that pin this (cheapest that can fail)

Rust vectors, no server:

- Session sig + valid cert + root in `write` → apply.
- Same commit, root not in `write` → reject (rights, not sig).
- `createdAt` outside `[notBefore, notAfter]` → reject.
- Cert `sessionPub` ≠ `commit.signer` → reject.
- Genesis inserts the **root** into `write`, never the session DID.
- No cert → today's `validate_signature` still passes.
- AUTH with cert returns the root; without, the signer.
- Live ingest with `now > notAfter + skew` → reject (next section).

Server: mock IdP for code → cert; export step-up; unlink then Google does
not mint a second root; first visit returns a personal-drive subject that
matches what the root would derive.

## Revocation and the `createdAt` problem

The cert window is checked against `commit.createdAt`, and the signer
chooses `createdAt`. The only timestamp check in the codebase rejects
**future** stamps; nothing rejects an old one:

```text
lib/src/utils.rs      check_timestamp_in_past: errors only if timestamp > now + 10s
lib/src/sync/ws_apply validate_timestamp: false on replica ingest
```

`validate_previous_commit` is off everywhere
([#412](https://github.com/ontola/atomic-server/issues/412)). So without a
further rule, someone who exfiltrates a session key a month after
`notAfter` backdates `createdAt` into the window and every replica accepts
the commit, forever, as the root. On the commit path a leaked session key
would then be as bad as a leaked root, minus cert issuance. "Short TTL is
the revoke" is only true for AUTH, whose timestamp is freshness-checked.

We cannot use wall-clock against `createdAt` on replay, or valid history
would rot after `notAfter`. What v1 does:

1. **Live-ingest bound.** Every path that runs `validate_timestamp` (HTTP
   `POST /commit`, WS `COMMIT`, Iroh `COMMIT`) also requires
   `now <= notAfter + ACCEPTABLE_TIME_DIFFERENCE` when a cert is present.
   The sending browser is online at drain time, so an honest client is
   never hit by this. A stolen key stops working on those paths at
   `notAfter`.
2. **Replay and catch-up stay exposed.** `sync::ws_apply` replica ingest and
   Iroh `SYNC_PUSH` catch-up skip `validate_timestamp` by design, so a
   backdated commit could enter through a peer that accepts it without the
   bound. State this in the threat model; do not claim the credential is
   bounded there.
3. **Real fix, follow-up.** The auth checkpoints
   [`authorization-sync.md`](./authorization-sync.md) already wants: a node
   that accepted a session-signed commit live countersigns a receipt, and
   replay verifiers require that receipt for any cert-signed commit. Until
   then, an OIDC user's drives should sync via nodes that run the
   live-ingest bound, which the phasing below arranges (HTTP/WS first).

**TTL.** `ATOMIC_OIDC_SESSION_TTL` default **24 hours**. The client
refreshes on app open when less than half the window remains, using the
OIDC cookie (30 days) or the node's refresh token, so a daily user never
sees a redirect. Offline editing is unaffected: the browser signs at drain
time (`browser/lib/src/local-outbox.ts`), and drain requires being online,
which is when refresh happens. A cert that expired while offline costs one
refresh before the first drain, never lost edits. Operators who need faster
deprovisioning set hours; the cost is more refresh calls, not more
redirects.

No CRL in v1. Revoke is "stop issuing, wait out the TTL", plus the bound
above. Deprovision does not phone the IdP at verify time.

## Threat model, plainly

The login is conventional: "sign in with the company IdP, nothing else to
memorize" is how password-manager SSO, Vault unwrap-after-OIDC, and
"Sign in with Google" wallets work. The thing we hand the browser is where
the danger lives, so the comparison is between three ways to do that.

| Event | A. JWT in `signature` | B. Node signs as user | **C. Root as CA (chosen)** | Root download (rejected) |
| --- | --- | --- | --- | --- |
| Stolen session cookie / XSS | Bearer until `exp`, replayable from history | Node signs whatever the session sends | Session key, bounded on live paths (above) | Root **forever** |
| IdP admin impersonates | Gets a session | Gets signing | Gets certs until noticed; node audit shows it | Downloads the root |
| **Node disk + KEK stolen** | n/a | Every root leaks | **Every OIDC user's root leaks, permanently.** Roots cannot rotate | Same |
| Deprovision in the IdP | Server-side | Server-side | New certs stop; issued certs live to `notAfter` | Every device that unwrapped keeps working |
| Offline writes | Impossible (needs IdP) | Impossible (needs node) | Until drain; refresh at drain | Yes |
| Old replica verifies 2026 commit in 2029 | Needs JWKS as of then | Fine | Fine, cert is inline | Fine |

Row three is the custodial bargain and it applies to the chosen design as
much as to the rejected one: the node holds every OIDC user's root, and an
Ed25519 Agent key can never be rotated (`SecretEnvelope` already treats
that as load-bearing). Node compromise is not "the operator can issue
certs"; it is permanent identity theft for every user who never exported.
Mitigations are operational (KEK in an OS keystore or KMS, audit on
unwrap) and the D6 exit. Users who care more than that use a passkey or a
secret; that is what those paths are for.

What C fixes relative to root download is every **client-side** row: a
stolen browser credential expires, deprovision reaches new devices, and a
compromised node does not also dump every laptop's key. Important detail:
the **browser** generates the session private key. If the node generated
it, the node would be a signing oracle for that window (B in disguise).

A and B are rejected for the reasons in the table plus one each: A makes
every verifier (Rust, TS, WASM, Flutter, history playback) accept
something that is not Ed25519 and cannot mint `did:ad:{sig}`; B makes
`save()` non-local and contradicts "the client holds the key and signs".

## After login: what an OIDC user can and cannot do

The button delivers the #277 ask: one click, nothing to save, new device
with nothing to transfer, lost laptop means sign in again. The gaps are one
layer up, and a team that adopts this because of SSO will hit the first one
in the first hour.

| Expectation | v1 | Follow-up |
| --- | --- | --- |
| Share with a coworker by name or email | **No.** ACLs hold root DIDs, which are opaque. Sharing is an **invite link** (`ShareDialog` → Create Invite), which OIDC users can create and redeem like anyone else | Email-to-root lookup on the node that holds `(iss, sub)`, and pending grants keyed on a verified email that resolve when that person first signs in. Group grants after that |
| Admin removes me, access ends now | Reads and writes end at `notAfter` (24h default); new certs stop immediately | Auth checkpoints (previous section) shorten the write side; a CRL if operators ask |
| My Google account is me on every node | **No.** The root lives on the node that ran the flow. The same Google account on a second node mints a second identity | Keep 1:1 per node. Cross-node is device pairing or export |
| Offline editing keeps working | Yes. Sign-at-drain means the cert only matters when online | |
| Same button in the Flutter app | **Later.** HTTP/WS first | Same session key + cert on mobile |
| Use my OIDC token to call the API from a script | **No, by design** (D1) | Issued app keys, PR #1275 shape, share the cert verifier |
| Several IdPs on one node (Google + GitHub + Apple) | **No.** One issuer per node | A list, if consumer nodes need it |

Say the first row in the changelog and the welcome screen, not only here.

## How an operator sets up OAuth

End users set up nothing. The operator registers a client at the IdP and
points the node at it.

**Google.** Cloud Console → Credentials → OAuth client ID → Web
application. Authorized redirect URI `https://<your-domain>/oidc/callback`
(localhost: the port you actually serve, exact match). Consent screen:
Internal for Workspace, External otherwise. Then:

```env
ATOMIC_OIDC_ISSUER=https://accounts.google.com
ATOMIC_OIDC_CLIENT_ID=….apps.googleusercontent.com
ATOMIC_OIDC_CLIENT_SECRET=…
ATOMIC_OIDC_BUTTON_LABEL=Sign in with Google
```

Restart. `GET /server` lists the label; the welcome screen shows the
button. Google is a normal OIDC issuer; no Google SDK.

**Keycloak / Authentik / Entra / any OIDC.** Confidential client,
authorization code, same redirect. `ATOMIC_OIDC_ISSUER` is the realm's
issuer URL as it appears in discovery, not the admin UI home.

**Turning it off.** Unset the env, restart. Buttons vanish, no new certs.
Users who never exported cannot open a new browser, so warn first.

## Sequencing and impact

Absent IdP config, **nothing changes**. With config, the OIDC dance is
ordinary Actix plus an OIDC crate; the costly part is SessionCert in the
write path, comparable to genesis certs (new compact blob, dual-accept in
`validate_signature`) plus a relying party. Not "add a login button".

1. This decision.
2. `SessionCert` + `effective_agent` in `validate_signature`,
   `apply_commit` (all three signer sites), and
   `get_agent_from_auth_values_and_check`. Live-ingest `notAfter` bound.
   Golden vectors.
3. Relying party on the node: env, `/server` advertisement, `/oidc/start`,
   `/oidc/callback`, `POST /oidc/session` (mints root and personal drive on
   first visit, issues cert). Persist `(iss, sub) → wrapped root` in
   PluginMeta or a small tree.
4. Browser: provider button in `GettingStartedFlow`; session key + cert +
   root DID + personal drive in IDB; attach cert on drain; Settings export +
   unlink. Sign-out drops the session key; the root was never there.
5. **Export + unlink** (D6) ships with v1 so OIDC is reversible.
6. Auth-checkpoint receipts for cert-signed commits, then Iroh catch-up for
   OIDC users. Flutter same session key + cert.
7. Optional: passkey wrapper on the root; IdP group / domain →
   authorized-to-create (explicit flag, fail closed); email-to-root lookup
   for sharing; connector OAuth when the personal-information suite needs
   an always-on token holder.

| Layer | Size |
| --- | --- |
| Protocol | Medium-hard. New cert blob + verify; AUTH identity becomes a chain |
| Server RP | Medium. Standard authorization code; wrapped roots; export/unlink |
| Browser | Medium. Button, session key in IDB, cert on drain, Settings exit |
| Flutter / Iroh catch-up | Later |
| Tests | Cheap: cert vectors. Expensive: one Playwright mock-IdP journey |

## Open questions

1. **One IdP user, several Agents.** 1:1 for v1. Extra identities stay
   local and unbound.
2. **Solid WebID-OIDC interop.** A mapping layer, not "Atomic speaks OIDC on
   every GET". Out of scope.
3. **Receipt format** for the auth-checkpoint fix. Belongs in
   [`authorization-sync.md`](./authorization-sync.md).

## What not to open as follow-up

- OIDC tokens on `POST /commit` or resource `GET`
- JWT in `commit.signature`
- Downloading the root Agent to JS as the login path
- Multi-public-key Agent resources
- SCIM against `atomic-server` itself
- A hard-coded Google/GitHub client on nodes with no IdP configured
