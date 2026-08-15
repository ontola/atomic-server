# Pairing UX — field test notes from a real self-hosted setup

> **Status:** Findings (2026-08-15), **substantially revised the same day
> after rebuilding.** Companion to [`device-pairing.md`](./device-pairing.md),
> which owns the pairing/onboarding UX; anything adopted from here belongs
> there.
>
> **Outcome: a blank node still cannot pull a peer's drives.** On current
> code the pairing dialog reports "Your workspace is here" — but the drive it
> opens was **provisioned locally on sign-in**, not received. The two nodes
> end up holding disjoint drive sets, each returning "not found locally" for
> the other's.
>
> **This note has been wrong in both directions in one day.** The first draft
> called it a bootstrap deadlock; the second declared it fixed after a
> rebuild, on the strength of an `INDEXING title="My drive"` log line that was
> a local creation rather than an import. Read "What this cost, and why" at
> the end before trusting any single signal here.
>
> **Evening session (2026-08-15).** Six commits on
> [PR 1272](https://github.com/ontola/atomic-server/pull/1272) took a real
> pre-DID account (drives on atomicdata.dev) from "migration never runs" to
> "drives adopted, but unreadable". See "Migrating a pre-DID account" below
> for what works, what is left, and the build trap that made most of the
> evening measure the wrong binary.
>
> **Setup:** atomic-server as a Home Assistant add-on behind a Cloudflare
> tunnel (`atomic.ontola.io`, GHCR `develop`), plus the macOS Tauri desktop
> app. Findings below are split by whether they reproduce on a **current
> build** or were only ever seen on **0.41.0-beta.2 (Jul 25)**.

## What works, and what only looks like it

Transport is fine. Iroh reaches the add-on through the public relay — both
nodes settle on `euw1-1.relay.iroh.network` within a second of boot — and the
Cloudflare tunnel is not involved in sync at all (it carries HTTPS only).
Pairing itself completes: the peer is dialed and recorded.

**What does not happen is drive transfer.** Verified by asking each node for
the other's drives:

| drive | server | desktop |
| --- | --- | --- |
| `bkvN8DuZ…` (desktop's) | not found locally | present (private) |
| `kZR5Rbwu…` (server's) | present (private) | not found locally |

Disjoint. See C0 for why.

## Confirmed on a current build

### C0 — A blank node invents a drive instead of pulling the peer's

The agent resource for one DID exists in two divergent copies:

| | desktop | server |
| --- | --- | --- |
| `personalDrive` | `did:ad:ZLrn1clJ…` | **absent** |
| `name` | joep.io | Joep Meindertsma |
| `publicKey` | `Qmfp…rcQ` | `Qmfp…rcQ=` |

Sequence: sign in on the desktop → `fetchPersonalDriveSubject`
(`helpers/personalDrive.ts:34`) asks a server for the agent's
`personalDrive` → the server's copy has none → `adoptLegacyDriveList`
provisions a fresh private drive locally → pairing resolves *that* drive and
reports "Your workspace is here". The server's actual drives are never
requested, because **nothing asks the peer what it holds**.

Failing honestly ("your workspace didn't arrive") would be better than
succeeding onto an invented drive, which is indistinguishable from success
until you notice the drive is empty.

The `publicKey` padding difference between the two copies — same agent, one
with the trailing `=` and one without — may be incidental or may be why they
never reconcile. Worth checking on its own.

**Fix direction:** pairing should ask the peer which drives it holds for this
agent and offer them, rather than resolving against local state. Same
conclusion the first draft reached; it survives the rebuild.

### C1 — The pairing input rejects a server address

The one thing that still reliably stops someone. There are two near-identical
inputs with different contracts:

| Screen | Accepts | Placeholder |
| --- | --- | --- |
| Sync page (`SyncRoute.tsx:1582`) | a **server address** | `localhost:9883 or your-server.example` |
| Getting-started `ConnectDeviceStep` | an **`atomic://pair` code** or bare node DID | — |

Typing `atomic.ontola.io` — the obvious thing, and valid one screen over —
fails with *"Not a pairing code: expected an atomic://pair link."* Observed
twice on the current build, by someone who knew exactly what they were doing.

Two contributing details:

- **The error names one of two accepted formats.** `decodePairingEnvelope`
  (`browser/lib/src/pairing.ts:175`) takes an `atomic://pair?…` URI **or** a
  bare `did:ad:node:…`; the message (`pairing.ts:185`) mentions only the
  first. Someone holding a node DID — which the Sync page shows with a copy
  button — is told it is invalid.
- **The resolution already exists, and is switched off here.**
  `ConnectDeviceStep` imports `fetchManagedInfo` and `normalizeServerUrl`,
  and at line 225 turns an address into a node DID — gated
  `if (isNode || !baseURL) return`. So the app resolves `atomic.ontola.io`
  in a browser tab and refuses to on the desktop, the only device that can
  act on it.

**Fix:** when the pasted text isn't a valid envelope, run it through
`normalizeServerUrl` + `fetchManagedInfo(url).nodeId` before erroring, and
reword the message to name both accepted forms. Both helpers are already
imported in that file.

### C2 — Drives created after boot are undiscoverable until a restart

`announce_drives_pkarr` is called once, inside Iroh transport startup
(`server/src/serve.rs:298`). Nothing re-announces on drive creation.
Observed on the `develop` image:

| time | event | drives announced |
| --- | --- | --- |
| 12:17 | add-on boots, empty store | `announced 0 drives` |
| 13:43 | three drives created from the browser | still 0 |
| ~13:48 | pairing attempted → fails | still 0 |
| 13:50 | add-on restarted | `announced 3 drives` |

For a long-running server this is the normal case: create a drive, and
discovery cannot see it until the next restart. Two related notes:

- The log line prints when the loop **finishes**, not at startup — 0.4 s for
  3 drives, ~3.5 min for 1,671. It is a completion marker, not a boot marker.
- Pkarr records carry a TTL, so a server running for weeks goes stale even
  with no new drives.

Re-announce on drive creation, and periodically.

### C3 — A second launch opens a window with a dead server

No longer panics (it did in July). It now logs
`[node] the embedded server stopped: Failed to create redb … Database
already open. Cannot acquire lock.` — but the app still opens a second
window whose embedded server is dead. Should focus the running instance
instead.

### C4 — The app reads `.env` from its working directory

`read_opts` calls `dotenv()` (`server/src/config.rs`), so launched from a
terminal the desktop app parses the cwd's `.env`. Configuration silently
depends on where it was started from — invisible from Finder, confusing
otherwise.

### C5 — Startup announce is O(drives) on the path to being reachable

A store that had accumulated 4.0 GB / 4,339 drives from past dev work took
~3.5 min to become reachable versus ~2 s fresh. A dev artifact here, but the
shape is real for any large store, and it sits directly on the onboarding
path.

### Adjacent — the app does not run at all over plain HTTP

Not pairing, but it blocks the same journey and cost the first hour.
`crypto.randomUUID` is secure-context-only; over plain HTTP on a
non-localhost origin (`http://homeassistant.local:9883` — how essentially
everyone first opens a Home Assistant add-on) it is absent, and
`presence.ts:82` calls it while loading any drive, so the first paint is the
"Error loading resource" screen rather than a degraded app. OPFS and Web
Locks are withheld too, so ClientDb caching and offline are off — that part
is inherent to plain HTTP and cannot be polyfilled.

Fixed by a `crypto.randomUUID` polyfill beside the existing
`crypto.subtle.digest` one in `browser/data-browser/src/index.tsx`, which
covers the ~10 other `randomUUID` call sites too. Verified present in the
current bundle.

## Migrating a pre-DID account (evening session, 2026-08-15)

Tested against a real account: agent at
`https://atomicdata.dev/agents/<publicKey>`, ~53 drives listed on it,
atomicdata.dev running a pre-0.40 server with no DID support. Client was the
desktop app built from PR 1272.

### Where the chain reaches now

| step | state |
| --- | --- |
| Migration runs at all | fixed — see M1 |
| Legacy Agent fetched from atomicdata.dev | works (that resource is public) |
| Legacy `drives` list adopted onto the derived drive | fixed — see M2 |
| Reading those drives | **blocked** — see M4 |
| One stable personal drive | **broken** — see M5 |

### M1 — Builds were silently stale, so nothing measured what it claimed

The most expensive finding, and not about pairing at all.

`vite` consumes `@tomic/lib` from its built `dist/`, not from source. `dist`
is gitignored, built by tsup, and nothing rebuilt it: `tauri.conf.json` calls
`pnpm -C browser/data-browser build:tauri`, which went straight to
`vite build`. The root `browser` script orders this correctly
(`--filter "@tomic/lib" run build` first); the Tauri path bypassed it.

So editing `lib/src` and building the app produced an app **without the
edit**. Nothing failed: source correct, `vitest` green (it runs `src`), bundle
builds fine — only the running app was stale. Three rounds of "still broken"
were all measuring the PR's original code.

**CI cannot catch this.** It builds every package from scratch in dependency
order on a clean checkout, so `dist` is always fresh there. The failure exists
only where artifacts survive between runs — a developer machine.

Fixed in `f03360f3`: `build:tauri` and `dev:tauri` build their workspace deps
first. Still worth adding: a preflight that **fails loudly** when `lib/dist`
is older than the newest file in `lib/src`. That catches the next variant
rather than this one, including paths that bypass the scripts.

General rule this is an instance of: *a build artifact that is an input to
another build needs its freshness enforced or asserted — a comment is not a
contract.*

### M2 — The legacy drive list is adopted (fixed)

`isAdoptableDriveSubject` kept only subjects matching the current
`serverUrl`. A pre-DID account keeps its drives on the server it is migrating
**away** from, while the client already points at the new home, so every drive
was filtered out and `adoptLegacyDriveList` returned on an empty list.

`92c8479f` also accepts the legacy Agent's own origin — the account being
migrated from, which the user authenticated against. Confirmed working: the
app now fetches every drive from the legacy list.

Deliberately unchanged: a stale entry naming `http://localhost:9883` is still
dropped, which is the case `legacy-drive-adoption.test.ts` exists for (it once
made a hosted app issue requests at the signed-in user's own machine). A first
attempt relaxed this to "any http(s) origin" and broke those specs — the tests
caught it.

Known limit: only the legacy Agent's *exact* origin is adopted, so
`staging.atomicdata.dev` drives on an `atomicdata.dev` account are still
dropped. Extending this needs an origin *set*, not a single origin.

### M3 — Migration inputs did not survive a restart (fixed)

`legacySubject` and `initialDrive` exist only on the secret, which is read
once, at sign-in. `agentStorage` persisted the keypair and subject and dropped
both, so every later launch rehydrated an Agent with
`legacySubject === undefined` and `adoptLegacyAgentIdentity` returned on its
first line. Fire-and-forget, so no error surfaced.

`6721b7ce` stores and restores them on both the non-extractable and readable
paths. `c640a686` additionally treats `initialDrive` as a second source of the
old home.

Migration consequence worth documenting for users: once the keypair is stored
non-extractably the secret is deliberately unreadable, so nothing can
back-fill these fields. **Everyone upgrading past this has to re-enter their
secret once.**

### M4 — No authentication against a pre-0.40 server (open)

Adopted drives all return `401 — not publicly readable`. The client logs:

```text
[atomic-lib] Skipping DID authentication request to 'https://atomicdata.dev':
             server version unknown (assuming <0.40).
```

`shouldSkipDidAuthForLegacyServer` (`serverCapabilities.ts`) suppresses DID
auth for an origin that sends no `X-Atomic-Server-Version` header — and
nothing takes its place, so the requests go out anonymous.

What is missing is a legacy fallback: against a pre-0.40 origin, sign as
`agent.legacySubject` rather than the DID. Same key, same scheme the old
server already accepts; only the identifier differs, and the secret carries
it.

This is required whether migration *links* the old drives or eventually
*copies* them — either way they must be readable first. Until it exists, a
migrated account gets a list of drives it cannot open, which is arguably worse
than an empty list because it looks like it worked.

### M5 — WebCrypto signatures are not reproducible, so every lookup minted a new drive (root cause found, fixed)

The symptom grew as the session went on: three `"My drive"` resources in 25
seconds, then — after a clean store reset — **411 distinct personal drives in
about 30 seconds**, 47 MB of store.

Settled by exporting the polluted store (`atomic-server export`) and reading
the resources instead of the logs:

```
total resources:        2346
resources isA Drive:     411      ← every one named "My drive"
distinct subjects:       411
distinct genesis certs:    1      ← byte-identical
```

All 411 carry **one byte-identical genesis certificate**: the personal-drive
nonce, `createdAt: 0`, empty parent, the same signer pubkey. The subject IS
the Ed25519 signature over those bytes, so all 411 were checked against that
single cert and key:

```
signatures that VERIFY: 411 | invalid: 0
distinct signature bytes: 411
```

411 different, all-valid signatures over the same message with the same key.
Ed25519 is deterministic per RFC 8032, but that is a property of an
*implementation*: WebCrypto promises nothing, and the WKWebView provider the
desktop app uses randomizes the nonce. So `personalDriveSubject()` returned a
different DID on every call, the reuse check in `Store.createDrive` searched
for a subject that had never existed, and each miss minted another drive.
Every downstream symptom — the "Server error" drive, the empty "My drives",
"DID Resource not found locally" — follows from that.

The runaway rate is the same bug feeding itself: the app looks up the personal
drive, derives a fresh DID, doesn't find it, creates it, and the next lookup
derives another one.

**Why the earlier "ruled out: the crypto" was wrong.** `d7d06322` added
coverage under `SubtleCryptoProvider` — the right provider, in an environment
where it cannot fail. Node's WebCrypto Ed25519 *is* deterministic (checked:
`true`). The test asserted exactly the right property somewhere it could only
ever pass, and reading it green is what sent the next several hours after the
server's merge path instead. A test that exercises a real provider cannot
catch this; reproducing it needs a signer that randomizes on purpose.

**The fix.** Derive the personal-drive subject once, from the raw private key,
with noble's deterministic implementation — matching `ed25519_dalek` on the
server — and cache it on the Agent. It cannot be recomputed later because the
stored keypair is non-extractable, so it is persisted beside the agent in
IndexedDB, exactly as `legacySubject` and `initialDrive` already are.
`createDrive` pins the new drive to that subject rather than re-signing, which
was a second instance of the same bug: even a correct derivation was discarded
because `newResource` minted the drive's subject through the same
non-deterministic signer.

When neither a cached subject nor a deterministic signer is available, the
Agent now **throws instead of signing**. An unreproducible subject is worse
than none: minting under it is precisely what produced 411 drives with no
signal that anything was wrong.

**Carry-over:** an already-signed-in session has no cached subject and no way
to recompute one, so it must sign in with the secret once more. Sessions
created after the fix persist it at sign-in.

**Wider lesson:** `repeat_genesis_is_mergeable` in `lib/src/commit.rs` is
built on "every device mints the same cert, so the same DID". That assumption
was load-bearing and unenforced on the client. Deriving identity from a
signature requires the signer to be deterministic — a requirement worth
stating wherever it is relied upon.

### M6 — Adopting a drive hands the whole session to the old server (open, top of the list)

The migration working is what breaks the app.

`AppSettings.setDrive` repoints the entire app at a drive's origin:

```ts
if (newDrive.startsWith('http://') || newDrive.startsWith('https://')) {
  setBaseURL(new URL(newDrive).origin);
  serverURLStorage.set(url.origin);
}
```

Migration restores drives that live on `atomicdata.dev`. Opening one moves the
session to that pre-0.40 server — which cannot do DID auth and does not speak
the v2 websocket — so authentication times out after 30s, the socket retries
forever, and every local `did:ad:` resource 404s because the client is asking
the wrong machine.

Measured on a run with the app's own server captured: **0 requests from the
webview reached `localhost:9883`** (the 153 in the log were an unrelated
headless Chrome), while the console looped:

```
WebSocket connection to 'wss://atomicdata.dev/ws' failed
Auth error: Timed out waiting 30000ms for WS tag 2
[Store] Server disconnected / [Store] Server connected   (repeating)
```

The embedded server was healthy throughout — HTTP root in 0.9ms, correct
default agent, 100ms durable-flush tick running.

This is the parent of most of the evening's symptoms: "Server error" on every
drive, the private drive not resolving, the migration fetch timing out (`curl`
gets that same resource in 120ms), and the lost edits.

**Not yet fixed** — it is a semantics decision, not a bug with one right
answer. Either refuse to follow a drive to an origin that fails a capability
check, or keep the home server fixed and fetch foreign drives cross-origin. The
second is more defensible: a drive adopted from a server you are migrating
*away from* should not be able to take the session with it.

### M7 — A foreign origin's websocket took the whole app offline (fixed)

`WSClient` called `store.setServerConnected(false)` from its error and close
handlers with no check that the socket belonged to the current server. A client
holds one socket per origin, and adopted drives add origins the app does not
depend on — old, unreachable, or gone. Each failure marked the entire store
disconnected, so the app showed "Working offline" and queued writes while its
own server answered in under a millisecond.

Fixed by gating every global connection-state change on "this socket is the
app's server". The regression test was checked to FAIL without the gate, not
merely to pass with it — the lesson from M5, where a test asserted the right
property in the one environment where it could not fail.

### M8 — "Your changes are saved locally" is false on desktop (open)

Offline edits mark subjects dirty in the outbox, but the *content* lives in the
Loro doc, which is persisted by the ClientDb: "On reload the Loro doc rehydrates
from clientDb" (`local-outbox.ts`). The desktop app runs with the ClientDb off
by design — the embedded server is meant to be the local store — so while
offline, edits exist only in memory and a restart loses them, under a toast
promising the opposite.

Server-side durability is not the problem: `serve.rs` runs a 100ms durable-flush
tick, and the desktop goes through that same path.

Either the outbox must persist content without the ClientDb on this platform, or
the app must not claim local safety it does not have.

### P1 — Proposal: show discovered-but-unpaired nodes on the Sync page

The Sync page shows two lists, and neither is discovery:

- **Paired devices** — `localStorage['atomic-peers']` (`SyncRoute.tsx:473`).
  Only nodes the user explicitly added.
- **Server peers** — `managedInfo.peers`, from the server's `/server` resource.
  That is `peer_resources()` (`server/src/plugins/server_info.rs:60`) =
  `live_peer_ids()` (currently connected) + `get_known_peers(store)`
  (previously paired, persisted).

Both mean "already related to this node". A node that has merely been
*discovered* appears nowhere.

Meanwhile the transport is discovering constantly. From the HA add-on's log,
its node found this laptop's node over the LAN with no relay hop:

```
add_node_addr{node=6041773d78}: inserting new node in NodeMap
  relay_url=None source=local.swarm.discovery
```

So through an evening of pairing attempts the two machines kept finding each
other, while the page that exists to pair them had nothing to show — and the
user was asked to shuttle a node ID between machines by hand (see C1, where the
input would not even accept it).

**Proposal.** `iroh_transport` already holds the discovered set. Expose it on
`/server` as a third category — discovered, not yet paired — and render those as
one-tap pairing suggestions above the manual entry field.

That deletes the most awkward step in the flow: on a LAN, pairing becomes
"press the device that appeared" rather than "copy this 52-character string to
the other machine". Manual entry stays for the off-LAN case.

Worth care in the design: a discovered node is *not* trusted, and the list is
attacker-influenced on a shared network. It must read as a suggestion to act
on, never as something already connected, and the node ID must stay visible so
a user on an untrusted network can verify what they are pairing with.

## Fixed between 0.41.0-beta.2 (Jul 25) and 2026-08-15 — do not chase

Recorded because the first draft of this note treated them as live, and
someone reading the git history deserves to know they were resolved rather
than dropped.

- **The `unknown-drive` dead end.** On the July build, pairing from a node
  with no drive stopped at "Your workspace didn't arrive". Current code gets
  past that screen — but by provisioning a local drive rather than fetching
  the peer's, so the underlying problem is C0, not fixed.
- **"Paired with the device" reported as success while nothing synced.** The
  `count === undefined` branch (`PairingFlowProvider.tsx:280`) still exists
  and is still reachable. If shown, it should say plainly that no data
  moved.
- **The failure text sent people to a device that could not help** ("Open
  the app on your other device, then pair again"). Same story.
- **Second launch panicked** on an unwrapped redb open. Now handled — see C3
  for what remains.

## Unverified on a current build

- **"Connecting…" never resolving for a cross-origin server.** On the July
  build the desktop showed `atomic.ontola.io — Connecting…` indefinitely
  while the server logged successful upgrades (`/ws`, `101`); same-origin in
  a browser it showed `In sync`. Not re-tested after the rebuild.

## What this cost, and why

Roughly an afternoon went into diagnosing a deadlock that current code does
not have. The reasoning was sound and the evidence was real — logs, `file:line`
paths, a reproduction on a deliberately cleaned store — but it was
**source from the working tree explaining behaviour from a three-week-old
binary**, and the two had diverged. Every "confirmed" step made the wrong
conclusion feel firmer.

Two things would have caught it immediately:

1. **Check the binary's provenance before diagnosing from it.** The app was
   dated Jul 25; the tree had moved through PRs 1257 and 1260 and the vault
   work. That should have been the first question, not the last.
2. **Rebuild before writing findings up, not after.** The rebuild took ~15
   minutes and refuted the headline finding on the first try.

Worth keeping in mind for the Android app too, where the same "install an
old bundle, reason from current source" trap is one `adb install` away.
