# Sync & Onboarding UX

How we talk about sync, what can actually reach what, and which paths exist.
Read this before changing any sync/onboarding screen in **any** client — the
same person meets several of them, and should not have to learn each one.

Applies to: the data-browser (browser tab), the data-browser in Tauri
(desktop/mobile), the Flutter canvas app, and atomic-server.

---

## 1. What can reach what

Most UX mistakes here come from getting this wrong. It is not symmetric.

| From → to | How | Hard constraint |
| --- | --- | --- |
| your device ↔ your other device | Iroh peer sync, started by scanning a pairing code | **Same account only.** `is_same_agent_as_ours` (`lib/src/sync/peer.rs`) fails closed and says so |
| your device → an always-on machine | push (replication) | needs write rights there, signed as *your* agent |
| an always-on machine → your device | WS subscribe + fetch | the device must know its address |
| browser tab ↔ anything | only through an always-on machine | a browser tab **is not a node**: it cannot pair, and holds nothing |

Three consequences that keep being forgotten:

- **An always-on machine is not one of your devices.** It signs in as its own
  agent. It can never be a pairing target — a code for it is refused by every
  device that scans it. (Learned by shipping one. Don't.)
- **A secret restores who you are, not what you have.** Signing in on a new
  device gets you an identity and an empty workspace. Something still has to
  carry the data.
- **Connecting is not pushing.** Connecting to a machine fetches a workspace
  you lack; it never offers the one you have. A workspace made before you
  connected anywhere exists in exactly one place until someone pushes it.

## 2. Language

The same concept has been called a server, a sync hub, a connection and a node
— in three clients. Pick one word and keep it.

| Say | Not | Why |
| --- | --- | --- |
| workspace | drive, store | "drive" is our schema's word, not a person's |
| your devices | peers, nodes | a node is an implementation detail |
| always-on machine, or its address (`atomicserver.eu`) | server, hub, sync hub | name the thing, not the category — "server" makes it plumbing to learn |
| pairing code | envelope, node DID, `atomic://pair` URI | it is a code you scan |
| sync | replicate, reconcile, promote | one verb, whatever the transport |

Rules of thumb:

- **Name what the person wants, not the mechanism.** "Where your data is",
  not "Sync hub URL". The address is the answer, not the concept.
- **Ask for plumbing only when there is plumbing to do.** Nothing that has no
  data yet should be asked where to sync it.
- **A dead end is not a question.** Do not offer a box to type into if no
  answer exists — the workspace made on a phone has never been on a machine,
  so "connect the machine it lives on" cannot be answered.
- **Say where things are, plainly.** "This code reaches `localhost:9883`, not
  this browser." Mechanism belongs in a footnote, never in the headline.
- **A state is not an error.** No machine connected, unreachable, data
  elsewhere — these are normal, and read as normal.

## 3. The paths

Every combination someone can actually get into. "Crosses by" is the only step
that moves data.

| Start | Then | Crosses by | Works today |
| --- | --- | --- | --- |
| new account in browser | mobile / desktop later | device connects the same address, fetches | ✅ |
| new account on Tauri desktop | browser later | desktop pushes workspace up, browser reads it | ✅ `promoteLocalDrive` |
| new account on Tauri desktop | Tauri mobile later | pairing code, either direction | ✅ |
| new account on Flutter mobile | Tauri desktop later | pairing code | ⚠️ untested across the two apps |
| new account on Flutter mobile | another Flutter mobile | pairing code | ✅ |
| new account on Flutter mobile | browser later | mobile pushes workspace up, browser reads it | ✅ `syncDriveToServer` |
| new account anywhere | atomicserver.eu later | device pushes up, then everything reads from there | ⚠️ untested |
| new account in browser A | browser B, no machine in common | **nothing crosses** | ❌ by design — say so |

The last row is the one to get right in copy: two browser tabs with no machine
between them cannot reach each other, ever. Neither is a node.

## 4. Where the logic lives

Keep these in step. A change to one is usually a change to its twin.

| Concern | Browser | Flutter |
| --- | --- | --- |
| sync screen | `data-browser/src/routes/SyncRoute.tsx` | `flutter/lib/atomic/widgets/server_settings_section.dart` |
| settings shell | (same route) | `flutter/lib/atomic/widgets/agent_settings_dialog.dart` |
| onboarding, data elsewhere | `data-browser/src/views/getting-started/ConnectDeviceStep.tsx` | `flutter/lib/screens/login_screen.dart` |
| pairing code, show / scan | `components/PairingCode.tsx`, `ConnectToDeviceForm.tsx` | `flutter/lib/screens/pair_screen.dart` |
| pairing code, format | `browser/lib/src/pairing.ts` | `pair_screen.dart` (`_parsePairingUri`) |
| URL rules (scheme, local address) | `data-browser/src/helpers/serverUrl.ts` | `flutter/lib/atomic/server_url.dart` |
| what a machine says about itself | `data-browser/src/helpers/managedServer.ts` | `flutter/lib/atomic/server_info.dart` |
| push a workspace up | `browser/lib/src/store.ts` (`promoteLocalDrive`) | `AtomicClient.syncDriveToServer` |

Shared, and authoritative over all of the above:

- `lib/src/sync/peer.rs` — pairing, AUTH, the same-account rule
- `lib/src/sync/replicate.rs` — `replicate_drive_to_remote`, the push
- `server/src/plugins/server_info.rs` — `/server`, what a machine says it is
- [`device-pairing.md`](./device-pairing.md) — the code's wire format
- [`unified-sync.md`](./unified-sync.md) — where the transports are heading

## 5. What is tested

| Level | Covers | Where |
| --- | --- | --- |
| Rust unit | pairing AUTH, same-account refusal | `lib/src/sync/` |
| Rust integration | replication, a fresh client reading a replicated workspace | `server/tests/replicate.rs` |
| Rust integration | `/server`, `/drive-usage` | `server/src/tests.rs` |
| Dart unit | URL rules, pairing code parsing, signing parity with Rust | `flutter/test/atomic/` |
| Browser e2e | two servers, sync between them | `browser/e2e/` |

Gaps worth knowing, rather than rediscovering:

- **No test crosses two clients.** Every path in §3 is verified by hand. The
  Flutter↔Tauri pairing row has never been run at all.
- **Dart signing is checked against Rust by golden vectors**
  (`lib/src/genesis_test_vectors.json`), not by a live handshake. That caught a
  real bug (base64 alphabet); it would not catch a header the server ignores.
- **The push path has no Dart-side test.** `syncDriveToServer` is covered by
  Rust replication tests underneath, and nothing above.

---

*If you change vocabulary or a flow here, change it in both clients and update
this table. A person moving from the phone to the laptop should not notice
they moved.*
