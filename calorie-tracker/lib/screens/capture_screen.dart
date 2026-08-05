import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/meal.dart';
import '../services/app_session.dart';
import '../services/camera_feed.dart';
import '../services/estimation_queue.dart';
import '../services/image_store.dart';
import '../services/meal_store.dart';
import '../services/openrouter.dart';
import '../startup.dart';
import '../widgets/meal_photo.dart';
import 'account_screen.dart';
import 'meal_entry_sheet.dart';
import 'today_screen.dart';

/// Home: a live camera preview and one big button.
///
/// The shutter is the whole product. It writes a compressed photo and a meal
/// with no name and no number — `pending`, which is exactly the queue Phase 4's
/// estimator drains — and then it is done. Nothing on this path waits on a
/// model, a network, or a decision from the user: the app is safe to kill the
/// instant the chip says "Logged".
class CaptureScreen extends StatefulWidget {
  const CaptureScreen({
    super.key,
    required this.session,
    required this.camera,
    this.store,
    this.images,
    this.account,
    this.queue,
  });

  final AppSession session;

  /// Started before this screen exists — see `main.dart`. Owned by the app, not
  /// by this screen, which is why this screen never disposes it.
  final CameraFeed camera;

  /// Injected by tests, which have no Rust library to talk to.
  final MealStore? store;

  /// Injected by tests, which have no documents directory. Null until the
  /// directory is known, in which case photos simply are not shown.
  final ImageStore? images;

  /// Who pays for the estimates. Null in tests that are not about them.
  final OpenRouterAccount? account;

  /// What turns the meals this screen logs into calories. Owned by the app;
  /// null in tests that are not about estimation, in which case a capture is
  /// simply logged and left `pending` — which is what it does anyway.
  final EstimationQueue? queue;

  @override
  State<CaptureScreen> createState() => _CaptureScreenState();
}

class _CaptureScreenState extends State<CaptureScreen>
    with WidgetsBindingObserver {
  late final MealStore _store = widget.store ?? MealStore();

  bool _capturing = false;

  /// The photo the "Logged" chip is showing, or null when there is no chip.
  /// Empty means a meal was logged without a photo being stored, which still
  /// deserves the confirmation.
  String? _justLoggedPath;
  Timer? _chipTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Idempotent, and usually a no-op: on every launch after the first the app
    // started the camera before this screen was built. The call matters on the
    // launch that went through onboarding, where it hadn't.
    widget.camera.start();
    _store.load();
    // Not awaited, and not on the shutter path: tidying the photo directory is
    // never the reason a screen isn't up.
    unawaited(_sweep());
  }

  /// The documents directory is found in parallel with everything else, so the
  /// store can arrive after this screen is already up. The start-of-launch sweep
  /// is waiting on it.
  @override
  void didUpdateWidget(CaptureScreen old) {
    super.didUpdateWidget(old);
    if (old.images == null && widget.images != null) unawaited(_sweep());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _chipTimer?.cancel();
    if (widget.store == null) _store.dispose();
    super.dispose();
  }

  /// Android hands the camera to whatever is in the foreground, so a
  /// backgrounded app comes back to a dead controller and a black rectangle.
  /// Let go on the way out and re-open on the way back in.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.inactive:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        widget.camera.stop();
      case AppLifecycleState.resumed:
        widget.camera.start();
        // Another device may have synced meals in while we were away, and a
        // drain that was cut short by the app going away has meals left in it.
        _store.load();
        unawaited(widget.queue?.drain());
    }
  }

  // ── The shutter ──────────────────────────────────────────────────────────

  Future<void> _capture() async {
    // The second tap of a double tap is not a second meal.
    if (_capturing) return;
    setState(() => _capturing = true);
    unawaited(HapticFeedback.mediumImpact());

    try {
      final at = DateTime.now();
      final bytes = await widget.camera.capture();

      final images = widget.images;
      final stored = images == null ? null : await images.save(bytes, at: at);

      await _store.logMeal(imagePath: stored?.imagePath ?? '', consumedAt: at);

      final error = _store.error;
      if (!mounted) return;
      if (error != null) {
        _say(error);
      } else {
        _showLoggedChip(stored?.imagePath ?? '');
        // After the meal, never before: the sweep decides what to evict from
        // the list of meals, and this one has to be in it or its own photo is
        // an orphan.
        unawaited(_sweep());
        // Not awaited either, and nothing on this screen waits for it: the
        // shutter's job ended when the meal was written, and what it was worth
        // arrives whenever the model gets round to it.
        unawaited(widget.queue?.drain());
      }
    } catch (e) {
      if (mounted) _say(_messageFor(e));
    } finally {
      if (mounted) setState(() => _capturing = false);
    }
  }

  /// Confirm the capture, briefly.
  void _showLoggedChip(String imagePath) {
    setState(() => _justLoggedPath = imagePath);
    _chipTimer?.cancel();
    _chipTimer = Timer(const Duration(milliseconds: 1600), () {
      if (mounted) setState(() => _justLoggedPath = null);
    });
  }

  Future<void> _sweep() async {
    final images = widget.images;
    if (images == null) return;
    try {
      await images.sweep(meals: await _store.allMeals());
    } catch (e) {
      // Housekeeping. A failure here costs disk, not data, and there is nothing
      // for the user to do about it.
      debugPrint('Photo sweep failed: $e');
    }
  }

  // ── The other ways in ────────────────────────────────────────────────────

  Future<void> _typeAMeal() async {
    final entry = await MealEntrySheet.show(context);
    if (entry is SaveMeal) {
      await _store.logMeal(name: entry.name, calories: entry.calories);
      if (_store.error != null) {
        _say(_store.error!);
      } else if (entry.calories == null) {
        // No number typed means the user is asking the model for one.
        unawaited(widget.queue?.drain());
      }
    }
  }

  void _openToday() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => TodayScreen(
        session: widget.session,
        store: _store,
        images: widget.images,
        account: widget.account,
        queue: widget.queue,
      ),
    ));
  }

  void _openAccount() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => AccountScreen(
        session: widget.session,
        images: widget.images,
        account: widget.account,
      ),
    ));
  }

  void _say(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  static String _messageFor(Object e) {
    final text = e.toString();
    return text.startsWith('Exception: ') ? text.substring(11) : text;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: AnimatedBuilder(
        // Two things move underneath this screen and neither is the other's
        // business: the camera coming up, and the day's total changing.
        animation: Listenable.merge([widget.camera, _store]),
        builder: (context, _) {
          return Stack(
            fit: StackFit.expand,
            children: [
              _Viewfinder(camera: widget.camera, onType: _typeAMeal),
              const _Scrims(),
              SafeArea(
                child: Column(
                  children: [
                    _TopBar(
                      summary: _store.summary,
                      onTapTotal: _openToday,
                      onTapAccount: _openAccount,
                    ),
                    const Spacer(),
                    if (_justLoggedPath != null)
                      _LoggedChip(
                        images: widget.images,
                        imagePath: _justLoggedPath!,
                      )
                    else
                      const SizedBox(height: 64),
                    const SizedBox(height: 16),
                    _Controls(
                      busy: _capturing,
                      canShoot: widget.camera.isReady,
                      onShutter: _capture,
                      onType: _typeAMeal,
                      onToday: _openToday,
                    ),
                    const SizedBox(height: 12),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// The preview, or the reason there isn't one.
class _Viewfinder extends StatelessWidget {
  const _Viewfinder({required this.camera, required this.onType});

  final CameraFeed camera;
  final VoidCallback onType;

  @override
  Widget build(BuildContext context) {
    if (camera.isReady) {
      // Idempotent, and the earliest point at which there is something to
      // report: the build that first has a frame to draw.
      reportFirstPreview();

      // The preview's aspect ratio is the sensor's, not the screen's. Cover
      // rather than letterbox: black bars around a viewfinder read as a bug.
      return FittedBox(
        fit: BoxFit.cover,
        clipBehavior: Clip.hardEdge,
        child: SizedBox(
          width: MediaQuery.of(context).size.width,
          height: MediaQuery.of(context).size.width * 4 / 3,
          child: camera.preview(),
        ),
      );
    }

    final error = camera.error;
    if (error == null) {
      return const ColoredBox(
        color: Colors.black,
        child: Center(
          child: SizedBox(
            width: 28,
            height: 28,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }

    // No camera is not the end of the app — the simulator this gets developed
    // on has none either. Everything else still works, so say so and point at
    // the way in that does not need one.
    final theme = Theme.of(context);
    return ColoredBox(
      color: Colors.black,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.no_photography_outlined,
                  size: 40, color: Colors.white54),
              const SizedBox(height: 16),
              Text(
                error,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: Colors.white70),
              ),
              const SizedBox(height: 20),
              OutlinedButton.icon(
                onPressed: onType,
                icon: const Icon(Icons.keyboard_alt_outlined, size: 18),
                label: const Text('Type a meal instead'),
                style: OutlinedButton.styleFrom(foregroundColor: Colors.white),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Dark gradients top and bottom so white controls stay readable over whatever
/// the camera happens to be pointed at.
class _Scrims extends StatelessWidget {
  const _Scrims();

  @override
  Widget build(BuildContext context) => IgnorePointer(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              stops: const [0, 0.22, 0.65, 1],
              colors: [
                Colors.black.withValues(alpha: 0.55),
                Colors.transparent,
                Colors.transparent,
                Colors.black.withValues(alpha: 0.7),
              ],
            ),
          ),
        ),
      );
}

/// Today's running total, and the way out to the account.
class _TopBar extends StatelessWidget {
  const _TopBar({
    required this.summary,
    required this.onTapTotal,
    required this.onTapAccount,
  });

  final DaySummary summary;
  final VoidCallback onTapTotal;
  final VoidCallback onTapAccount;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Row(
      children: [
        const SizedBox(width: 8),
        Expanded(
          child: InkWell(
            onTap: onTapTotal,
            borderRadius: BorderRadius.circular(24),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Text(
                    '${summary.calories}',
                    style: theme.textTheme.headlineSmall?.copyWith(
                      color: Colors.white,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Text('kcal today',
                      style: TextStyle(color: Colors.white70)),
                  if (summary.unestimatedCount > 0) ...[
                    const SizedBox(width: 8),
                    // The total is a lie by omission while these are out, and
                    // the user is about to add another one.
                    Text(
                      '+${summary.unestimatedCount} waiting',
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: theme.colorScheme.tertiary),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
        IconButton(
          onPressed: onTapAccount,
          icon: const Icon(Icons.person_outline, color: Colors.white),
          tooltip: 'Account',
        ),
        const SizedBox(width: 4),
      ],
    );
  }
}

/// Shutter in the middle, the two other ways to reach a meal on either side.
class _Controls extends StatelessWidget {
  const _Controls({
    required this.busy,
    required this.canShoot,
    required this.onShutter,
    required this.onType,
    required this.onToday,
  });

  final bool busy;
  final bool canShoot;
  final VoidCallback onShutter;
  final VoidCallback onType;
  final VoidCallback onToday;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        _RoundButton(
          icon: Icons.keyboard_alt_outlined,
          tooltip: 'Type a meal',
          onPressed: onType,
        ),
        _ShutterButton(
          busy: busy,
          enabled: canShoot && !busy,
          onPressed: onShutter,
        ),
        _RoundButton(
          icon: Icons.list_alt_outlined,
          tooltip: 'Today',
          onPressed: onToday,
        ),
      ],
    );
  }
}

class _ShutterButton extends StatelessWidget {
  const _ShutterButton({
    required this.busy,
    required this.enabled,
    required this.onPressed,
  });

  final bool busy;
  final bool enabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Log a photo of this meal',
      child: GestureDetector(
        onTap: enabled ? onPressed : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          width: 76,
          height: 76,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(
              color: enabled ? Colors.white : Colors.white38,
              width: 4,
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.all(5),
            child: busy
                ? const Padding(
                    padding: EdgeInsets.all(14),
                    child: CircularProgressIndicator(
                      strokeWidth: 3,
                      valueColor: AlwaysStoppedAnimation(Colors.white),
                    ),
                  )
                : DecoratedBox(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: enabled ? Colors.white : Colors.white24,
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => IconButton.filledTonal(
        onPressed: onPressed,
        icon: Icon(icon),
        tooltip: tooltip,
        iconSize: 24,
        style: IconButton.styleFrom(
          backgroundColor: Colors.white24,
          foregroundColor: Colors.white,
          minimumSize: const Size.square(52),
        ),
      );
}

/// The receipt: the picture that was just taken, small, with a tick.
///
/// This is the entire feedback loop for a capture. What the meal is worth is
/// minutes away and behind a network call, and this screen is not going to wait
/// for it — so what it confirms is the only thing it can honestly confirm, that
/// the photo is saved and the app can now be closed.
class _LoggedChip extends StatelessWidget {
  const _LoggedChip({required this.images, required this.imagePath});

  final ImageStore? images;
  final String imagePath;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 16, 8),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(32),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          MealThumbnail(images: images, imagePath: imagePath, size: 48),
          const SizedBox(width: 12),
          const Icon(Icons.check_circle, color: Color(0xFF3DDC84), size: 20),
          const SizedBox(width: 6),
          const Text('Logged', style: TextStyle(color: Colors.white)),
        ],
      ),
    );
  }
}
