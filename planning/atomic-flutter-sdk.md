# Atomic Flutter SDK (`atomic_flutter`)

**Status: In progress.** Extract a reusable Dart/Flutter package from the
canvas app so app builders get auth, local store, workspaces (drives), sync,
pairing UI, and resource APIs without running Postgres or learning the HTTP
stack. Canvas is the first consumer.

Aligns with [`SDK-API-design.md`](./SDK-API-design.md),
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md),
[`social-apps.md`](./social-apps.md) §P1.1, and
[`sync-onboarding-ux.md`](./sync-onboarding-ux.md).

## Goals

- App builders depend on `package:atomic_flutter` and ship — no server setup,
  no Postgres, no hand-rolled QR/sync/drive UI.
- Same vocabulary as the data-browser (workspace, devices, pairing code, sync).
- Canvas keeps drawing/gallery code only; Atomic plumbing lives in the package.

## Package layout

```
dart/atomic_flutter/
  lib/
    atomic_flutter.dart      # public barrel
    src/
      atomic.dart            # high-level Atomic facade
      atomic_client.dart     # FRB-backed client
      session.dart           # secure secret + known servers
      atomic_auth.dart       # request signing (pure Dart)
      atomic_store.dart      # ChangeNotifier state
      resource.dart
      server_url.dart / server_info.dart
      ui/                    # PairScreen, LoginScreen, settings, drive switcher
      rust/                  # flutter_rust_bridge generated
  rust/                      # FFI crate over atomic_lib
  rust_builder/              # cargokit Flutter plugin
  test/
  README.md
```

Canvas app: `flutter/` depends on `path: ../dart/atomic_flutter`.

## Public API (app-builder facing)

```dart
import 'package:atomic_flutter/atomic_flutter.dart';

await Atomic.init();                     // Rust bridge + local DB
await Atomic.setup(name: 'Ada');         // agent + personal workspace
await Atomic.resumeSession();            // auto-login from secure storage

await Atomic.createDrive('Recipes');
await Atomic.setActiveDrive(subject);
await Atomic.setProperty(subject, prop, value);

await Atomic.connectServer('https://atomicdata.dev');
await Atomic.syncNow();

// Reusable UI — do not rebuild these in every app
PairScreen.show(context);
showAgentSettings(context);
ServerSettingsSection(onServerChanged: ...);
LoginScreen(onLoggedIn: ...);
```

## What stays canvas-specific (for now)

Canvas CRUD (`createCanvas`, `pushStroke`, undo/redo, folders) remains on
`AtomicClient` until generic `query` / `mutate` / blobs land (social-apps P1).
They are marked as canvas helpers in docs; new apps should prefer
`getProperty` / `setProperty` and ontology-specific wrappers in their own code.

## Checklist

- [x] Create `dart/atomic_flutter` package shell + README
- [x] Move Dart atomic layer + reusable UI out of `flutter/lib`
- [x] Move FRB rust crate + rust_builder into the package
- [x] Point canvas `pubspec` at the package; thin re-exports removed
- [x] Move atomic widget/unit tests into the package
- [ ] Generic query / fetch / blob bridge (follow-up; social-apps P1)
- [ ] End-to-end “build an app” tutorial (SDK-API-design)

## Twin files (keep in step with browser)

| Concern | Package | Browser |
| --- | --- | --- |
| Sync / devices UI | `ui/server_settings_section.dart` | `SyncRoute.tsx` |
| Pairing code | `ui/pair_screen.dart` | `pairing.ts` + PairingCode |
| Server URL rules | `server_url.dart` | `serverUrl.ts` |
| Push workspace up | `AtomicClient.syncDriveToServer` | `promoteLocalDrive` |
