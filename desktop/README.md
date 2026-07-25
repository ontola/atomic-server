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

## Limitations

- No way to pass flags to `atomic-sever` using the Tauri executable (although you can set ENV variables)
- No HTTPS support
