import 'dart:async';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'screens/capture_screen.dart';
import 'screens/onboarding/needs_sync_screen.dart';
import 'screens/onboarding/onboarding_screen.dart';
import 'services/app_session.dart';
import 'services/camera_feed.dart';
import 'services/estimation_queue.dart';
import 'services/image_store.dart';
import 'services/meal_store.dart';
import 'services/openrouter.dart';
import 'theme.dart';

/// The shape here is the one the real app keeps (see
/// `planning/calorie-tracker-plan.md` §7): `runApp` is not allowed to wait on
/// anything. Startup speed is a feature — the camera preview has to be live in
/// under a second — so the first frame goes up immediately and the three slow
/// things behind it run at once: opening redb, opening the camera, and finding
/// the documents directory.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CalorieTrackerApp());
}

class CalorieTrackerApp extends StatefulWidget {
  const CalorieTrackerApp({
    super.key,
    this.session,
    this.camera,
    this.images,
    this.meals,
    this.account,
    this.queue,
  });

  /// Injected by tests, which have no Rust library to talk to. The app builds
  /// its own.
  final AppSession? session;

  /// Injected by tests, which have no camera.
  final CameraFeed? camera;

  /// Injected by tests, which have no documents directory. The app finds its
  /// own, which is why this is late rather than final.
  final ImageStore? images;

  /// Injected by tests, which have no Rust library to talk to.
  final MealStore? meals;

  /// Injected by tests, which have no keychain.
  final OpenRouterAccount? account;

  /// Injected by tests, which have no network.
  final EstimationQueue? queue;

  @override
  State<CalorieTrackerApp> createState() => _CalorieTrackerAppState();
}

class _CalorieTrackerAppState extends State<CalorieTrackerApp> {
  late final AppSession _session = widget.session ?? AppSession();
  late final CameraFeed _camera = widget.camera ?? DeviceCamera();

  /// One store for the whole app rather than one per screen, because there is
  /// now a second writer: the day behind the viewfinder, the day in the list
  /// and the day the estimator is filling in have to be the same answer.
  late final MealStore _meals = widget.meals ?? MealStore();
  late final OpenRouterAccount _account =
      widget.account ?? OpenRouterAccount();
  late final EstimationQueue _queue = widget.queue ??
      EstimationQueue(
        meals: _meals,
        account: _account,
        client: OpenRouterClient(account: _account),
      );

  ImageStore? _images;

  @override
  void initState() {
    super.initState();
    _images = widget.images;
    _queue.images = _images;

    // None of these is awaited: the first frame goes up against whatever state
    // they are in, and re-renders as they land.
    _session
      ..addListener(_warmCameraWhenResuming)
      ..addListener(_drainWhenReady)
      ..start();
    if (widget.account == null) unawaited(_account.load());
    if (widget.images == null) unawaited(_findPhotoDirectory());
  }

  @override
  void dispose() {
    _session
      ..removeListener(_warmCameraWhenResuming)
      ..removeListener(_drainWhenReady);
    // Only ours to dispose when it was ours to make.
    if (widget.session == null) _session.dispose();
    if (widget.camera == null) _camera.dispose();
    if (widget.meals == null) _meals.dispose();
    if (widget.account == null) _account.dispose();
    if (widget.queue == null) _queue.dispose();
    super.dispose();
  }

  /// Start estimating as soon as there is a store to read meals out of.
  ///
  /// Not before: `list_pending_meals` goes through the meals container, which
  /// does not exist until the session says [SessionPhase.ready]. Photos can
  /// still be arriving — a meal whose image is not readable yet simply fails
  /// this pass and is picked up by the next one.
  void _drainWhenReady() {
    if (_session.phase != SessionPhase.ready) return;
    _session.removeListener(_drainWhenReady);
    unawaited(_queue.drain());
  }

  /// Open the camera as soon as we know this launch is not an onboarding —
  /// which the session reports well before it is ready, so the camera comes up
  /// alongside the database instead of after it.
  ///
  /// The capture screen starts it too, and `start` is idempotent. That call is
  /// what covers the launch this one deliberately skips: the one that went
  /// through onboarding, where asking for the camera before the user has an
  /// account would be a permission dialog over a sign-up screen.
  void _warmCameraWhenResuming() {
    if (_session.resumesAccount != true) return;
    _session.removeListener(_warmCameraWhenResuming);
    unawaited(_camera.start());
  }

  Future<void> _findPhotoDirectory() async {
    try {
      final dir = await getApplicationDocumentsDirectory();
      if (!mounted) return;
      final images = ImageStore(root: dir);
      setState(() => _images = images);
      // The queue leaves photographed meals alone until it can read them, so
      // this is the moment a launch that raced the directory gets its
      // estimates.
      _queue.images = images;
      unawaited(_queue.drain());
    } catch (e) {
      // Nowhere to keep photos is not nowhere to keep meals: capture falls back
      // to logging without one, which is worth far more than a dead app.
      debugPrint('No photo directory, photos are off this session: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Calorie Tracker',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ThemeMode.dark,
      home: SessionGate(
        session: _session,
        camera: _camera,
        images: _images,
        meals: _meals,
        account: _account,
        queue: _queue,
      ),
    );
  }
}

/// Renders whichever screen the session's [SessionPhase] calls for.
class SessionGate extends StatelessWidget {
  const SessionGate({
    super.key,
    required this.session,
    required this.camera,
    required this.meals,
    required this.account,
    required this.queue,
    this.images,
  });

  final AppSession session;
  final CameraFeed camera;
  final MealStore meals;
  final OpenRouterAccount account;
  final EstimationQueue queue;
  final ImageStore? images;

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
            return CaptureScreen(
              session: session,
              camera: camera,
              images: images,
              store: meals,
              account: account,
              queue: queue,
            );
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
