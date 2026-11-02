# The Flutter app joins the browser's WebRTC rooms

**Status:** Dart, Rust, the bridge binding and the app wiring are in; what is
left is the device check ("Verify on a device").

## Problem

A local-only drive (the private drive) is on no server, so the browser and the
app must sync device to device. The browser does it over WebRTC
(`browser-peer-sync.ts`: "Browser sync, Waiting for a peer"). The app only spoke
Iroh and WebSocket, so a favorite starred in the browser never reached the
phone.

## What the web does, which the app now copies

- **Which drives.** Every drive that is ready, skipping those a Cloud Server
  already carries to every member (`driveUsesCloudServer`), and those with no
  signalling service.
- **Signalling.** The drive's `signalingUrl` property, else the hosted portal's
  `/webrtc-signal` as `wss`. Only `wss`, or loopback `ws`. The room secret goes
  in the join message, not the URL.
- **Room.** `sha256("atomic-browser-drive-v1:" + drive)` hex, on the canonical
  `atomic:` spelling (`did:ad:` drives are rewritten first). A hash, so the
  service never learns the drive.
- **Mesh.** Up to 8 in a room, 7 connections each. The peer with the smaller id
  sends the offer; non-trickle ICE (the SDP holds every candidate); one ordered,
  reliable data channel `atomic-sync`, protocol `atomic-sync-v2-framed-v1`;
  frames are `u32 BE length + frame` in messages of at most 16 KiB.
- **Handshake** over the channel, bound to both DTLS fingerprints: `CHALLENGE`
  (`{binding}:{64 hex}`) both ways, `AUTH` over `{drive}#{peer's challenge}`,
  `AUTH_OK`. Only then `SYNC` every 2 s and live frames.
- **Authorization.** Discovery is not authorization. Every inbound frame goes
  through `BrowserPeerSession`, which enforces the drive's ACLs and signed
  commits. A peer that is not allowed gets an error and a closed channel.

## Design

**WebRTC library: `flutter_webrtc`.** The Rust dependency tree has no WebRTC
crate (Iroh is QUIC), and adding one would mean a second ICE/DTLS stack beside
the platform's. The plugin carries the data channel; every frame is handed to
Rust. It also runs on Flutter web, where the browser's own WebRTC is used.

**No second sync implementation.** `lib/src/sync/webrtc_link.rs`
(`WebRtcPeerLink`) is the native half of what `BrowserPeerSync` does in
TypeScript: frames in, frames out.

| Step | Browser | App |
| --- | --- | --- |
| inbound frames | `BrowserPeerSession` (WASM) | the same `BrowserPeerSession`, inside `WebRtcPeerLink::handle` |
| CHALLENGE / AUTH / AUTH_OK | `BrowserPeerConnection.run` | `WebRtcPeerLink::handle` |
| reconcile `SYNC` | `computeDriveSyncState` (TS) | `WebRtcPeerLink::reconcile_frame` (same VV and hash code the Iroh dialer uses) |
| live updates | `store.subscribePeerFrames` | `WebRtcPeerLink::next_live_frames`: a local write becomes `SYNC_PUSH` (delta, or whole snapshot for a new resource), a signed delete becomes `COMMIT` |
| echo | frames are never rebroadcast | an event with a `source_id` (anything imported, from this or another link) is not forwarded; the reconcile carries it |

Live both ways: the peer's live frames arrive as `SYNC_PUSH` / `COMMIT` and are
applied by the session; ours leave through `next_live_frames`. The 2 s reconcile
repairs anything either missed (a delta whose base the peer lacks, a dropped
connection, an offline edit).

Dart (`flutter/lib/atomic/webrtc/`, all against interfaces so it is tested
without the native library):

- `peer_identity.dart`: room, channel binding, peer id, signalling URL rules.
- `signaling_client.dart`: the join/offer/answer socket, message shapes copied
  from the web, malformed input ends the socket.
- `framed_transport.dart`: length-prefixed frames over a `DataPipe`.
- `flutter_webrtc_connection.dart`: the `flutter_webrtc` implementation.
- `peer_mesh.dart`: one drive's room (dial rule, per-peer retry with doubling
  backoff, 15 s authentication timeout, reconcile timer, live loop).
- `peer_sync_service.dart`: which drives get a room.
- `../peer_sync_host.dart`: app wiring. Rooms open when signed in and the app is
  in front; they close on pause and on sign-out; a rescan every 2 minutes picks
  up new drives.

## Limits

- 7 connections per room, 16 MiB per frame (a larger blob needs chunking, as on
  the web). The web's 128-session cap belongs to its single WASM database; the
  app has no such shared budget.
- Both devices must be open at once. A phone in the background has no sockets
  (Android/iOS), so it syncs when brought to the front. A Cloud Server remains
  the always-on option.
- No TURN is configured by the app: the service hands out ICE servers in
  `joined` (STUN, and TURN when the operator set it up). Two devices behind
  symmetric NATs need that TURN.
- The portal default (`PeerSyncHost.portalUrl`, `https://atomic.place`) means the
  app announces a hash of each local drive and its address to that service, as
  the atomic.place web app does. Change it, or set a drive's `signalingUrl`, to
  use another.
- `ephemeral` frames (presence, cursors) from the browser are accepted by the
  session and dropped; the app sends none.

## Bridge binding (in the tree)

`packages/atomic_store_flutter` is another thread's package, and the crate that
`atomic_lib::host` calls `flutter/rust` lives there now
(`packages/atomic_store_flutter/rust`). It needs one new file, then codegen.

`packages/atomic_store_flutter/rust/src/api/simple/webrtc_peer.rs` (register it
in `simple/mod.rs`):

```rust
use atomic_lib::sync::webrtc_link::WebRtcPeerLink;
use flutter_rust_bridge::frb;

#[frb(opaque)]
pub struct WebRtcLink(WebRtcPeerLink);

pub struct WebRtcLinkStart {
    pub link: WebRtcLink,
    pub challenge: Vec<u8>,
}

pub struct WebRtcLinkOutput {
    pub frames: Vec<Vec<u8>>,
    pub changed: Vec<String>,
    pub ready: bool,
}

pub async fn open_webrtc_link(
    drive: String,
    binding: String,
    expected_peer: Option<String>,
) -> Result<WebRtcLinkStart, String> {
    let store = super::state::default_store()?.db.clone(); // as drive.rs does
    let (link, challenge) =
        WebRtcPeerLink::new(store, &drive, &binding, expected_peer).map_err(|e| e.to_string())?;
    Ok(WebRtcLinkStart { link: WebRtcLink(link), challenge })
}

impl WebRtcLink {
    pub async fn handle(&self, frame: Vec<u8>) -> Result<WebRtcLinkOutput, String> {
        let out = self.0.handle(&frame).await.map_err(|e| e.to_string())?;
        Ok(WebRtcLinkOutput { frames: out.frames, changed: out.changed, ready: out.ready })
    }
    pub async fn reconcile_frame(&self) -> Result<Option<Vec<u8>>, String> {
        self.0.reconcile_frame().await.map_err(|e| e.to_string())
    }
    pub async fn next_live_frames(&self) -> Result<Vec<Vec<u8>>, String> {
        self.0.next_live_frames().await.map_err(|e| e.to_string())
    }
    pub async fn close(&self) {
        self.0.close().await
    }
}
```

Then `cd packages/atomic_store_flutter && flutter_rust_bridge_codegen generate`,
and an adapter in `flutter/lib/atomic/bridge_peer_link_backend.dart` implementing
`PeerLinkBackend` / `PeerLinkHandle` over the generated `openWebrtcLink` and
`WebRtcLink` methods (`Uint8List` in and out), set at startup:
`PeerSyncHost.instance.backend = BridgePeerLinkBackend();` in `main.dart`'s
`startApp`.

## Verify on a device

1. `cargo test -p atomic_lib --lib --features db-redb webrtc_link` (6 tests: ran
   green in the cloud session).
2. Build the app (the new native plugin: `flutter_webrtc`; Android minSdk and
   iOS 15.5 are fine, no new permission for a data channel).
3. Browser on the Mac signed in as the same agent, app on the phone, both
   foreground. The Sync page shows "Connected to 1 browser". Star a resource in
   either; it appears on the other within a few seconds (live), and after
   starring while the other is offline, within ~2 s of both being open again.
4. Forced TURN / different networks (phone on mobile data): confirm "relayed".
5. A browser signed in as a different agent without access must not receive
   anything and must fail authentication.
