import 'dart:async';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'screens/capture_screen.dart';
import 'screens/meal_actions.dart';
import 'screens/onboarding/needs_sync_screen.dart';
import 'screens/onboarding/onboarding_screen.dart';
import 'services/app_session.dart';
import 'services/background_estimation.dart';
import 'services/camera_feed.dart';
import 'services/estimation_queue.dart';
import 'services/image_store.dart';
import 'services/meal_store.dart';
import 'services/notifications.dart';
import 'services/openrouter.dart';
import 'services/sync_service.dart';
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
    this.notifier,
    this.sync,
    this.background,
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

  /// Injected by tests, which have no notification centre.
  final Notifier? notifier;

  /// Injected by tests, which have no other devices to sync with.
  final SyncService? sync;

  /// Injected by tests, which have no OS scheduler.
  final BackgroundEstimation? background;

  @override
  State<CalorieTrackerApp> createState() => _CalorieTrackerAppState();
}

class _CalorieTrackerAppState extends State<CalorieTrackerApp>
    with WidgetsBindingObserver {
  late final AppSession _session = widget.session ?? AppSession();
  late final CameraFeed _camera = widget.camera ?? DeviceCamera();

  /// One store for the whole app rather than one per screen, because there is
  /// now a second writer: the day behind the viewfinder, the day in the list
  /// and the day the estimator is filling in have to be the same answer.
  late final MealStore _meals = widget.meals ?? MealStore();
  late final OpenRouterAccount _account =
      widget.account ?? OpenRouterAccount();
  late final Notifier _notifier = widget.notifier ?? LocalNotifications();

  /// The account's other devices, if it has any. Owned here because what a
  /// sync brings in is meals, and the meal store lives here too.
  late final SyncService _sync =
      widget.sync ?? SyncService(onImported: _readEverythingAgain);

  /// The queue, continued after the app is gone. Owned here because what it
  /// needs to know — how many meals are waiting — is what the queue here says.
  late final BackgroundEstimation _background =
      widget.background ?? BackgroundEstimation();
  late final EstimationQueue _queue = widget.queue ??
      EstimationQueue(
        meals: _meals,
        account: _account,
        client: OpenRouterClient(account: _account),
        notifier: _notifier,
      );

  /// The navigator the deep link needs. A notification tap arrives with no
  /// screen behind it — on a cold launch, before there is one at all — so the
  /// sheet it opens cannot be pushed from a `BuildContext` anybody is holding.
  final _navigator = GlobalKey<NavigatorState>();

  ImageStore? _images;

  /// Whether a tapped meal is already being opened. Two taps on one
  /// notification are one meal.
  bool _opening = false;

  @override
  void initState() {
    super.initState();
    _images = widget.images;
    _queue.images = _images;

    WidgetsBinding.instance.addObserver(this);

    // None of these is awaited: the first frame goes up against whatever state
    // they are in, and re-renders as they land.
    _session
      ..addListener(_warmCameraWhenResuming)
      ..addListener(_drainWhenReady)
      ..addListener(_openTappedMeal)
      ..start();
    _notifier.opened.addListener(_openTappedMeal);
    unawaited(_notifier.start());
    // The queue treats a photo it cannot find differently once this account has
    // a second device — see [EstimationQueue.paired].
    _sync.addListener(_tellTheQueueAboutTheOtherDevices);
    // Registers the entrypoint the OS will call; schedules nothing. There is
    // nothing to schedule until the app is on its way out with meals still in
    // the queue.
    unawaited(_background.start());
    if (widget.account == null) unawaited(_account.load());
    if (widget.images == null) unawaited(_findPhotoDirectory());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _session
      ..removeListener(_warmCameraWhenResuming)
      ..removeListener(_drainWhenReady)
      ..removeListener(_openTappedMeal);
    _notifier.opened.removeListener(_openTappedMeal);
    _sync.removeListener(_tellTheQueueAboutTheOtherDevices);
    // Only ours to dispose when it was ours to make.
    if (widget.session == null) _session.dispose();
    if (widget.camera == null) _camera.dispose();
    if (widget.meals == null) _meals.dispose();
    if (widget.account == null) _account.dispose();
    if (widget.queue == null) _queue.dispose();
    if (widget.sync == null) _sync.dispose();
    super.dispose();
  }

  /// Leaving and coming back.
  ///
  /// The capture screen watches this too, for the camera — Android hands it to
  /// whatever is in the foreground. This one is about the two things that
  /// outlive the screen: the meals another device may have logged while we were
  /// away, and the meals this device still owes the estimator.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        // Withdraw first: whatever is waiting, the drain the capture screen is
        // about to fire beats any scheduler, and paying for an estimate twice
        // is the one outcome worth going out of the way to avoid.
        unawaited(_background.whenForegrounded());
        unawaited(_sync.autoSync());
      case AppLifecycleState.paused:
        unawaited(_background.whenBackgrounded(waiting: _queue.waiting));
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        // `inactive` is a notification shade, an incoming call, the app
        // switcher — none of which is leaving. `paused` is.
        break;
    }
  }

  void _tellTheQueueAboutTheOtherDevices() =>
      _queue.paired = _sync.hasDevices;

  /// A sync brought meals in. The day on screen and the estimator's queue are
  /// both now out of date, and neither has any way of knowing.
  Future<void> _readEverythingAgain() async {
    await _meals.load();
    unawaited(_queue.drain());
  }

  /// Show the meal a notification was tapped about.
  ///
  /// Listens to the session as well as to the tap, because the two arrive in
  /// either order: a tap while the app is running finds the store open, and a
  /// tap that *launched* the app beats it there by a second or two. Whichever
  /// lands second is what runs this.
  Future<void> _openTappedMeal() async {
    final subject = _notifier.opened.value;
    if (subject == null || _opening) return;
    if (_session.phase != SessionPhase.ready) return;

    _opening = true;
    _notifier.handled();
    try {
      final meal = await _meals.mealAt(subject);
      final context = _navigator.currentContext;
      // The meal may have been deleted, or answered on another device, while
      // the notification sat on the lock screen. Nothing to show and nothing
      // worth saying about it.
      if (meal == null || context == null || !context.mounted) return;
      await openMeal(
        context,
        meal,
        store: _meals,
        images: _images,
        queue: _queue,
      );
    } catch (e) {
      debugPrint('Could not open $subject: $e');
    } finally {
      _opening = false;
    }
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
    // And ask the other devices what they have been up to — but only if there
    // are any. An account that has never been paired reaches for no network
    // here; see [SyncService.autoSync].
    unawaited(_sync.autoSync());
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
      navigatorKey: _navigator,
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
        sync: _sync,
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
    required this.sync,
    this.images,
  });

  final AppSession session;
  final CameraFeed camera;
  final MealStore meals;
  final OpenRouterAccount account;
  final EstimationQueue queue;
  final SyncService sync;
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
              sync: sync,
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
