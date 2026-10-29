# Presence and follow in the Flutter app

The web shows who is where: avatars on sidebar rows (`SidebarPresence`), a
facepile in the top bar for the open resource (`ResourcePresenceRow`), carets
and canvas pointers inside a page, "is typing", follow mode (`FollowContext`,
`FollowStatus`) and the meeting pill (`MeetingBanner`). The app has none of it.
Nothing in the app sends or receives presence. The embed's store does not connect
(`connect: false` in `embed/embedStore.ts`), and no Rust host code calls
`WsClient::subscribe_presence`. The ephemeral frames the WebRTC link hands back
(`webrtc_link.rs`, `out.ephemeral`) are dropped on the Dart side.

## Principles

- **Rust carries presence, as it carries data.** One store on the device, so
  also one presence channel per drive, whatever the transport: the server
  websocket (`EPHEMERAL` kind `PRESENCE`), a WebRTC peer, Iroh. Native screens
  and the web view read the same state.
- **Reuse the web's wire format and semantics unchanged.** A Loro
  `EphemeralStore` per drive, keyed by session id, holding a `PresenceEntry`
  (`agent`, `resource`, `following`, `allowFollow`, `typing`, `data`,
  `updatedAt`). TTL 30 s, heartbeat 10 s (`browser/lib/src/presence.ts`). A
  browser and the app then see each other with no change on the web.
- **The page inside the web view keeps the web's own in-page presence.** Carets,
  canvas pointers, table cell selections and "is typing" are drawn by
  `ResourcePage`'s views already; they only lack a transport. The app pipes
  ephemeral frames between the web view and Rust, so it draws none of these itself.
- **The app draws native chrome only.** Who is here (top bar), who is where
  (drive tree rows), and follow. These reuse `ProfileAvatar`, add no new
  kinds of list, and stay quiet when nobody else is around.

## Architecture

1. **Rust presence hub** (`lib/src/host/presence.rs`, new):
   - `EphemeralStore` per drive the device has open. Subscribes on the server
     websocket session for drives with other members; relays to and from every
     WebRTC/Iroh peer link of that drive.
   - Local entry: `set_presence(drive, entry)`; the hub re-sends it every 10 s
     while the app is in the foreground and deletes it on background or sign out.
   - Out: `presence(drive) -> [PresenceItem]` as JSON, plus a change counter,
     like `storeRevision`, that Dart listens to (a polled revision is enough at
     first; a frb stream later).
   - Raw frames for the web view: `ephemeral_out` (everything for drives and
     resources the page subscribed) and `ephemeral_in(frame)`.
2. **Web view pipe** (`embed.tsx` and the native channel):
   - The embed store gets a `subscribePresenceUpdates` / send path that goes
     over the host channel instead of a websocket. The host pushes frames with
     `window.atomicEmbed.ephemeral(bytes)`.
   - The same covers `DOC` and `LORO` kinds, so the open document gets live
     carets and typing from the desktop over the same pipe.
3. **Announcing:** `ResourceView` calls `set_presence(drive, {resource})`
   when it becomes the top page, and clears `resource` when it leaves. The web
   view does not announce on its own: the app's top bar plays the role of the
   web's NavBar.

## Native UI

- **Top bar of a resource:** a facepile of the others viewing it (max 3 and
  "+N"), right before the menu. Nothing when alone.
- **Avatar tap → bottom sheet:** the name, then Profile, Message (the DM) and
  Follow. Follow is shown only when they are online and `allowFollow` is
  not false. This is the web's `PresenceAvatarMenu` as a sheet.
- **Drive tree rows and home Recents:** the same small facepile at the trailing
  edge of a row someone else has open (the web's `SidebarPresence`).
- **Drives section of the home:** a green dot on a drive in which someone is
  online right now.
- **Follow mode:**
  - While following, the app opens what the leader opens (replace, not stack, so
    back still leaves follow).
  - The top bar shows the leader's avatar with a blue ring. Tapping it opens Stop
    following. A swipe back or opening something else stops follow too, as on
    the web.
  - Being followed shows the followers' facepile with a small badge in the
    home's top bar; tapping it gives "Stop letting others follow"
    (`allowFollow: false`).
- **Meetings:** a Join pill in the top bar while the drive has a live meeting,
  opening the meeting chat that already exists in the embed
  (`MeetingChatOverlay`). Later.

## Phases

1. Rust hub + server-websocket presence + WebRTC relay, with a Rust test where
   two stores see each other's entry and its TTL expiry.
2. Top bar facepile + avatar sheet + announcing. This is the first visible step,
   and it already shows a desktop browser and the app to each other.
3. Web view pipe: live carets, canvas pointers and typing in pages.
4. Follow mode, both directions.
5. Tree row facepiles and the drive dot.
6. Meeting pill.

## Open questions

- Battery and data: the app announces only in the foreground. Should a drive
  without other members skip presence entirely? The proposed default is yes.
- Privacy default for being followed: the web defaults to followable. Keep the
  same for the app.
