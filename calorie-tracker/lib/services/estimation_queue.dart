import 'package:flutter/foundation.dart';

import '../models/meal.dart';
import 'image_store.dart';
import 'meal_store.dart';
import 'notifications.dart';
import 'openrouter.dart';

/// Turns photographs into calories, one meal at a time, whenever the app
/// happens to be running.
///
/// The shutter never waits for this (`planning/calorie-tracker-plan.md` §2):
/// every capture writes a `pending` meal and is done, and this drains them —
/// on launch, after each capture, and when the app comes back to the
/// foreground. Kill the app mid-estimate and the meal is picked up next launch,
/// which is why `pending` is a status on the meal rather than a list in memory.
class EstimationQueue extends ChangeNotifier {
  EstimationQueue({
    required MealStore meals,
    required OpenRouterAccount account,
    required OpenRouterClient client,
    Notifier? notifier,
    Future<void> Function(Duration) wait = _realWait,
  })  : _meals = meals,
        _account = account,
        _client = client,
        _notifier = notifier,
        _wait = wait;

  final MealStore _meals;
  final OpenRouterAccount _account;
  final OpenRouterClient _client;

  /// Where a question goes when the app is not being looked at. Null in tests
  /// that are not about the uncertainty loop, and on a platform with no
  /// notification centre.
  final Notifier? _notifier;

  /// Injected so the retry tests do not actually sleep through the backoff.
  final Future<void> Function(Duration) _wait;

  /// Where the photos are. Arrives after construction — the documents directory
  /// is found in parallel with everything else at launch (see `main.dart`) —
  /// and a photographed meal cannot be estimated until it does.
  ImageStore? images;

  /// Whether this account has other devices (see `SyncService`). Kept in step
  /// by `main.dart`.
  ///
  /// It decides one thing: what a queued meal whose photo is *not on this
  /// phone* means. Unpaired, it can only be a photo the user deleted, and the
  /// meal will never be estimated by anybody — so it fails, and says so.
  /// Paired, it is far more likely a meal photographed on the other device,
  /// because meals sync and photos do not (plan §10). Failing that one would be
  /// worse than doing nothing: the `failed` status syncs *back*, and the queue
  /// does not pick failures back up — so this phone would have talked the phone
  /// that actually holds the photo out of ever estimating it.
  bool paired = false;

  /// Three goes at a meal, then it is left `failed` for the user to retry.
  /// A fourth automatic attempt has never been what fixes it, and every one is
  /// billed.
  static const maxAttempts = 3;

  bool _running = false;
  String? _error;
  final Set<String> _inFlight = {};
  int _waiting = 0;

  /// Whether a drain is in progress. One call at a time, deliberately: they run
  /// against a rate limit and a photo each, and nothing here is in a hurry.
  bool get running => _running;

  /// Meals still waiting on an estimate, the one in flight included.
  ///
  /// Survives the end of a drain rather than resetting: a drain that found four
  /// meals and no API key to estimate them with has to leave that four behind
  /// it, because it is the entire argument for [needsKey].
  int get waiting => _waiting;

  /// Why the last drain stopped early, if it did. Not the reason one meal
  /// failed — that is on the meal, as [MealStatus.failed].
  String? get error => _error;

  /// There are meals to estimate and no key to estimate them with. What the
  /// "Connect OpenRouter" banner is for.
  bool get needsKey => !_account.isConnected && _waiting > 0;

  /// Work through everything waiting. Safe to call whenever something may have
  /// added to the queue; returns immediately if a drain is already running.
  Future<void> drain() async {
    if (_running) return;
    _running = true;
    _error = null;
    notifyListeners();

    try {
      final queue = await _meals.pendingMeals();

      // Whittled down before it is counted, because a meal this device cannot
      // do anything about is not one it is waiting to do.
      final mine = <Meal>[];
      for (final meal in queue) {
        if (await _workableHere(meal)) mine.add(meal);
      }

      _waiting = mine.length;
      notifyListeners();

      // Checked *after* counting, so a user with no key still sees how many
      // meals are waiting on one — which is the whole argument for connecting.
      if (mine.isEmpty || !_account.isConnected) return;

      for (final meal in mine) {
        // A meal this drain has already started is one another drain is
        // finishing; a meal the user confirmed by hand while we worked has left
        // the queue behind our back.
        if (_inFlight.contains(meal.subject)) continue;
        await _estimate(meal);
        _waiting--;
        notifyListeners();
      }
    } catch (e) {
      // Reading the queue failed, not estimating one meal. Nothing was written,
      // so the next drain starts from exactly the same place.
      _error = _messageFor(e);
    } finally {
      _running = false;
      notifyListeners();
      // Whatever landed is on the meals, and this is the app's one view of
      // them.
      await _meals.load();
    }
  }

  /// Have another go at one meal — the tap on a `failed` row, and what the
  /// clarify loop will call once there is an answer to re-estimate with.
  Future<void> retry(Meal meal) async {
    if (_inFlight.contains(meal.subject)) return;
    _error = null;
    _waiting++;
    notifyListeners();
    try {
      await _estimate(meal);
    } finally {
      _waiting--;
      notifyListeners();
      await _meals.load();
    }
  }

  /// Stop asking about a meal. What the user answering it by hand looks like
  /// from here — a number typed, or the meal deleted outright.
  ///
  /// On the queue rather than on whoever is deleting because the queue is what
  /// asked: a question outliving its meal is the one way a notification becomes
  /// a dead end.
  Future<void> forget(String subject) async =>
      _notifier?.withdraw(subject);

  /// One meal, from `pending` to `estimated`, `needs-info` or `failed`.
  ///
  /// It is marked `estimating` before the call and the day is re-read, so the
  /// row says what is happening rather than sitting on "waiting" for the ten
  /// seconds a vision model takes. That status is also what a killed app leaves
  /// behind, and `list_pending_meals` counts it as queued for exactly that
  /// reason.
  Future<void> _estimate(Meal meal) async {
    _inFlight.add(meal.subject);
    try {
      await _meals.setStatus(meal.subject, MealStatus.estimating);
      await _meals.load();

      final estimate = await _attempt(meal);
      await _meals.saveEstimate(meal.subject, estimate);
      // Asked here rather than by whoever is looking at the list, because the
      // whole point of a question is that nobody may be looking. Withdrawn on
      // the other branch for the same reason: a re-estimate that has nothing
      // left to ask must not leave the old question sitting on a lock screen.
      if (estimate.clarifyingQuestion.isEmpty) {
        await _notifier?.withdraw(meal.subject);
      } else {
        await _notifier?.ask(meal.subject, estimate.clarifyingQuestion);
      }
    } catch (e) {
      debugPrint('Could not estimate ${meal.subject}: $e');
      try {
        await _meals.setStatus(meal.subject, MealStatus.failed);
      } catch (_) {
        // The store is what just failed. Leaving the meal `estimating` is the
        // recoverable outcome anyway: the next launch finds it in the queue.
      }
    } finally {
      _inFlight.remove(meal.subject);
    }
  }

  /// Call the model, giving a retryable failure another go or two.
  ///
  /// Backoff doubles from a second. It is short on purpose — the user may well
  /// be looking at the screen, and a rate limit that needs longer than a few
  /// seconds needs a lot longer, which is what the `failed` row is for.
  Future<MealEstimate> _attempt(Meal meal) async {
    final photo = await _photoOf(meal);
    final words = _words(meal);
    if (photo == null && words.isEmpty) {
      throw const OpenRouterException(
        'This meal has no photo left and nothing written down',
      );
    }

    var attempt = 1;
    while (true) {
      try {
        return await _client.estimate(
          photo: photo,
          photoPath: meal.imagePath,
          words: words,
        );
      } on OpenRouterException catch (e) {
        if (!e.retryable || attempt >= maxAttempts) rethrow;
        await _wait(Duration(seconds: 1 << (attempt - 1)));
        attempt++;
      }
    }
  }

  /// Whether this drain should attempt [meal] at all.
  ///
  /// Two reasons not to, and neither is the meal's fault:
  ///
  /// - **The photo directory is not known yet.** It is found in parallel with
  ///   the store at launch (see `main.dart`), so a drain can start before there
  ///   is anywhere to read a photo from. `main.dart` fires another drain when
  ///   it lands.
  /// - **The photo is on another phone.** Meals sync and photos do not (plan
  ///   §10), so a paired device sees meals whose files were never written here.
  ///   The phone that took the picture estimates it, and the answer arrives by
  ///   the same sync that brought the meal. See [paired] for why that is a skip
  ///   and not a failure.
  ///
  /// A missing photo on an *unpaired* device is a different thing: the only way
  /// to get one is "delete all photos now" while a meal was still queued, since
  /// the sweep never evicts a photo the estimator still needs
  /// (`ImageStore.sweep`). Nothing will ever estimate that meal, so it is
  /// attempted, fails, and becomes a row the user can retry or delete.
  Future<bool> _workableHere(Meal meal) async {
    if (meal.imagePath.isEmpty) return true;
    final store = images;
    if (store == null) return false;
    if (await store.stateOf(meal.imagePath) == PhotoState.stored) return true;
    return !paired;
  }

  /// The stored image, or null when there is none — a typed meal, a photo the
  /// sweep evicted, or a launch where the documents directory is not known yet.
  Future<Uint8List?> _photoOf(Meal meal) async {
    if (meal.imagePath.isEmpty) return null;
    final file = await images?.load(meal.imagePath);
    return file?.readAsBytes();
  }

  /// What the user told us about this meal. On a typed entry it is everything
  /// the model has to go on; on a photographed one it is empty until they
  /// answer a question.
  ///
  /// Only [Meal.notes] — never the name or the description, which after one
  /// estimate are the model's own words. Handing those back as "the person who
  /// logged it wrote" would be a lie that compounds every round.
  static String _words(Meal meal) => meal.notes.trim();

  static Future<void> _realWait(Duration d) => Future.delayed(d);

  static String _messageFor(Object e) {
    final text = e.toString();
    return text.startsWith('Exception: ') ? text.substring(11) : text;
  }
}
