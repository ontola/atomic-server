# atomic_embed

The Atomic web renderer (documents, tables, folders) inside a Flutter web
view, with the app's own store as the only database.

- `AtomicDocumentView(subject:, call:)` shows and edits one resource. Pass
  `store.embedCall` (an `AtomicStore` handle of `atomic_store_flutter`) as
  `call`: the page reads that store and its edits are signed by its agent and
  synced like any other write.
- `EmbedServer` serves the renderer's files on the loopback address. The app
  ships them as assets: build them with `flutter/scripts/build_embed.sh` and
  copy `assets/embed/` into the app (or point `EmbedServer.assetRoot` at them).
- `MeetingCall(call:, livekitToken:)` runs a meeting's audio/video call in
  its own page. With `livekitToken` (for example
  `AtomicAccountClient.livekitToken` of atomic_flutter) the call goes through
  the account's LiveKit server; without it, or when that gives no grant, it
  goes peer-to-peer. `transport` says which one carries the running call.
- `WebViewEmbedPage` is the page and its channel; `atomic_chat`'s
  `ResourceView` and warm pool are built on it.

See `planning/flutter-embed-host.md`.
