{{#title atomic_lib: Atomic Data for Flutter}}

# atomic_lib: Atomic Data for Flutter

Flutter SDK for [Atomic Data](atomic-data-overview.md) — the mobile counterpart to
[`@tomic/lib`](js.md) (TypeScript) and [`atomic-lib`](rust-lib.md) (Rust).

`atomic_lib` embeds a local Atomic node on the device (via the Rust `atomic_lib`
crate and `flutter_rust_bridge`). Your app reads and writes locally; sync to
other devices or an always-on AtomicServer is optional.

> Prefer a walkthrough? Start with
> [Build a local-first Flutter app](flutter-guide/1-index.md).

## Installation

```yaml
dependencies:
  atomic_lib: ^0.41.0-beta.2
```

```sh
flutter pub add atomic_lib
```

No Postgres. No self-hosted backend required to start. Precompiled native
binaries are downloaded automatically when you build; contributors with a Rust
toolchain can still compile from source.

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
        appIcon: Icons.notes,
        continueLabel: 'Continue',
        onLoggedIn: () {
          // Navigate into your app
        },
      ),
    );
  }
}
```

`LoginScreen` handles create-identity, paste-secret sign-in, and the
“workspace not on this device yet” pairing step. Brand it with `appName` /
`appIcon` / `continueLabel`.

## Core API

| Area | Calls |
| --- | --- |
| Boot | `Atomic.init()` |
| Auth | `Atomic.setup`, `Atomic.signIn`, `Atomic.resumeSession`, `Atomic.signOut` |
| Workspaces | `Atomic.createDrive`, `listDrives`, `setActiveDrive`, `activeDrive` |
| Resources | `Atomic.getProperty`, `Atomic.setProperty` |
| Sync | `Atomic.connectServer`, `syncNow`, `syncDriveToServer` |

Lower-level types (`AtomicClient`, `AtomicSession`, `AtomicStore`, `Resource`)
are exported for apps that need them.

## Reusable UI

These screens match the data-browser’s sync vocabulary (workspace, devices,
pairing code). Use them instead of rebuilding QR pairing or drive switching:

| Widget | Purpose |
| --- | --- |
| `LoginScreen` | Onboarding / restore secret |
| `PairScreen.show(context)` | Show or scan a pairing code |
| `showAgentSettings(context)` | Account, workspaces, sync settings |
| `ServerSettingsSection` | Always-on devices + paired peers |
| `DriveSwitcher` | Compact workspace picker |

## Platforms

Android, iOS, macOS, Linux, and Windows via the FFI plugin. Web uses a
compatibility HTTP client today; prefer native targets for the full local-first
node.

## Related

- Tutorial: [Build a local-first Flutter app](flutter-guide/1-index.md)
- [WebSockets](websockets.md) · [Agents](agents.md) · [Commits](commits/intro.md)
- [Personal Data Store](usecases/personal-data-store.md)
