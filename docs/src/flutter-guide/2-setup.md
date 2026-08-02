{{#title Setup — local-first Flutter with Atomic}}

# Setup

## Create a Flutter app

```sh
flutter create my_atomic_app
cd my_atomic_app
```

## Add atomic_lib

```sh
flutter pub add atomic_lib
```

Or in `pubspec.yaml`:

```yaml
dependencies:
  atomic_lib: ^0.41.0-beta.2
```

On first native build, Cargokit fetches **signed precompiled binaries** for your
platform. You do not need Rust installed to develop the app. (If Rustup is
present, the plugin can also build the native crate from source — useful when
contributing to Atomic itself.)

## Boot the local node

Replace `lib/main.dart`:

```dart
import 'package:atomic_lib/atomic_lib.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Opens the embedded Atomic database on this device.
  await Atomic.init();

  // Restore the last session if the user already signed in.
  final status = await Atomic.resumeSession();

  runApp(MyApp(loggedIn: status == 'ok'));
}

class MyApp extends StatefulWidget {
  const MyApp({super.key, required this.loggedIn});

  final bool loggedIn;

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  late bool _loggedIn = widget.loggedIn;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'My Atomic App',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0B6E4F)),
        useMaterial3: true,
      ),
      home: _loggedIn
          ? const HomeScreen()
          : LoginScreen(
              appName: 'My Atomic App',
              appIcon: Icons.forest_outlined,
              continueLabel: 'Open app',
              onLoggedIn: () => setState(() => _loggedIn = true),
            ),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Home'),
        actions: [
          IconButton(
            tooltip: 'Account & sync',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => showAgentSettings(context),
          ),
        ],
      ),
      body: const Center(
        child: Text('Signed in. Next: store your own resources.'),
      ),
    );
  }
}
```

Run it:

```sh
flutter run
```

You should see the branded login screen. Tap **Get Started**, enter a name, and
save the secret when prompted — that secret *is* the account.

## What just happened?

`Atomic.init()` started a local Atomic node in the app’s documents directory.
`LoginScreen` created an **agent** (keypair) and a personal **workspace**
(drive). Everything so far is on-device. No network call was required.

Next: [Identity & workspaces](3-identity.md).
