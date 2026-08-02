# Changelog

## 0.41.0-beta.2

- Initial extract from Atomic Canvas: auth, session, workspaces, WS/Iroh sync,
  and reusable UI (`LoginScreen`, `PairScreen`, `ServerSettingsSection`,
  `DriveSwitcher`).
- Precompiled Rust binaries via Cargokit + GitHub Releases (path A).
- Canvas app is the first consumer (`flutter/` path dependency).
- Version aligned with the monorepo release line (`atomic_lib` Rust /
  `@tomic/*`); bumped via `scripts/bump-version.mjs`.
