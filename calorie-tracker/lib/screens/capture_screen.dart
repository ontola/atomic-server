import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/meal.dart';
import '../services/app_session.dart';
import '../services/camera_feed.dart';
import '../services/embedding_queue.dart';
import '../services/estimation_queue.dart';
import '../services/image_store.dart';
import '../services/live_suggestions.dart';
import '../services/meal_index.dart';
import '../services/meal_store.dart';
import '../services/meal_suggestions.dart';
import '../services/openrouter.dart';
import '../services/sync_service.dart';
import '../startup.dart';
import '../widgets/meal_photo.dart';
import 'account_screen.dart';
import 'meal_actions.dart';
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
    this.embeddings,
    this.index,
    this.live,
    this.sync,
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

  /// What turns the photo this screen just wrote into a vector the next
  /// capture's suggestions can match against. Null in tests that are not about
  /// it, in which case the meal is simply never embedded — which shows up as
  /// one fewer suggestion and nothing else.
  final EmbeddingQueue? embeddings;

  /// The decoded vectors the viewfinder matches against. Owned by the app;
  /// re-read here at the four moments the chip row is, because those are the
  /// same moments the history changed.
  final MealIndex? index;

  /// What the camera can see, matched against that index. Null in tests that
  /// are not about it and on a phone with no encoder, in which case the chips
  /// are ranked by frequency exactly as they were in Phase 7.1.
  final LiveSuggestions? live;

  /// The account's other devices. Owned by the app; null in tests, and then
  /// the row that leads to them is not shown.
  final SyncService? sync;

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

  /// The meals worth offering as a one-tap way to log what is in frame, when
  /// nothing has been recognised. Empty until there is history, and then the row
  /// simply appears — see [_SuggestionRow].
  List<MealSuggestion> _suggestions = const [];

  /// What the row shows: what the camera recognised if it recognised anything,
  /// and otherwise the most-logged meals of the last month.
  ///
  /// One or the other, never a mixture. A row that was half "this looks like
  /// your cheese sandwich" and half "you often have porridge" would offer the
  /// two as if they were the same kind of claim, and only one of them is about
  /// what is in front of the camera.
  List<MealSuggestion> get _chips {
    final matched = widget.live?.matches ?? const <MealSuggestion>[];
    return matched.isNotEmpty ? matched : _suggestions;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Idempotent, and usually a no-op: on every launch after the first the app
    // started the camera before this screen was built. The call matters on the
    // launch that went through onboarding, where it hadn't.
    widget.camera.start();
    _store.load();
    // Safe before the camera is up: it watches the camera and attaches when
    // there is a preview to watch.
    widget.live?.start();
    // Not awaited, and not on the shutter path: tidying the photo directory is
    // never the reason a screen isn't up.
    unawaited(_sweep());
    unawaited(_loadSuggestions());
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
    // The stream outlives this screen otherwise, and a camera nobody is looking
    // at is the one cost §6 says this feature is not allowed to have.
    unawaited(widget.live?.stop());
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
        // Before the camera, so the stream is cancelled rather than dying with
        // the controller underneath it.
        unawaited(widget.live?.stop());
        widget.camera.stop();
      case AppLifecycleState.resumed:
        widget.camera.start();
        widget.live?.start();
        // Another device may have synced meals in while we were away, and a
        // drain that was cut short by the app going away has meals left in it.
        _store.load();
        unawaited(widget.queue?.drain());
        // And the same for the vector. Behind the estimate on purpose: this
        // meal has no name and no number yet, so there is nothing to suggest it
        // *as* until the model has been round. The drain re-reads the table, so
        // whichever finishes first, the meal ends up with both.
        // A backfill the app being sent away cut short, or meals a sync brought
        // in from a phone whose encoder had not run yet.
        unawaited(widget.embeddings?.drain());
        // A sync may also have brought history this phone had never seen, which
        // is exactly what the suggestions are drawn from.
        unawaited(_loadSuggestions());
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
        // And the vector, on the same terms — nothing here waits for it either.
        // Behind the estimate on purpose: a meal with no name and no number is
        // nothing to suggest anybody *as* yet, so the estimate is the useful
        // half to spend the phone on first.
        unawaited(widget.embeddings?.drain());
        // This meal is `pending` and so is not one of these yet, but an earlier
        // one that the queue finished during this session is.
        unawaited(_loadSuggestions());
      }
    } catch (e) {
      if (mounted) _say(_messageFor(e));
    } finally {
      if (mounted) setState(() => _capturing = false);
    }
  }

  // ── The one-tap path ─────────────────────────────────────────────────────

  /// Log the meal in frame as one the user has eaten before, taking that meal's
  /// numbers wholesale. No model call, no waiting, and nothing to estimate
  /// afterwards — so this deliberately does not drain the queue.
  ///
  /// **It takes the picture too.** The camera is live and the write path already
  /// exists; a tap that skipped the photo would leave the day's list with one
  /// row that has no picture for no reason the user can see, and would make
  /// every future match slightly worse by not adding to the history it draws on.
  /// But a camera that cannot produce a frame — the simulator, a denied
  /// permission — is no reason to refuse the meal: the numbers are the point and
  /// the photo is a cache.
  Future<void> _logSuggestion(MealSuggestion suggestion) async {
    if (_capturing) return;
    setState(() => _capturing = true);
    unawaited(HapticFeedback.mediumImpact());

    try {
      final at = DateTime.now();
      final stored = await _captureQuietly(at);

      final subject = await _store.logLike(
        suggestion.sourceSubject,
        imagePath: stored?.imagePath ?? '',
        consumedAt: at,
      );

      if (!mounted) return;
      final error = _store.error;
      if (error != null || subject == null) {
        _say(error ?? 'Could not log that meal');
        return;
      }

      _showLoggedChip(stored?.imagePath ?? '');
      _offerUndo(subject, suggestion.name);
      // After the meal, for the reason the shutter sweeps after the meal.
      unawaited(_sweep());
      // A copy is `confirmed` and needs no estimate, but it does need a vector:
      // it is a fresh photograph of a meal this person actually eats, which is
      // the best thing the index can be given. Skipping it would make every
      // one-tap log quietly worse at being recognised next time.
      unawaited(widget.embeddings?.drain());
      unawaited(_loadSuggestions());
    } catch (e) {
      if (mounted) _say(_messageFor(e));
    } finally {
      if (mounted) setState(() => _capturing = false);
    }
  }

  /// The frame and its files, or null when there is no camera, no documents
  /// directory, or the capture failed. Never throws: on this path the photo is
  /// the optional half.
  Future<StoredImage?> _captureQuietly(DateTime at) async {
    final images = widget.images;
    if (images == null || !widget.camera.isReady) return null;
    try {
      return await images.save(await widget.camera.capture(), at: at);
    } catch (e) {
      debugPrint('Suggestion tap could not store a photo: $e');
      return null;
    }
  }

  /// One tap made this meal, so one tap has to be able to unmake it.
  ///
  /// A snackbar rather than a confirmation dialog: the entire feature is that it
  /// is a single tap, and a dialog in front of it would cost more than the
  /// mis-taps it prevents.
  void _offerUndo(String subject, String name) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(
        content: Text('Logged ${name.isEmpty ? 'that meal' : name}'),
        duration: const Duration(seconds: 4),
        action: SnackBarAction(
          label: 'Undo',
          onPressed: () async {
            await _store.deleteMeal(subject);
            // The photo this tap wrote is now nobody's, and the next sweep
            // collects it — including its embedding source.
            unawaited(_sweep());
            unawaited(_loadSuggestions());
          },
        ),
      ));
  }

  /// Re-read the history the chips are drawn from — both rankings.
  ///
  /// A whole month of meals for the frequency list, which is one range query and
  /// the same one the history screen makes, plus a table scan for the matcher's
  /// decoded vectors. Not on the shutter path — the row is allowed to be a
  /// moment out of date, and nothing waits for it.
  ///
  /// This is the *only* place the index is rebuilt from this screen, which is
  /// the point: §7 says a table scan per capture is fine and per frame is not,
  /// and doing it here means the four moments the row is refreshed are exactly
  /// the four moments the index is.
  Future<void> _loadSuggestions() async {
    // Independent of the query below and slower on a long history, so it is not
    // awaited with it — the frequency row should not wait on the matcher.
    unawaited(widget.index?.refresh());
    try {
      final now = DateTime.now();
      final meals = await _store.mealsAcross(
        now.subtract(MealSuggestions.window),
        now,
      );
      if (!mounted) return;
      setState(() {
        _suggestions = MealSuggestions.frequent(meals, now: now);
      });
    } catch (e) {
      // The viewfinder works without these. A failure here should not be the
      // reason somebody cannot log a meal.
      debugPrint('Could not work out suggestions: $e');
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

  /// Anything that puts something else in front of the viewfinder.
  ///
  /// The preview stream stops for the whole of it and starts again after — §6's
  /// "battery is bounded by the viewfinder being up" is a claim about this
  /// method being used, not about the camera. A sheet counts: a keyboard over
  /// the preview is not somebody aiming at a plate.
  /// Not awaited, deliberately: everything [LiveSuggestions.stop] changes it
  /// changes synchronously and only the cancellation is a future, so awaiting
  /// it would put an async gap between here and reading `context` — which is
  /// how a route gets pushed from a screen that has already gone.
  Future<void> _away(Future<void> Function() body) async {
    unawaited(widget.live?.stop());
    try {
      await body();
    } finally {
      if (mounted) widget.live?.start();
    }
  }

  Future<void> _typeAMeal() => _away(
        () => logMealByHand(context, store: _store, queue: widget.queue),
      );

  Future<void> _openToday() => _away(() async {
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => TodayScreen(
            session: widget.session,
            store: _store,
            images: widget.images,
            account: widget.account,
            queue: widget.queue,
            sync: widget.sync,
          ),
        ));
      });

  Future<void> _openAccount() => _away(() async {
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => AccountScreen(
            session: widget.session,
            images: widget.images,
            account: widget.account,
            sync: widget.sync,
            // The bring-up readout, and only from here: this is the screen
            // behind the viewfinder, so `live` has actually looked at something
            // by the time anybody opens it.
            index: widget.index,
            embeddings: widget.embeddings,
            live: widget.live,
          ),
        ));
      });

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
        // Three things move underneath this screen and none is the others'
        // business: the camera coming up, the day's total changing, and the
        // viewfinder recognising something.
        animation: Listenable.merge([widget.camera, _store, widget.live]),
        builder: (context, _) {
          final chips = _chips;
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
                    // Absent entirely when there is nothing worth offering. An
                    // empty row, a spinner or a "no matches" state would all be
                    // worse than nothing, because this is not something the user
                    // asked for.
                    if (chips.isNotEmpty) ...[
                      _SuggestionRow(
                        suggestions: chips,
                        images: widget.images,
                        enabled: !_capturing,
                        onTap: _logSuggestion,
                      ),
                      const SizedBox(height: 12),
                    ],
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

      // The preview's aspect ratio is the sensor's, not the screen's, and the
      // preview already knows it — so constrain the width and leave the height
      // to it. A box that is tight on both axes silently wins that argument
      // (`RenderAspectRatio` gives up under tight constraints) and stretches
      // the frame to whatever ratio was guessed here. Cover rather than
      // letterbox: black bars around a viewfinder read as a bug.
      return FittedBox(
        fit: BoxFit.cover,
        clipBehavior: Clip.hardEdge,
        child: SizedBox(
          width: MediaQuery.of(context).size.width,
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

/// The meals the user could be about to eat again, one tap each.
///
/// Above the shutter rather than after it, which is the whole reason this is
/// safe to offer generously: the food is in frame and the suggestion is next to
/// it, so a wrong one costs nothing — the user presses the shutter instead,
/// which is what they were going to do anyway. Offered *after* a capture it
/// would be a guess about a photo they have stopped looking at, and accepting it
/// writes a `confirmed` meal no estimator is then allowed to correct.
class _SuggestionRow extends StatelessWidget {
  const _SuggestionRow({
    required this.suggestions,
    required this.images,
    required this.enabled,
    required this.onTap,
  });

  final List<MealSuggestion> suggestions;
  final ImageStore? images;
  final bool enabled;
  final ValueChanged<MealSuggestion> onTap;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 56,
      child: ListView.separated(
        // Four chips are wider than a phone, and shrinking them to fit would
        // cost the name — which is the only part that says what is being
        // offered.
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: suggestions.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) => _SuggestionChip(
          suggestion: suggestions[i],
          images: images,
          onTap: enabled ? () => onTap(suggestions[i]) : null,
        ),
      ),
    );
  }
}

class _SuggestionChip extends StatelessWidget {
  const _SuggestionChip({
    required this.suggestion,
    required this.images,
    required this.onTap,
  });

  final MealSuggestion suggestion;
  final ImageStore? images;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Semantics(
      button: true,
      label: 'Log ${suggestion.name}, ${suggestion.calories} kilocalories',
      child: Material(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(28),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(6, 6, 14, 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                MealThumbnail(
                  images: images,
                  imagePath: suggestion.imagePath,
                  size: 36,
                ),
                const SizedBox(width: 10),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 132),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        suggestion.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      Text(
                        '${suggestion.calories} kcal · '
                        '${_ago(suggestion.lastEatenAt)}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelSmall
                            ?.copyWith(color: Colors.white70),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// How long ago, in the least words that still say it. Coarse on purpose: the
  /// question a chip answers is "is this the thing I ate on Tuesday", and a
  /// minute count would be more precision than that needs and wider than the
  /// chip has room for.
  static String _ago(DateTime at) {
    final since = DateTime.now().difference(at);
    if (since.inMinutes < 60) return 'just now';
    if (since.inHours < 24) return '${since.inHours}h ago';
    if (since.inDays == 1) return 'yesterday';
    return '${since.inDays}d ago';
  }
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
