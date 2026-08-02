# Atomic Lib Flutter SDK (`atomic_lib`)

**Status: In progress — publish path A (precompiled binaries).**

Reusable Dart/Flutter package so app builders get Atomic auth, local store,
workspaces (drives), sync, and pairing UI without running Postgres or learning
the HTTP stack. Canvas is the first consumer.

Aligns with [`SDK-API-design.md`](./SDK-API-design.md),
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md),
[`social-apps.md`](./social-apps.md) §P1.1, and
[`sync-onboarding-ux.md`](./sync-onboarding-ux.md).

## Package name

| Registry | Name |
| --- | --- |
| pub.dev (target) | **`atomic_lib`** — matches Rust `atomic_lib` / JS `@tomic/lib` |
| Path in repo | `dart/atomic_lib/` |
| Native cdylib | `rust_lib_atomic_lib` |

`atomic_lib` is taken on pub.dev (unrelated state-management package).

## Goals

- `flutter pub add atomic_lib` — no Postgres, no hand-rolled QR/sync UI.
- Consumers **do not need a Rust toolchain** when precompiled binaries are
  available (Cargokit downloads signed artifacts from GitHub Releases).
- Monorepo / canvas can still build from source via cargokit when Rustup is
  present.

## Publish strategy: path A (precompiled binaries)

Per [Cargokit precompiled binaries](https://github.com/irondash/cargokit/blob/main/docs/precompiled_binaries.md)
and [FRB how-to](https://cjycode.com/flutter_rust_bridge/guides/how-to/precompiled-rust):

```text
CI (push to develop / tags)
  → build_tool precompile-binaries (linux+android, macos+ios, windows)
  → sign with ed25519
  → upload GitHub release tag precompiled_<crate_hash>

Consumer flutter build
  → cargokit sees rust/cargokit.yaml
  → downloads + verifies signature with public key
  → falls back to local cargo if Rustup installed / download fails
```

### Config

- `dart/atomic_lib/rust/cargokit.yaml` — `url_prefix` + `public_key`
- GitHub secret **`CARGOKIT_PRIVATE_KEY`** — ed25519 private key (never commit)
- Release asset URL prefix:
  `https://github.com/ontola/atomic-server/releases/download/precompiled_`

### Package layout (single publishable Flutter plugin)

```
dart/atomic_lib/
  pubspec.yaml           # name: atomic_lib; ffiPlugin platforms
  lib/                   # Dart API + UI + FRB generated
  rust/                  # FFI crate + cargokit.yaml
  cargokit/              # build tooling (from former rust_builder)
  android|ios|linux|macos|windows/
  example/
  test/
  LICENSE, CHANGELOG.md, README.md
```

No path dependencies — required for `dart pub publish`.

## Public API (app-builder facing)

```dart
import 'package:atomic_lib/atomic_lib.dart';

await Atomic.init();
await Atomic.setup(name: 'Ada');
PairScreen.show(context);
showAgentSettings(context);
```

## Checklist

### Extraction (done)

- [x] Extract Dart layer + UI + FRB bridge from canvas
- [x] Canvas depends on package path
- [x] Unit tests moved; analyze + test green

### Rename + publish plumbing (this pass)

- [x] Rename package → `atomic_lib` (directory `dart/atomic_lib`)
- [x] Merge `rust_builder` into package root (eliminate path dep)
- [x] `LICENSE`, `CHANGELOG.md`, remove `publish_to: none`
- [x] `rust/cargokit.yaml` with public key + GitHub release URL prefix
- [x] CI workflow `.github/workflows/atomic_lib_precompile.yml`
- [x] Minimal `example/` app
- [x] Set repo secret `CARGOKIT_PRIVATE_KEY` (generated; not in git)
- [ ] `dart pub publish --dry-run` clean (except needing a real pub login)

### Before first pub.dev release

- [ ] Precompile workflow green on develop (binaries uploaded)
- [ ] Verified publisher on pub.dev (atomicdata.dev / Ontola)
- [ ] Docs page under `docs/` (install + quickstart)
- [ ] Generic query / fetch / blob bridge (social-apps P1) — or clearly
      document 0.1 scope (auth + sync + string props; canvas helpers deprecated)

### Follow-ups

- [ ] Peel canvas CRUD off the bridge
- [x] End-to-end “build an app” tutorial — `docs/src/flutter-guide/` + `docs/src/flutter.md`
- [ ] Web / WASM story (today: pure-Dart HTTP stopgap)

## Twin files (keep in step with browser)

| Concern | Package | Browser |
| --- | --- | --- |
| Sync / devices UI | `lib/src/ui/server_settings_section.dart` | `SyncRoute.tsx` |
| Pairing code | `lib/src/ui/pair_screen.dart` | `pairing.ts` + PairingCode |
| Server URL rules | `lib/src/server_url.dart` | `serverUrl.ts` |
| Push workspace up | `AtomicClient.syncDriveToServer` | `promoteLocalDrive` |

## Secrets

| Secret | Purpose |
| --- | --- |
| `CARGOKIT_PRIVATE_KEY` | Signs precompiled binaries (hex ed25519 seed+key) |
| `GITHUB_TOKEN` | Default Actions token can upload releases if `contents: write` |

Rotate the signing key by regenerating with
`dart run build_tool gen-key` in `dart/atomic_lib/cargokit/build_tool`,
updating `cargokit.yaml` public_key, and replacing the GitHub secret.
