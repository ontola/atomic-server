# atomic_flutter

Flutter / Dart SDK for [Atomic Data](https://atomicdata.dev). Local-first
storage, Ed25519 agents, workspaces (drives), WebSocket + Iroh sync, and
reusable UI for pairing / sync / drive switching.

App builders depend on this package — they do not run Postgres, manage a
server, or rebuild QR pairing screens. The [Atomic Canvas](../../flutter/)
app is the first consumer.

## Quick start

```dart
import 'package:atomic_flutter/atomic_flutter.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final dir = await getApplicationDocumentsDirectory();
  await Atomic.init(dbPath: dir.path);
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
        onLoggedIn: () { /* navigate to app */ },
      ),
    );
  }
}
```

## What you get

| Area | API |
| --- | --- |
| Auth | `Atomic.setup`, `Atomic.signIn`, `Atomic.resumeSession`, `AtomicSession` |
| Workspaces | `Atomic.createDrive`, `listDrives`, `setActiveDrive` |
| Resources | `Atomic.getProperty` / `setProperty`, `Resource`, `AtomicStore` |
| Sync | `Atomic.connectServer`, `syncNow`, `syncDriveToServer`, peer sync |
| UI | `LoginScreen`, `PairScreen`, `ServerSettingsSection`, `showAgentSettings` |

## Architecture

```
your app
   │
   ▼
atomic_flutter  (Dart API + reusable UI)
   │
   ▼
flutter_rust_bridge
   │
   ▼
atomic_lib (Rust: redb, Loro CRDT, Iroh, WS)
```

HTTP AtomicServer is optional (backup / always-on device). Local reads and
writes go through the embedded node.

## Developing

```bash
cd dart/atomic_flutter
flutter pub get
flutter test
# After changing rust/:
#   flutter_rust_bridge_codegen generate
```

Canvas app consumes this package via path dependency:

```yaml
# flutter/pubspec.yaml
dependencies:
  atomic_flutter:
    path: ../dart/atomic_flutter
```

See [`planning/atomic-flutter-sdk.md`](../../planning/atomic-flutter-sdk.md).
