# Device Pairing — sync onboarding UX between a server and a phone/tablet

> **Status:** Proposal (2026-07-08). Owns the pairing/onboarding UX and the
> QR/deep-link envelope. Resolves [`serverless-p2p.md`](./serverless-p2p.md)
> Open Question 3 (key transport) and narrows OQ1 (LAN discovery) and OQ4
> (drive enrollment). Trust rules are inherited from serverless-p2p
> Principle 1 and are not renegotiated here.
>
> Context: the Android Tauri app boots and syncs as of 2026-07-08 (embedded
> server + webview, Iroh transport ready). What's missing is any humane way
> to get a second device holding the same agent talking to the first.

## Goal

A person running atomic-server (desktop app, home server, or another phone)
gets their phone/tablet syncing the same data with **one scan and zero typed
identifiers** — and every reconnect after that requires **no action at all**.

Cross-agent sharing is out of scope (that's
[`authorization-sync.md`](./authorization-sync.md)'s knock/inbox ceremony).
This doc is about *my own devices*.

## The three separable problems

Pairing conflates three questions; the design keeps them separable, and the
QR envelope simply bundles their answers:

1. **Identity** — get the agent secret onto the new device.
2. **Routing** — tell the new device where an existing node is
   (NodeID / relay hint / LAN URL). Routing is never trust (Principle 1).
3. **Enrollment** — which drives this pairing syncs (`KnownPeer.drives`).

## What exists today (inventory)

- Agent secret is already a portable base64 JSON
  `{privateKey, subject: did:ad:agent:…}`; the browser imports it via
  `Agent.fromSecret` (`browser/lib/src/agent.ts`, `agentStorage.ts`) and the
  server mints one on first boot.
- Every node has a `did:ad:node:…` (Iroh NodeID). `SyncRoute.tsx` shows the
  local one (`/iroh-node-id`) with a copy button, accepts a pasted peer DID,
  and triggers `/iroh-sync`. `KnownPeer{nodeId, label, lastSync}` lives in
  localStorage.
- The server announces drives via pkarr at boot (`serve.rs`).
- Same-agent AUTH is the only trust gate; `engine::handle_frame` applies
  peer `COMMIT`s with full validation (serverless-p2p P1/P4 receiving half).
- Nothing renders or scans QR codes yet; no deep-link registration; no mDNS.

## Decision: one envelope, two payload kinds

One QR/deep-link format. The `kind` field says whether it carries identity:

- **`onboard`** — routing **+ agent secret**. For a fresh device that doesn't
  hold the agent yet. One scan does everything.
- **`pair`** — routing only. For a device that already holds the agent
  (Android ↔ Android after both were onboarded; this is exactly
  serverless-p2p P3's "QR contains routing only").

### Why the secret goes in the QR (v1)

Options considered:

- **A. Secret in QR (chosen for v1).** The QR is a bearer credential — but
  the browser UI already exposes "copy your secret" with identical
  sensitivity, and Principle 1 says the key *is* the consent. Honest about
  its trust model, reuses `Agent.fromSecret` unchanged, one scan.
  Mitigations: render only behind an explicit "Pair new device" action,
  blur until pressed, dismiss on navigation/timeout.
- **B. Routing-only QR + secret over the Iroh channel (target for v2).**
  QR carries `{node, relay hint, one-shot token}`. New device dials the
  node (E2E-encrypted QUIC, endpoint authenticated by the NodeID from the
  QR), presents the token; the *existing* device shows "Device 'Xiaomi Pad'
  requests your identity — allow?" and ships the secret through the channel
  once. The optical channel never carries the key; a photographed QR leaks
  routing plus a token that the on-screen confirm gates. This is a lite
  form of the knock/inbox primitive — build it when that lands, keeping the
  same envelope (only `kind` changes: `onboard-request`).
- **C. Two manual steps** (paste secret, paste node DID) — status quo;
  fine for developers, not a product. Stays available as fallback.

## Envelope format

Deep-link URI so the system camera opens the app directly
(`tauri-plugin-deep-link`; intent filter in `desktop/gen/android`):

```
atomic://pair?p=<base64url(json)>

{
  "v": 1,
  "kind": "onboard" | "pair",
  "secret": "<agent secret b64>",     // onboard only
  "node": "did:ad:node:…",            // issuing node
  "url": "http://192.168.0.153:9883", // optional LAN/WS fast path
  "drives": "*" | ["<drive subject>", …]
}
```

Rules:

- `v` is mandatory; unknown `v` → "update the app" error, never best-effort
  parsing.
- `url` is a hint, not identity: after connecting, the same-agent AUTH gate
  decides everything. A tampered `url`/`node` can at worst make the device
  dial a stranger who then fails AUTH (for `pair`) — for `onboard` the QR
  holder already owns the secret, so there is nothing further to protect
  against in-band.
- The same payload renders as a QR *and* works as a tap/paste link
  (desktop → desktop pairing without a camera).

## Flows

### Server/desktop → phone (first device onboarding)

1. Existing UI: Settings → Devices → **"Pair new device"** → renders
   `onboard` QR (secret + node + LAN url + `drives: "*"`).
2. Phone (fresh install): Welcome screen gains **"Scan to pair"** (plus the
   existing manual paths). System-camera scan of the deep link also works.
3. On scan: import secret → persist server URL + `KnownPeer{node, agent,
   drives}` → connect WS at `url` if reachable (LAN bulk reconcile is much
   faster), else Iroh session via relay → initial reconcile → "Paired with
   \<server name\>".

### Phone ↔ phone / already-provisioned device

Same screen, but the QR is `kind: "pair"` (no secret). Acceptor persists the
`KnownPeer` only after inbound AUTH proves the same agent subject
(serverless-p2p P3 auto-accept rule, unchanged).

### Reconnect (no UX)

Paired devices reconnect with zero action: dial `KnownPeer`s directly; if
unreachable, resolve current NodeIDs via pkarr (drive → nodes) and dial
those. Discovery output is routing-only — `KnownPeer` records are written
exclusively by the pairing flows above.

## Auto-discovery

Discovery is routing sugar, never trust — same-agent AUTH remains the only
gate, so discovery cannot become a security hole by construction:

- **mDNS / LAN** (Iroh local-swarm discovery): the phone's pairing screen
  lists "Atomic node found at 192.168.0.153" so the user taps instead of
  scans. Also gives serverless-p2p OQ1 its LAN-only answer: local discovery
  + direct QUIC, no relay required on a shared network.
- **pkarr** (already announced by the server): *re*-discovery for paired
  devices that roamed networks. Useless for first pairing (nothing to look
  up yet) and grants nothing.

## SaaS-assisted pairing (account login as rendezvous)

For cloud-account holders, `atomic-saas` can make pairing fully automatic —
"log in on a new device and it just syncs." Two of the three legs already
exist there:

- **Identity**: `/api/recovery-secret` (atomic-saas `main.rs`) stores the
  agent secret encrypted under a user-chosen recovery password;
  `GettingStartedFlow` already restores it on sign-in. SaaS never sees the
  plaintext key — the product stays non-custodial.
- **Routing (the missing piece)**: a per-account **device directory** —
  `{device_id, name, node_id, relay_hint?, http_origin?, platform,
  last_seen}` with register/list/revoke endpoints authenticated by the
  portal session. Each signed-in device upserts its record on connect
  (managed nodes already report `iroh_node_id` via heartbeat; this extends
  the idea to the user's own devices).
- **Enrollment**: the account's enrollments already say which drives live
  where.

New-device flow: sign in → restore secret (recovery password) → fetch
device directory → write `KnownPeer`s → dial managed node over WS +
personal devices over Iroh → reconcile. No QR, no typing.

Why this is safe under Principle 1: SaaS-provided node-ids are routing
only. A compromised control plane can hand out wrong node-ids, but the
dialed stranger fails same-agent AUTH and receives nothing — SaaS never
becomes a trust root by operating the directory. (It does learn device
count/liveness; the directory is opt-in and per-account.)

Guardrails:

- **FOSS guardrail #3 holds**: the directory client is the *browser/app*
  posting under the user's cloud session (like the existing
  `helpers/managed/*` code) — never the open-core server phoning home.
  Self-hosters have no session and keep the QR path as the full-featured
  flow; SaaS is a third *issuer* of the same `KnownPeer` data, not a
  different mechanism.
- Remaining friction is the recovery password, which is deliberate
  (non-custodial). v2: passkeys with the PRF extension derive the
  encryption key, making "sign in with passkey" a true one-step restore.
- The directory doubles as the portal's "your devices" list with
  routing-level revocation (remove device → record deleted everywhere).
  Key-level revocation stays out of scope: all devices share the agent key.

## Security notes

- **Stop logging `agent_secret`.** The server prints the full secret to
  stdout on first boot — on Android that lands in logcat (world of debug
  tooling, bug reports, `adb logcat` history). Verified present 2026-07-08.
  Replace with "open Settings → Devices to pair a device". This ships with
  P0 below regardless of everything else.
- The `onboard` QR is a bearer credential; treat the render surface like the
  existing copy-secret button (explicit action, blur-until-press, expiry).
- Scanning a malicious `pair` QR dials an attacker node that then fails
  AUTH and gets nothing (adversarial tests in serverless-p2p P4 cover the
  frame-level guarantees).
- Deep-link handler must be idempotent and prompt before *overwriting* an
  existing local agent (scan while already onboarded = likely mistake; offer
  "switch identity" explicitly, never silently replace keys).

## Drive enrollment (narrows serverless-p2p OQ4)

v1 pairs the whole agent (`drives: "*"`), but `KnownPeer.drives` is written
from the envelope from day one, so per-drive narrowing later is a UI change,
not a migration. The QR issuer UI can add a drive picker when someone asks
for it.

## Phases

### P0 — hygiene (independent, do first)

- [ ] Remove `agent_secret` from first-boot log output (server).
- [ ] `SyncRoute`: show local node DID as QR (`pair` kind) next to the
      existing copy button — display-only, no scanner yet, no new deps
      beyond a QR renderer.

### P1 — onboard flow (server/desktop → phone)

- [ ] Envelope encode/decode module in `browser/lib` (versioned, unit-tested
      against tampered/unknown payloads).
- [ ] "Pair new device" screen rendering the `onboard` QR (explicit action,
      blur-until-press).
- [ ] Phone: scan path (webview `getUserMedia` + JS detector, or
      `tauri-plugin-barcode-scanner`) + `atomic://` deep link
      (`tauri-plugin-deep-link`, intent filter in `gen/android`).
- [ ] Import: secret → `agentStorage`, `KnownPeer` persisted, WS-first /
      Iroh-fallback initial reconcile, "Paired with <name>" confirmation.

### P2 — pair flow + discovery sugar

- [ ] `pair` kind end-to-end between two provisioned devices (auto-accept
      iff same agent; `KnownPeer` capability record per serverless-p2p P3).
- [ ] mDNS candidate list in the pairing screen (tap instead of scan).
- [ ] pkarr-based redial when `KnownPeer` NodeIDs go stale.

### P2.5 — SaaS device directory (parallel track, mostly atomic-saas)

- [ ] `devices` table + register/list/revoke endpoints (portal-session
      auth) in atomic-saas; portal "your devices" list with remove.
- [ ] Browser: upsert own device record on cloud sign-in; after
      secret-restore, seed `KnownPeer`s from the directory and kick
      reconcile (WS to managed origin, Iroh to personal devices).
- [ ] Later: passkey + PRF-derived encryption key for one-step restore.

### P3 — channel-provisioned secret (v2, after knock/inbox)

- [ ] `onboard-request` kind: routing + one-shot token in QR; secret flows
      over the authenticated Iroh channel after on-screen confirm.
- [ ] Deprecate (don't remove) secret-in-QR once this is solid.

## Open questions

1. **QR scanner dependency** — webview `getUserMedia` + `BarcodeDetector`
   (no native dep, but Android WebView support needs verification) vs
   `tauri-plugin-barcode-scanner` (native, more reliable, another plugin in
   the mobile build). Decide during P1 with a spike on the actual device.
2. **Expiry semantics for `onboard` QRs** — static render (dies with the
   dialog) is v1; do we want server-side one-shot tokens even for
   secret-in-QR so a screenshot ages out? Leaning yes-later (it falls out of
   P3's token machinery for free).
3. **Multi-agent devices** — the flows assume one default agent per device.
   If/when a device holds several agents, `onboard` needs an "add as
   additional identity" branch instead of the overwrite prompt.
