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

An **ad-hoc, linker-signed** binary has no stable identity for that ACL to
trust — its code identity is a hash of the binary itself, so macOS re-asks and
"Always Allow" is void as soon as you relink. Hence `signingIdentity` in
`tauri.conf.json`: bundles are signed with the Developer ID certificate, whose
requirement (identifier plus team `Q9WPWRTU7G`) survives rebuilds, version
bumps and reinstalls. One "Always Allow" then holds forever, for users on every
update as much as for us.

Without that certificate in your keychain, `cargo tauri build` fails with `no
identity found`. Override with codesign's ad-hoc identity:

```sh
APPLE_SIGNING_IDENTITY=- cargo tauri build
```

`APPLE_SIGNING_IDENTITY` takes precedence over the config value, which is also
how `tauri-release.yml` feeds in the certificate from repository secrets, and
how its secret-less runs fall back to ad-hoc.

`cargo tauri dev` is a different story: it never bundles, so tauri never signs
it, and the watcher relinks on every source change. Signing cannot help there.
Silence those prompts by opening Keychain Access, finding *atomic-server-tauri
WebCrypto Master Key* and setting its Access Control to "Allow all
applications" — acceptable for a dev item on your own machine, not something to
suggest to a user.

## Limitations

- No way to pass flags to `atomic-sever` using the Tauri executable (although you can set ENV variables)
- No HTTPS support
