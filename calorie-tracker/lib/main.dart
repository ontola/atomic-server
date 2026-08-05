import 'package:flutter/material.dart';

import 'screens/onboarding/needs_sync_screen.dart';
import 'screens/onboarding/onboarding_screen.dart';
import 'screens/today_screen.dart';
import 'services/app_session.dart';
import 'theme.dart';

/// The shape here is the one the real app keeps (see
/// `planning/calorie-tracker-plan.md` §6): `runApp` is not allowed to wait on
/// the database. Startup speed is a feature — the camera preview has to be live
/// in under a second — so [AppSession.start] runs behind the first frame and
/// the UI follows the phase it reports.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CalorieTrackerApp());
}

class CalorieTrackerApp extends StatefulWidget {
  const CalorieTrackerApp({super.key, this.session});

  /// Injected by tests, which have no Rust library to talk to. The app builds
  /// its own.
  final AppSession? session;

  @override
  State<CalorieTrackerApp> createState() => _CalorieTrackerAppState();
}

class _CalorieTrackerAppState extends State<CalorieTrackerApp> {
  late final AppSession _session = widget.session ?? AppSession();

  @override
  void initState() {
    super.initState();
    // Not awaited: the first frame goes up now, against whatever phase the
    // session is in, and re-renders when it moves.
    _session.start();
  }

  @override
  void dispose() {
    // Only ours to dispose when it was ours to make.
    if (widget.session == null) _session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Calorie Tracker',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ThemeMode.dark,
      home: SessionGate(session: _session),
    );
  }
}

/// Renders whichever screen the session's [SessionPhase] calls for.
class SessionGate extends StatelessWidget {
  const SessionGate({super.key, required this.session});

  final AppSession session;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: session,
      builder: (context, _) {
        switch (session.phase) {
          case SessionPhase.starting:
            return const _Splash();
          case SessionPhase.onboarding:
            return OnboardingScreen(session: session);
          case SessionPhase.needsSync:
            return NeedsSyncScreen(session: session);
          case SessionPhase.ready:
            return TodayScreen(session: session);
          case SessionPhase.failed:
            return _StoreFailed(session: session);
        }
      },
    );
  }
}

/// Deliberately quiet. Opening redb takes a moment on a cold start, and a
/// branded splash for something that usually blinks past is worse than a blank
/// one that never flashes the wrong thing.
class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) => const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
}

/// The store did not open. There is no account to sign in to and no screen
/// worth showing behind this, so it shows the reason and offers another go.
class _StoreFailed extends StatelessWidget {
  const _StoreFailed({required this.session});

  final AppSession session;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.error_outline,
                      size: 56, color: theme.colorScheme.error),
                  const SizedBox(height: 20),
                  Text(
                    'Could not open your data',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 12),
                  SelectableText(
                    session.error ?? 'Unknown error',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: session.busy ? null : session.start,
                    child: const Text('Try again'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
