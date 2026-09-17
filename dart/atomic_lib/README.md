# atomic_lib

Flutter / Dart SDK for [Atomic Data](https://atomicdata.dev) — the same name as
the Rust crate and the counterpart to JS `@tomic/lib`.

Local-first storage, Ed25519 agents, workspaces (drives), WebSocket + Iroh
sync, and reusable UI for pairing / sync / drive switching. App builders do
not run Postgres or rebuild QR screens.

## Install

```yaml
dependencies:
  atomic_lib: ^0.41.0-beta.2
```

Until the first pub.dev release, use a path or git dependency:

```yaml
dependencies:
  atomic_lib:
    path: ../atomic-server/dart/atomic_lib   # monorepo
    # git:
    #   url: https://github.com/ontola/atomic-server.git
    #   path: dart/atomic_lib
```

Consumers **do not need Rust** when precompiled binaries are available
(downloaded and signature-verified by Cargokit). With Rustup installed,
cargokit builds from source instead (monorepo / contributors).

## Quick start

```dart
import 'package:atomic_lib/atomic_lib.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Atomic.init();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: LoginScreen(
        appName: 'My App',
        appIcon: Icons.restaurant_menu,
        continueLabel: 'Continue',
        onLoggedIn: () { /* navigate */ },
      ),
    );
  }
}
```

## What you get

| Area | API |
| --- | --- |
| Auth | `Atomic.setup`, `Atomic.signIn`, `Atomic.resumeSession` |
| Workspaces | `Atomic.createDrive`, `listDrives`, `setActiveDrive` |
| Resources | `Atomic.getProperty` / `setProperty` |
| Sync | `Atomic.connectServer`, `syncNow`, peer pairing |
| UI | `LoginScreen`, `PairScreen`, `ServerSettingsSection`, `DriveSwitcher` |

## Precompiled binaries

CI builds signed artifacts and uploads them to GitHub Releases
(`precompiled_<crate_hash>`). Config: `rust/cargokit.yaml`. See
[`planning/atomic-flutter-sdk.md`](../../planning/atomic-flutter-sdk.md).

## Developing in this repo

```bash
cd dart/atomic_lib
flutter pub get
flutter test
# After changing rust/:
#   flutter_rust_bridge_codegen generate
```

Canvas: `flutter/` depends on `path: ../dart/atomic_lib`.
