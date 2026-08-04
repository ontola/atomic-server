import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'atomic/atomic_client.dart';
import 'rust_init.dart';
import 'theme.dart';

/// Phase 0 scaffold.
///
/// The shape here is the one the real app keeps (see
/// `planning/calorie-tracker-plan.md` §6): `runApp` is not allowed to wait on
/// the database. Startup speed is a feature — the camera preview has to be live
/// in under a second — so the store opens in the background and the home screen
/// renders immediately, showing what it has. Only the debug panel below cares
/// whether the store is ready yet; the camera, in Phase 3, will not.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CalorieTrackerApp());
}

class CalorieTrackerApp extends StatelessWidget {
  const CalorieTrackerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Calorie Tracker',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ThemeMode.dark,
      home: const HomeScreen(),
    );
  }
}

/// Placeholder for CaptureScreen (Phase 3). Until the camera lands, this is a
/// bench for the Rust bridge: open the store, mint an agent, read it back.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  /// What the bridge last told us, verbatim. Errors included — a scaffold that
  /// swallows the reason a bridge call failed is worth less than no scaffold.
  String _status = 'Opening store…';
  bool _busy = false;
  bool _storeReady = false;

  @override
  void initState() {
    super.initState();
    _openStore();
  }

  Future<void> _openStore() async {
    try {
      await initRustBridge();
      final dir = await getApplicationDocumentsDirectory();
      await AtomicClient.openDb(dir.path);
      final agent = await AtomicClient.getActiveAgent();
      if (!mounted) return;
      setState(() {
        _storeReady = true;
        _status = agent == null
            ? 'Store open at ${dir.path}\nNo agent yet.'
            : 'Store open.\nAgent ${_short(agent.subject)}\n'
                'Drive ${_short(AtomicClient.getActiveDrive() ?? '—')}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _status = 'Could not open the store:\n$e');
    }
  }

  Future<void> _setup() async {
    setState(() => _busy = true);
    try {
      final result = await AtomicClient.setup('Calorie Tracker');
      if (!mounted) return;
      setState(() => _status = 'Agent ${_short(result.agentSubject)}\n'
          'Drive ${_short(result.driveSubject)}\n'
          'Secret ${result.agentSecret.length} chars (kept in the store)');
    } catch (e) {
      if (!mounted) return;
      setState(() => _status = 'setup() failed:\n$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Subjects are DIDs and run off the screen; the tail is the identifying part.
  static String _short(String subject) =>
      subject.length <= 28 ? subject : '…${subject.substring(subject.length - 26)}';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        // Scrollable because `_status` is unbounded: a store that fails to open
        // reports the whole exception here, and a fixed Column silently clips
        // the tail — which is the half that says what actually went wrong.
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.photo_camera_outlined,
                  size: 64, color: theme.colorScheme.primary),
              const SizedBox(height: 16),
              Text('Calorie Tracker',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.headlineSmall),
              const SizedBox(height: 8),
              Text('Camera capture lands in Phase 3.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium
                      ?.copyWith(color: theme.colorScheme.outline)),
              const SizedBox(height: 32),
              SelectableText(
                _status,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 32),
              FilledButton(
                onPressed: _storeReady && !_busy ? _setup : null,
                child: _busy
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Create agent + drive'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
