# Apps on the phone

Goal (Joep, 28 Oct): an app made with `create_app` runs in the Flutter app, whose
embedded page has a `noServer` store and the Rust node as host. Unattended runs,
`/host/call` between apps and wasm plugins stay server-only.

## What the server does, and the phone's equivalent

- `/plugin-view-token` + `/plugin-ui`: the null-origin frame loads one plugin's
  source under a CSP with `connect-src 'none'`. On the phone the page already
  reads the source from its store, so it builds the same shell as a `srcdoc`
  frame (CSP in a meta tag, sandbox `allow-scripts allow-modals`).
- `/app-agent`: the app's key lives on the node (`Db::set_app_agent`, already in
  atomic_lib). Exposed as EmbedHost `setAppAgent` / `appAgent`.
- `/app-write`: writes as the app agent, bounded by the person's and the app's
  rights (`StoreApplyHost`). Ported to atomic_lib as EmbedHost `appWrite`; the
  host signs with the app key, the page never gets an app signature. The rule
  that `sign` only signs the device agent's own commits stays.
- `/host/call`, proxy: `unsupported` without a server.

## Steps

- [ ] 1. Lock the native channel to the main page: a per-page token in the URL
  fragment, checked on every message; subframes may only navigate to
  `about:srcdoc` / `about:blank`. Android injects `addJavascriptInterface` into
  every frame, so without this an app frame could call the host.
- [ ] 2. srcdoc shell for noServer stores (`appFrameDocument.ts`, port of
  `render_drive_plugin_ui_html_with`); `verifyApp` runs the view. Read-only apps
  work after this.
- [ ] 3. EmbedHost `setAppAgent` / `appAgent` (Rust).
- [ ] 4. EmbedHost `appWrite` (`lib/src/host/app_write.rs`, port of
  `StoreApplyHost`; `json_to_value` moves to atomic_lib).
- [ ] 5. Per-signer outbox so app-agent commits are queued and synced
  (`Outbox::for_signer`, `drain_all`).
- [ ] 6. Page wiring: `NativeClientDb.appWrite/appAgent/setAppAgent`,
  `writeAsApp` / `handOverAppKey` use them; `refresh()` re-reads from the host.
- [ ] 7. Later: let a server-made app write from this phone (an extra app agent
  per device).

## Risks

- iOS frame message handlers and other web views (`meeting_call.dart`,
  `web_tool_bridge.dart`, `welcome_drive.dart`) need the same channel lock.
- Check on Android and iOS that a sandboxed srcdoc frame can `import()` a blob
  URL and that the navigation delegate lets `about:srcdoc` through.
- App secrets are stored unwrapped in redb on the phone (no `node_key`), the same
  exposure as the device key.
- The Rust and TS shells can drift; a test asserts the same CSP directives.
