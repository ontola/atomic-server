# Atomic-Server Desktop (powered by Tauri)

Desktop release for Atomic-Server.
[Tauri] takes care of native installers, app icons, system tray icons, menu items, self-update ([issue](https://github.com/atomicdata-dev/atomic-server/issues/158)) and more.

```sh
# install tauri
cargo install tauri-cli
# from this directory: run the dev server
cargo tauri dev
# build an installer for your OS
cargo tauri build
```

## Running in development

`cargo tauri dev` starts the front-end for you — `beforeDevCommand` in `tauri.conf.json` runs `pnpm -C browser/data-browser dev:tauri`, and the app points at `localhost:6747` (`devUrl`).
If you only want to work on the _server side_ of things, you can remove `devUrl` in `tauri.conf.json`.

`cargo tauri build` likewise runs `beforeBuildCommand` to produce `browser/data-browser/dist-tauri` before bundling.

### Environment overrides are baked in at build time

`beforeBuildCommand` is a normal vite production build, so it reads `.env` and
`.env.local` — but *not* `.env.development*`. Put local control-plane URLs
(`VITE_MANAGED_PORTAL_URL`, `VITE_MANAGED_API_BASE`) in
`browser/data-browser/.env.development.local`. In `.env.local` they end up
compiled into the shipped app, pointing it at a dev machine's ports.

### macOS: repeated "wants to use your confidential information" prompts

The app stores the agent's keypair as a **non-extractable** `CryptoKey` in
IndexedDB (`helpers/agentStorage.ts`). WebKit implements that by wrapping the
key under a master key it keeps in the login keychain — the item named
"Atomic Server WebCrypto Master Key". Reading it requires a keychain ACL match
against the app's code signature.

A local `cargo tauri build` produces an **ad-hoc, linker-signed** binary
(`"signingIdentity": null`), whose code identity is a hash of the binary
itself. So there is no stable identity for the ACL to trust: macOS re-asks, and
"Always Allow" is void as soon as you rebuild.

To stop the prompts locally, sign with a stable identity. A self-signed
certificate is enough — create one in Keychain Access (*Certificate
Assistant → Create a Certificate*, type "Code Signing"), then:

```sh
APPLE_SIGNING_IDENTITY="My Local Code Signing" cargo tauri build
```

Click "Always Allow" once and it holds across rebuilds. Release builds want a
real Developer ID certificate, which they need for notarization anyway.

## Limitations

- No way to pass flags to `atomic-sever` using the Tauri executable (although you can set ENV variables)
- No HTTPS support
