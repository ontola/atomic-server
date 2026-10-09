# Sign in with OIDC / SSO (optional)

AtomicServer can let people sign in with an account they already have at an
OpenID Connect (OIDC) provider: Microsoft Entra ID, Keycloak, Google, or a
broker in front of DigiD / eHerkenning. **It is off unless you configure it.**
Without `ATOMIC_OIDC_ISSUER` the server has no OIDC routes and the sign-in
screen is unchanged.

## What it does, and what it does not

Your data is signed by an Agent, and an Agent *is* a keypair
(`did:ad:agent:{publicKey}`). Logging in at a provider does not change that, so
OIDC sign-in works like this:

1. The browser creates (or already has) the Agent's keypair. The private key
   never leaves the browser.
2. The user signs in at your provider. The server checks the result (ID token
   signature, issuer, audience, expiry, nonce) and remembers
   `provider + subject -> agent`.
3. The browser encrypts the Agent secret under a **recovery passphrase** and
   stores the encrypted blob on the server next to that link. The server can
   neither read it nor sign as the user.
4. On a new device the user signs in at the provider again, the server hands
   back the blob, and the passphrase unlocks the same Agent there.

A proof from the provider does not create a server session, grant access to any
Drive, or replace a signature. Who may create or join a Drive is still decided
by the usual rules (`ATOMIC_HOST_MODE`, invites). An Agent has exactly one key;
"add a second key to the same Agent" is not supported, which is why recovery
moves the same key, protected by the passphrase.

Users are identified by the provider's `sub` claim only. Email addresses are
never used to find or link an account, so a changed or recycled address cannot
hand someone else's account to a new person.

## Configuration

| Environment variable | Flag | |
| --- | --- | --- |
| `ATOMIC_OIDC_ISSUER` | `--oidc-issuer` | Issuer URL. Turns the feature on. `https` only (plain `http` for `localhost`). |
| `ATOMIC_OIDC_CLIENT_ID` | `--oidc-client-id` | Required with the issuer. |
| `ATOMIC_OIDC_CLIENT_SECRET` | `--oidc-client-secret` | Optional. Without it the client is public and PKCE protects the exchange. |
| `ATOMIC_OIDC_NAME` | `--oidc-name` | Button text: "Sign in with *name*". Defaults to the issuer's host. |
| `ATOMIC_OIDC_SCOPES` | `--oidc-scopes` | Default `openid email profile`. |
| `ATOMIC_OIDC_REDIRECT_URL` | `--oidc-redirect-url` | Register this at the provider. Default `<server origin>/oidc/callback`. Set it behind a proxy. |
| `ATOMIC_OIDC_ALLOWED_EMAIL_DOMAINS` | `--oidc-allowed-email-domains` | Comma list. Only verified emails in these domains may sign in. |
| `ATOMIC_OIDC_REQUIRED_CLAIMS` | `--oidc-required-claim` | Comma list of `name=value`. For array claims such as `groups`, the value must be a member. |

The email and claim settings only decide who is *admitted*; they never identify
anyone.

Register the redirect URI exactly as the server will send it, for example
`https://atomic.example.org/oidc/callback`. The server must be able to reach the
provider's discovery URL (`<issuer>/.well-known/openid-configuration`).

### Microsoft Entra ID

1. App registrations, New registration. Platform **Web**, redirect URI
   `https://atomic.example.org/oidc/callback`.
2. Certificates & secrets, New client secret.
3. Use your **tenant-specific** issuer, never `common` or `organizations`:

```sh
ATOMIC_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
ATOMIC_OIDC_CLIENT_ID=<application (client) id>
ATOMIC_OIDC_CLIENT_SECRET=<secret value>
ATOMIC_OIDC_NAME="Microsoft"
ATOMIC_OIDC_ALLOWED_EMAIL_DOMAINS=example.org   # optional
```

Entra does not send `email_verified`; the domain check then relies on the
provider's own verification, which holds for work accounts of your tenant.

### Keycloak

1. In your realm: Clients, Create client, **OpenID Connect**, Client
   authentication **On**, Standard flow only.
2. Valid redirect URIs: `https://atomic.example.org/oidc/callback`.
3. Copy the secret from the Credentials tab.

```sh
ATOMIC_OIDC_ISSUER=https://sso.example.org/realms/<realm>
ATOMIC_OIDC_CLIENT_ID=atomic
ATOMIC_OIDC_CLIENT_SECRET=<secret>
ATOMIC_OIDC_NAME="Company SSO"
ATOMIC_OIDC_REQUIRED_CLAIMS=groups=atomic-users   # optional, needs a groups mapper
```

### DigiD / eHerkenning through a broker

DigiD and eHerkenning are not OIDC themselves. Use a certified broker that
exposes them as an OIDC provider (for example Signicat, Idensys-style
brokers, or Keycloak with a SAML identity provider in front of it), and point
AtomicServer at the broker's issuer exactly as above. Brokers often send a
pseudonymous `sub` and no email: that is fine, since only `sub` identifies a
user. Do not set `ATOMIC_OIDC_ALLOWED_EMAIL_DOMAINS` unless the broker releases
a verified email.

## Operating notes

- **Recovery passphrase.** Choose a strong one. Anyone who obtains the
  encrypted blob (a leaked database) and the provider account can try
  passphrases offline.
- **Lost passphrase.** The user can sign in and link a *new* Agent explicitly;
  data owned by the old Agent stays with whoever still has its key.
- **Behind a proxy.** Set `ATOMIC_DOMAIN`, HTTPS and, if needed,
  `ATOMIC_OIDC_REDIRECT_URL` so the redirect URI matches the registered one.
- **Pending sign-ins** live in memory for ten minutes; a restart just makes the
  user click the button again.
- **Turning it off.** Unset `ATOMIC_OIDC_ISSUER`. Stored links stay in the
  database, unused.
