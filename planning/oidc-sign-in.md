# Optional OIDC sign-in for self-hosted servers

Status: landed on `claude/277-oidc` (server, front-end, docs). Open: Playwright e2e in the shared e2e server (see checklist).
Issue: ontola/atomic-server#277 "Consider supporting OIDC / SSO / OAuth".

## Goal and non-goals

An operator points a self-hosted AtomicServer at an OIDC provider (Entra ID,
Keycloak, Google, a DigiD/eHerkenning broker). People sign in with that
existing account instead of inventing one, **while the browser still holds the
private key that signs commits**. The server never holds an agent secret.

Non-goals, all deliberate:

- Off unless `ATOMIC_OIDC_ISSUER` is set. With it unset no route answers, `/server`
  advertises nothing, and the sign-in screen is byte-for-byte what it was.
- FOSS only. Nothing here imports, calls or names `atomic-saas`. The hosted
  portal keeps its own Google/Apple/GitHub sign-in and its "proven links only"
  rule; this feature neither shares code with it nor changes
  `GettingStartedFlow`'s account paths. The button is a separate component
  mounted behind a capability check.
- No server-side session, cookie login or JWT bearer auth. Requests are still
  authorised only by signed agent requests/commits. An OIDC proof authorises
  exactly the three things listed under "What a proof allows".

## What exists today (checked against the code)

- No JWT/OIDC code anywhere in `server/src` or `lib/src` (`grep -rniE
  'jwt|oidc|jsonwebtoken|openidconnect'` is empty). The #277 TODO items "endpoint
  to add a public key to an Agent" and "JWT support" are **not** in `develop`.
- **An agent's identity is its public key**: `did:ad:agent:{publicKey}`
  (`identifiers::agent_subject`), and signature checks derive the key from the
  subject. So **multi-key agents do not exist**, and "register an additional
  public key for the same Agent" is not possible without a protocol change
  (every rights check, ACL, commit `signer` and DID would need an alias layer).
  That is out of scope for an optional login feature.
- Smallest honest substitute: the *same* private key travels to the new device
  as a **client-side encrypted recovery blob** that the server stores next to the
  OIDC link and releases only to someone who can prove the same `(issuer, sub)`.
  The blob is encrypted in the browser under a recovery passphrase the server
  never sees (PBKDF2-SHA256 + AES-GCM, the same primitives the recovery code
  path already uses). The server stores opaque bytes; it can neither read the
  key nor sign as the user. A stolen database plus a compromised IdP still needs
  the passphrase (offline guessing is bounded by PBKDF2 cost: say so in the UI).
- Non-resource storage precedent: `Tree::PluginMeta` with a key prefix is
  already shared by search (`pending:`), vault sync and the node id. The link
  store uses the prefix `oidc/v1/link/` there, so **no `Tree` variant, no lib
  or WASM change, no migration**.
- Advertising precedent: `/server` (`plugins/server_info.rs`) already carries
  `hostMode`, `acceptsNewDrives`, `homeDrive` via `set_unsafe`. OIDC adds one
  optional property `oidcProviderName` (absent when off). The front-end reads
  it the way `managedServer.ts` reads the others.

## Configuration

All optional except the first three, which must come together (startup fails
with a clear error if only some are set). CLI flag / env var:

| Flag / env | Meaning |
| --- | --- |
| `--oidc-issuer` `ATOMIC_OIDC_ISSUER` | Issuer URL. Discovery is `{issuer}/.well-known/openid-configuration`. Must be `https://` (plain `http://` only for loopback hosts, which keeps tests and local Keycloak workable). |
| `--oidc-client-id` `ATOMIC_OIDC_CLIENT_ID` | OAuth client id. |
| `--oidc-client-secret` `ATOMIC_OIDC_CLIENT_SECRET` | Optional. Without one the client is public and relies on PKCE alone. Redacting `Debug`; never logged. |
| `--oidc-name` `ATOMIC_OIDC_NAME` | Text for the button ("Sign in with {name}"). Default: the issuer's host. |
| `--oidc-scopes` `ATOMIC_OIDC_SCOPES` | Default `openid email profile`. `openid` is forced. |
| `--oidc-redirect-url` `ATOMIC_OIDC_REDIRECT_URL` | Registered redirect URI. Default `{server origin}/oidc/callback` (from `ATOMIC_DOMAIN`, https flag, port). Set it behind a proxy/tunnel. |
| `--oidc-allowed-email-domains` `ATOMIC_OIDC_ALLOWED_EMAIL_DOMAINS` | Comma list. When set the ID token needs `email` with `email_verified != false` and a matching domain. |
| `--oidc-required-claim` `ATOMIC_OIDC_REQUIRED_CLAIMS` | Repeatable / comma list of `name=value`. Claim must equal the value or, if an array (`groups`, `roles`), contain it. |

Email and claims are **admission policy only**. They never name or find an
identity (see account takeover below).

## Flow

Authorization code + PKCE (S256) + `state` + `nonce`, all server side.

1. `GET /oidc/start?return=/some/path`
   - `return` is validated (below) and kept server side.
   - Server fetches (and caches 1 h, refreshes on `kid` miss at most once per
     minute) the discovery document and checks its `issuer` equals the
     configured one exactly, and that `authorization_endpoint`,
     `token_endpoint`, `jwks_uri` are `https` (or loopback `http`).
   - Generates `state` (32 random bytes), `nonce`, PKCE verifier and a browser
     binding secret. Stores them in an in-memory map (TTL 10 min, capped at
     10 000 entries, single use). Sets cookie `atomic_oidc=<binding>`
     (`HttpOnly; SameSite=Lax; Secure` when https; `Path=/oidc`; 10 min).
   - 302 to the authorization endpoint with
     `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`,
     `nonce`, `code_challenge`, `code_challenge_method=S256`.
2. `GET /oidc/callback?code&state` (or `error`)
   - Look up and remove `state` (replay/unknown: reject). Compare the cookie
     with the stored binding in constant time (login CSRF: an attacker cannot
     make a victim finish the attacker's login). Clear the cookie.
   - Back-channel `POST token_endpoint` (`grant_type=authorization_code`,
     `code`, `redirect_uri`, `code_verifier`; `client_secret_basic` if a secret
     is set and the provider lists it or lists nothing, else `client_secret_post`).
     Timeout 10 s, response body capped at 256 KiB, no redirects followed.
   - Validate the `id_token` (module `oidc::jose`, ring only, no new crate):
     - JOSE header `alg` must be on the allowlist `RS256`, `PS256`, `ES256`.
       `none`, `HS*` and anything else are refused. `kid` selects the JWKS key;
       the key's `kty`/`crv` must match `alg` (no algorithm confusion).
     - Signature verified against the cached JWKS (`jwks_uri`, 1 h cache, one
       forced refresh on unknown `kid`).
     - `iss` equals the configured issuer exactly; `aud` contains the client
       id (and if `aud` has more than one entry, `azp` must equal the client id);
       `exp` in the future and `iat`/`nbf` not in the future, 60 s skew;
       `nonce` equals the stored nonce (constant time); `sub` present, non-empty,
       at most 255 bytes.
     - Then the policy checks (email domain, required claims).
   - The `access_token` and `userinfo` are not used. Discarded unlogged.
   - Mint a **proof ticket**: 32 random bytes, base64url, held in memory with
     `(issuer, sub, email?)`, TTL 5 min, at most 20 uses.
   - 302 to `return#oidc_ticket=<ticket>`. A URL fragment is not sent to any
     server, proxy or log, and the front-end removes it from the address bar
     with `history.replaceState` before doing anything else. Failures redirect
     to `return#oidc_error=<code>` with a fixed code set
     (`denied`, `expired`, `policy`, `provider`), never provider text.
3. `POST /oidc/session` `{ticket}` returns `{linked:false}` or
   `{linked:true, agent, recovery}`. It does not consume the ticket.
4. `POST /oidc/link` `{ticket, agent, signature, recovery, replace?}`
   - `signature` is the agent's Ed25519 signature over the possession
     message below.
   - Server checks the signature with the public key inside the agent DID, so
     nobody can link an agent they cannot sign for.
   - `recovery` is the opaque blob (at most 4 KiB).
   - If `(issuer, sub)` is already linked: `409` unless `replace: true`
     (the explicit "I lost the passphrase, start over" path; the old data stays
     reachable only to someone who still has the old key).
   - Consumes the ticket.
5. `DELETE /oidc/link` `{ticket}` removes the link (a fresh sign-in is required,
   so a leaked session on an unlocked laptop cannot do it silently).

Possession message: `atomic-oidc-link:v1:` + `{ticket}` + `:` + `{agent DID}`.
The ticket is unguessable and single-use for linking, so the signature cannot
be replayed for another identity or by another ticket.

### Link store

`Tree::PluginMeta`, key `oidc/v1/link/{hex(sha256(issuer + 0x00 + sub))}`, JSON
value `{agent, recovery, createdAt, updatedAt}`. The hash keeps `sub` (which can
be a long or personal string) out of key listings. Email is not stored. The
stored record is the whole feature's persistent state; deleting the prefix
turns it off cleanly.

## What a proof allows

1. Link an agent the caller can sign for, to the proven identity.
2. Receive that identity's recovery blob (then decrypt with the passphrase and
   store the agent on the new device).
3. Replace or delete the link.

It does **not** create a server session, grant drive rights, bypass
`ATOMIC_OWNER_AGENT`/host-mode admission, or stand in for a commit signature.
First sign-in on an unlinked identity: the browser generates a fresh agent (or
adopts the one already on the device), asks for a recovery passphrase, links.
Joining a drive on a gated server stays governed by the existing invite and
admission rules.

## Security review

| Item | Decision |
| --- | --- |
| Open redirect via `return` | Accept only a same-origin relative path: starts with a single `/`, not `//`, no `\`, no control chars, no scheme, parsed against the server origin and must stay on it; otherwise `/`. Only the validated path is ever echoed into `Location`. |
| CSRF / login CSRF | `state` (single use, 10 min) plus the `HttpOnly` binding cookie checked in constant time. |
| Replay | `state`, `nonce`, auth code (provider side), and ticket (TTL, use cap, consumed on link) are single purpose. |
| PKCE | S256 always, even with a client secret. |
| Account takeover via email reuse | Identity is `(issuer, sub)` only. Email is never a key or a lookup; changing an email at the IdP, or an IdP that recycles addresses, cannot reach another user's link. `email_verified: false` fails the domain policy. Multi-tenant issuers: configure the tenant-specific issuer URL (Entra `https://login.microsoftonline.com/{tenant}/v2.0`), never `common`; the discovery `issuer` equality check rejects the `{tenantid}` template. |
| Token leakage | ID/access tokens, codes, state, nonce, verifier, tickets and the client secret are never put in `tracing` fields or error text. `instrument(skip_all)` on handlers; request URLs with query are not logged by us. Ticket travels in the fragment. `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on all `/oidc/*` responses. |
| Alg confusion / `none` | Allowlist + key type must match; keys come only from the configured `jwks_uri`. |
| SSRF | The only outbound URLs are those in the discovery document of the operator-configured issuer, https (or loopback http for dev), no redirects, timeouts, size caps. No URL comes from a request. |
| Brute force on the recovery blob | Blob is released only after a valid proof; the passphrase KDF is the offline cost. UI states that a weak passphrase weakens this. Ticket use is capped. |
| DoS | Pending-state and ticket maps are capped and expire. Callback/start sit behind the existing per-IP anonymous rate limiter. |
| Server holds no secrets | Server stores only a client-encrypted blob; it never sees agent secret or passphrase. |
| Cookie scope | Binding cookie is `Path=/oidc`, never readable by JS. |

## Threats not mitigated (accepted)

- A compromised or malicious IdP can impersonate any user *to the link store*
  (obtain their blob, replace a link). It cannot sign as them. This is the trust
  the operator opts into by choosing the provider.
- Phishing of the recovery passphrase.
- An operator with database access can delete or overwrite links (denial, not
  impersonation).
- Pending logins in memory are lost on restart (the user retries).

## Decisions for Joep

1. **No new crate: JWT verification on `ring`** (RS256/PS256/ES256, ~200 lines
   plus tests) instead of `openidconnect`. Reason: zero new dependencies and
   build time, and `openidconnect` pulls `rsa` (RUSTSEC-2023-0071, Marvin) and a
   second HTTP stack. Cost: we own a small, test-covered verifier. Swap to
   `openidconnect` if you prefer a maintained surface over a small footprint.
2. **No additional key per agent.** Impossible with today's DID-is-the-key model.
   Chose the client-encrypted recovery blob. A real "second key" needs an alias
   layer in rights/commit verification and is a separate RFC.
3. **Recovery passphrase is required** when linking (the blob is useless without
   it, and a blob the server could decrypt would mean the server holds the key).
4. **Link on `sub` only.** Email is policy, never identity.
5. **No server session.** Proof is short-lived and only for link/recover.
6. **Single provider** per server in this iteration (matches the issue). The
   link key already contains the issuer, so several providers can follow.
7. **One `/server` property** `oidcProviderName`; no secrets, no URLs.

## Checklist

- [x] Design (this file)
- [x] `server/src/oidc/`: config, jose, flow, links; handlers; routes; `/server` property
- [x] Unit tests: ID-token validation; redirect sanitising; link store
- [x] Integration test with in-process mock OIDC provider
- [x] Front-end: `OidcSignInButton`, `OidcSignInPage` (ticket, recovery passphrase), hand-off to the existing sign-in
- [x] vitest + manual Chromium run against a Node mock provider; screenshots (not committed)
- [x] CHANGELOG, `docs/src/atomicserver/oidc.md`
