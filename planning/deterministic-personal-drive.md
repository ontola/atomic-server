# Deterministic Personal Drive

> **Status:** Shipped (core, 2026-08). Both sides call `personalDriveSubject()`
> / `fetchPersonalDriveSubject`; pairing no longer mints a random drive.
> Remaining: eager vs lazy first write (M23 in
> [`pairing-ux-field-test.md`](./completed/pairing-ux-field-test.md)), and pre-0.40 DID
> auth (M4). Builds on
> [`genesis-self-verifying.md`](./genesis-self-verifying.md).
>
> Every Agent needs a personal drive — it is the home index for `drives`,
> `sharedWithMe`, `favorites`, drafts and AI chats. Today an Agent may simply
> not have one, and several features quietly break. This derives the personal
> drive's subject **deterministically from the Agent's key** instead of
> recording it in a pointer, so it always exists, is the same on every device,
> and merges rather than conflicts.
>
> **2026-08-15 — derived subject is identity, not a fallback.** An existing
> `personalDrive` pointer or a random-DID home created on another machine does
> not stay authoritative. A best-effort list union is enough; do not design
> around preserving those drives.

## Thesis

The personal drive is currently identified by a `personalDrive` pointer on the
Agent resource. A pointer is a single-valued register: it has to be *written*
by somebody, it can be missing, and two devices can write it differently.

The personal drive is not really a choice — it is a fact about an identity, one
per Agent, forever. Facts like that should be **computed, not recorded**. Given
that a DID already *is* an Ed25519 signature over a genesis certificate, and
Ed25519 is deterministic (RFC 8032), the Agent's own key can derive a stable
drive subject with no coordination:

```
personal_drive(agent) = subject_for_signature(
    sign(agent_key, GenesisCert {
        signer_pubkey: agent_pubkey,
        created_at:    0,
        nonce:         domain_separator("atomic-personal-drive-v1"),
        state_hash:    None,
        parent:        "",
        drive:         "",
    })
)
```

Every device holding the key computes the same subject. Nobody without the key
can produce it. There is nothing to write down and nothing to disagree about.

## The problem, concretely

**Symptom.** Sign in with an older Agent, press "New drive". The drive is
created and opens in the sidebar, but "My drives" in User Settings stays
"Nothing to show" — with no error, no toast, nothing in the console.

**Mechanism.** `Store.addToSavedDrives` (`browser/lib/src/store.ts:2121`):

```ts
const agentResource = await this.getResource(agentSubject);
const personalDrive = agentResource.get(core.properties.personalDrive);

if (personalDrive) {                 // older Agents have none
  ...push to its `drives` list...
}
} catch (_e) { /* Ignore */ }        // and any failure is swallowed
```

The saved-drives list lives **on the personal drive**
(`usePersonalDriveList`), so with no personal drive there is nowhere to record
anything. The write path no-ops in silence; the read path shows an empty list.

Note the inconsistency: *starring* a drive goes through `usePersonalDriveList`,
which correctly surfaces "no personal drive is set up for this account yet".
*Creating* one goes through `addToSavedDrives`, which says nothing. Same root
cause, only one path admits it.

**Blast radius.** This is not only the switcher list. `favorites`,
`sharedWithMe`, drafts and AI chat all hang off the personal drive. An Agent
without one is a partially broken account.

**A second, pre-existing split.** The server and client disagree about where
`drives` lives. `Db::create_drive` (`lib/src/db.rs:818-834`) appends the new
drive to the **Agent's** `drives` array; the client reads `drives` off the
**personal drive**. So a drive created server-side never appears in "My drives"
either. Any fix should collapse this divergence rather than preserve it.

## Options considered

### Rejected: adopt the first created drive as the personal drive

If the Agent has no `personalDrive`, make the drive it just created the
personal one.

Rejected because `personalDrive` is a single-valued register. A user whose
other device already has a personal drive — one this device has never seen,
which is entirely normal in a local-first system — ends up with two devices
writing different values. The merge picks one, and the loser's curated lists
(`drives`, `sharedWithMe`, `favorites`) are orphaned. Fetching the Agent fresh
from the server does not fix it: a device may hold a personal drive the server
has never seen.

It also does not do what the user asked for. `SettingsAgent.tsx:63` renders
`savedDrives.filter(s => s !== personalDrive)`, so the adopted drive appears
under "personal drive", not under "My drives".

### Rejected: treat the Agent resource itself as the personal drive root

Tempting — it needs no new cryptography, the Agent resource already exists, its
subject is already deterministic, and for `did:ad:agent:<pubkey>` Agents the
public key is *in the subject*, so the resource is not needed for signature
verification and can be private.

Rejected because it leaks for exactly the Agents that need fixing. Rights
inherit down from the drive root, and legacy (pre-DID) Agent resources are
**publicly readable by necessity** — verification requires fetching `publicKey`
from the resource, and federated peers still do. Verified against production:

```
GET https://atomicdata.dev/agents/QmfpRIBn... (anonymous) → 200
isA:  [https://atomicdata.dev/classes/Agent]
read: [<the agent itself>, https://atomicdata.dev/agents/publicAgent]
```

Parenting drafts, favorites and AI chats under that would publish them. A
scheme that is only safe for new Agents does not solve the problem, since the
Agents lacking a personal drive are precisely the old ones.

### Proposed: a separate drive, deterministically derived from the Agent key

Keeps the storage separate from the identity, so the drive can be private no
matter how public the Agent is — while still being computable rather than
recorded.

## Why this fits the existing design

The DID scheme already does the hard part. A resource's identity is the Agent's
Ed25519 signature over a compact genesis certificate
(`Commit::create_did`, `lib/src/commit.rs:248-290`), which makes authorship and
identity verifiable offline. Two consequences matter here:

- **Deterministic.** Ed25519 signing is deterministic per RFC 8032, so a
  certificate with fixed field values signs to the same bytes every time, on
  every device.
- **Unforgeable.** The subject is still a real signature by that Agent.
  Predictable is not the same as squattable — nobody else can produce it, so
  the subject cannot be claimed by a third party.

`created_at` is part of the signed certificate but is **not** validated against
a clock, and `genesis.rs` already exercises `created_at: 0`, so a fixed
certificate verifies today with no change to verification.

## What has to change

### 1. Genesis for an existing subject must be idempotent

`lib/src/commit.rs:526`:

```rust
if explicit_genesis && !is_new {
    return Err("... has is_genesis: true, but the resource already exists.");
}
```

With a deterministic subject, two devices creating the personal drive both emit
a genesis for the same subject. That is no longer an error — it is the expected
case, and the whole point of the design.

The guard should accept a repeat genesis when the certificate verifies and
names the same signer, and merge the incoming Loro update instead of rejecting
it. The weaker alternative — have the client treat "already exists" as success
and fetch instead — leaves a device that created content while offline losing
that content on sync, so it is not sufficient on its own.

This is the only server-side change the proposal requires.

### 2. Domain separation

The deterministic certificate must not be able to collide with a real genesis.
Fix `created_at: 0`, empty `parent`/`drive`, and a `nonce` derived from a
purpose string (`"atomic-personal-drive-v1"`) rather than randomness. Versioning
the string leaves room to derive other per-identity singletons later without
re-deriving this one.

### 3. Derived subject is always the personal drive

The derived DID **is** the personal drive, on every device, including accounts
that already have a `personalDrive` pointer or a random-DID home. Do not keep
the pointer as identity. Do not special-case "this account already has one."

That is the point of a computed subject: sign-in on a new machine with only
the secret, old machine unavailable, still lands on the same home. Two devices
that never saw each other both materialize that subject; Loro merges when they
meet. A pointer that "wins" for existing accounts reintroduces the split this
design exists to close.

`personalDrive` is deprecated. New writes may set it to the derived subject so
older clients keep resolving *something*, but readers that know the derivation
ignore the pointer. Stop writing it once those clients are gone.

**Migration is nice, not load-bearing.** If a device can see an old pointer
drive (or lists parked on the Agent), union `drives` / `favorites` /
`sharedWithMe` onto the derived drive and keep the old drive as an ordinary
workspace in that list. Do not rewrite child `parent` / `drive` stamps. Do not
block sign-in or first write on that union. If the old home is unreachable,
the derived drive starts empty — same as today — and the old one remains a
normal drive if it ever shows up. Stranded lists on a machine that never
returns are acceptable; vault / another replica is how content survives, not
the pointer.

### 4. Collapse the `drives` divergence

While here, make the server and client agree on where `drives` lives. With a
personal drive guaranteed to exist, the personal drive is the natural home, and
`Db::create_drive` should write there rather than onto the Agent — or the read
path should union both until it does.

### 5. Stop swallowing the failure

Independent of everything above, `addToSavedDrives` should not discard errors.
A drive that silently is not recorded reads to the user as data loss. This is
worth landing on its own, ahead of the rest.

## Security and privacy

- **No new signing authority.** The derived subject is an ordinary genesis
  signature; the existing verification path checks it unchanged.
- **Rights are unaffected.** The personal drive is a normal drive with its own
  `read`/`write`. Deriving its *name* says nothing about who may read it.
- **Existence becomes probeable.** Anyone who knows an Agent's public key can
  compute its personal drive subject and ask whether it exists. Contents stay
  rights-gated, so this is a metadata leak, not a data leak — but it is a real
  change from today, where the subject is unguessable. If that matters, mixing
  a per-server or per-account salt into the domain separator would remove it,
  at the cost of no longer being derivable from the key alone (which is most of
  the value).
- **A lost key means a lost drive**, exactly as today.

## Open questions

- Should the derived drive be created eagerly at sign-in, or lazily on first
  write? Lazily avoids creating drives for read-only sessions; eagerly means
  features never have to handle "not yet materialized".
- Does anything assume a drive root's subject is unpredictable? Nothing found,
  but worth a sweep before implementing.
- Should other per-identity singletons (a default ontology, drafts folder, AI
  chats, an inbox) use the same derivation, given the versioned domain
  separator makes room for it? Eager children with random DIDs would still
  fork if both devices create them before sync.
