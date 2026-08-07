import 'package:flutter/foundation.dart';

import '../atomic/atomic_client.dart';
import '../models/meal.dart';
import 'meal_encoder.dart';

/// Everything the app does to meals.
///
/// A seam for the same reason [AtomicBackend] is one: the test VM has no Rust
/// library, and day totals, the day boundary and the edit flow are exactly what
/// wants covering by fast tests. [FfiMealBackend] is the real one.
abstract class MealBackend {
  /// Returns the new meal's subject.
  Future<String> create({
    required DateTime consumedAt,
    String name,
    String notes,
    String imagePath,
    int? calories,
  });

  /// A null argument leaves that field as it was.
  Future<void> update(
    String subject, {
    String? name,
    String? notes,
    int? calories,
  });

  /// Log a meal by recognising [sourceSubject], taking its numbers. Returns the
  /// new meal's subject.
  Future<String> copyFrom(
    String sourceSubject, {
    required DateTime consumedAt,
    String imagePath,
  });

  Future<void> delete(String subject);

  /// Meals in `[fromMs, toMs)`, newest first.
  Future<List<Meal>> list(int fromMs, int toMs);

  /// One meal, or null when it is not there any more.
  Future<Meal?> bySubject(String subject);

  /// Meals with no number on them yet, oldest first — the estimator's queue.
  Future<List<Meal>> listPending();

  /// Move a meal to another status. What the queue does on its way in
  /// ([MealStatus.estimating]) and on its way out of a bad attempt
  /// ([MealStatus.failed]).
  Future<void> setStatus(String subject, MealStatus status);

  /// Write an estimate. Leaves a [MealStatus.confirmed] meal alone.
  Future<void> applyEstimate(String subject, MealEstimate estimate);

  /// Attach an image embedding, with the encoder that produced it. The two are
  /// written together and cleared together — a vector whose encoder is unknown
  /// cannot be compared to anything, so it is meaningless rather than partial.
  Future<void> setEmbedding(String subject, MealEmbedding embedding);
}

class FfiMealBackend implements MealBackend {
  const FfiMealBackend();

  @override
  Future<String> create({
    required DateTime consumedAt,
    String name = '',
    String notes = '',
    String imagePath = '',
    int? calories,
  }) =>
      AtomicClient.createMeal(
        consumedAtMs: consumedAt.millisecondsSinceEpoch,
        name: name,
        notes: notes,
        imagePath: imagePath,
        calories: calories,
      );

  @override
  Future<void> update(
    String subject, {
    String? name,
    String? notes,
    int? calories,
  }) =>
      AtomicClient.updateMeal(
        subject,
        name: name,
        notes: notes,
        calories: calories,
      );

  @override
  Future<String> copyFrom(
    String sourceSubject, {
    required DateTime consumedAt,
    String imagePath = '',
  }) =>
      AtomicClient.copyMeal(
        sourceSubject: sourceSubject,
        consumedAtMs: consumedAt.millisecondsSinceEpoch,
        imagePath: imagePath,
      );

  @override
  Future<void> delete(String subject) => AtomicClient.deleteResource(subject);

  @override
  Future<List<Meal>> list(int fromMs, int toMs) async {
    final items = await AtomicClient.listMeals(fromMs, toMs);
    return items.map(Meal.fromItem).toList();
  }

  @override
  Future<Meal?> bySubject(String subject) async {
    final item = await AtomicClient.getMeal(subject);
    return item == null ? null : Meal.fromItem(item);
  }

  @override
  Future<List<Meal>> listPending() async {
    final items = await AtomicClient.listPendingMeals();
    return items.map(Meal.fromItem).toList();
  }

  @override
  Future<void> setStatus(String subject, MealStatus status) =>
      AtomicClient.setMealStatus(subject, status.wire);

  @override
  Future<void> applyEstimate(String subject, MealEstimate estimate) =>
      AtomicClient.updateMealEstimate(subject, estimate.toItem());

  @override
  Future<void> setEmbedding(String subject, MealEmbedding embedding) =>
      AtomicClient.setMealEmbedding(
        subject,
        embedding: embedding.base64,
        model: embedding.modelId,
      );
}

/// The meals of one day, and what can be done to them.
///
/// Holds a single day rather than everything: the screens that exist are a day
/// at a time, and a store that kept the whole history in memory would have to
/// decide when to drop it. [showDay] is how the history screen will move.
class MealStore extends ChangeNotifier {
  MealStore({MealBackend backend = const FfiMealBackend(), DateTime? day})
      : _backend = backend,
        _day = day ?? DateTime.now();

  final MealBackend _backend;

  DateTime _day;
  List<Meal> _meals = const [];
  bool _loading = false;
  String? _error;

  /// The day being shown. Only its date part means anything.
  DateTime get day => _day;

  /// Newest first, as [MealBackend.list] returns them.
  List<Meal> get meals => List.unmodifiable(_meals);

  bool get loading => _loading;

  /// Why the last thing failed, in the words the layer below used.
  String? get error => _error;

  DaySummary get summary => DaySummary.of(_meals);

  bool get isToday {
    final now = DateTime.now();
    return _day.year == now.year &&
        _day.month == now.month &&
        _day.day == now.day;
  }

  /// Read the day again. Safe to call whenever something may have changed it.
  Future<void> load() async {
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final bounds = localDayBounds(_day);
      _meals = await _backend.list(bounds.fromMs, bounds.toMs);
    } catch (e) {
      _error = _messageFor(e);
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// Every meal there is, not just the day on screen, and not held on to.
  ///
  /// The photo sweep is the only caller and the only thing that should be: what
  /// to evict is a decision about the whole history, and a store that kept all
  /// of it in memory would have to decide when to let go again.
  Future<List<Meal>> allMeals() => _backend.list(_minMs, _maxMs);

  /// The meals of the local days from [from] to [to] inclusive, newest first.
  ///
  /// One query rather than one per day: the history screen groups them with
  /// [groupByLocalDay], which is the same arithmetic the bridge would do and
  /// cheaper done once.
  Future<List<Meal>> mealsAcross(DateTime from, DateTime to) {
    final start = localDayBounds(from).fromMs;
    final end = localDayBounds(to).toMs;
    return _backend.list(start, end);
  }

  /// One meal as the database has it now, or null if it is gone.
  ///
  /// What a notification tap resolves through: it names a subject and the meal
  /// may have been deleted, or answered, since it was posted.
  Future<Meal?> mealAt(String subject) => _backend.bySubject(subject);

  /// A second store over another day, talking to the same backend.
  ///
  /// How the history screen opens a day: the day view is the same screen as
  /// today's, and giving it its own store keeps it from dragging the day behind
  /// the viewfinder along with it.
  MealStore viewOf(DateTime day) => MealStore(backend: _backend, day: day);

  /// The full range `DateTime` can express, so "all of them" needs no special
  /// case in the bridge — it is the same half-open query as a day.
  static const _minMs = -8640000000000000;
  static const _maxMs = 8640000000000000;

  Future<void> showDay(DateTime day) {
    _day = day;
    _meals = const [];
    return load();
  }

  /// Log a meal. [consumedAt] defaults to now, which is what a manual entry
  /// almost always means — the exception is backfilling, which is why it can be
  /// passed.
  ///
  /// A meal eaten on another day is written all the same and simply isn't in
  /// this day's list; silently refusing it would lose what the user typed.
  ///
  /// Everything is optional because a photographed meal has none of it yet: no
  /// name, no number, just an [imagePath] and the instant the shutter went. The
  /// bridge reads that as `pending`, which is the queue Phase 4 drains.
  Future<void> logMeal({
    String name = '',
    int? calories,
    String notes = '',
    String imagePath = '',
    DateTime? consumedAt,
  }) async {
    await _guard(() => _backend.create(
          consumedAt: consumedAt ?? DateTime.now(),
          name: name,
          notes: notes,
          imagePath: imagePath,
          calories: calories,
        ));
  }

  /// Log a meal by recognising an earlier one, taking its numbers wholesale.
  /// Returns the new meal's subject, or null when the write failed — in which
  /// case [error] says why.
  ///
  /// The subject comes back because the tap that produced it offers an undo, and
  /// undoing means deleting *this* meal. Nothing else this store writes needs to
  /// be identified after the fact, which is why [logMeal] does not do the same.
  Future<String?> logLike(
    String sourceSubject, {
    String imagePath = '',
    DateTime? consumedAt,
  }) async {
    _error = null;
    String subject;
    try {
      subject = await _backend.copyFrom(
        sourceSubject,
        consumedAt: consumedAt ?? DateTime.now(),
        imagePath: imagePath,
      );
    } catch (e) {
      _error = _messageFor(e);
      notifyListeners();
      return null;
    }
    await load();
    return subject;
  }

  Future<void> editMeal(
    String subject, {
    String? name,
    String? notes,
    int? calories,
  }) async {
    await _guard(() => _backend.update(
          subject,
          name: name,
          notes: notes,
          calories: calories,
        ));
  }

  Future<void> deleteMeal(String subject) async {
    await _guard(() => _backend.delete(subject));
  }

  // ── The estimator's writes ───────────────────────────────────────────────
  //
  // Deliberately not behind `_guard`: it swallows the error into [error] and
  // re-reads the day after every write, and the queue wants neither. It works
  // through a list and needs to know which meal threw, and it reloads once a
  // meal is finished with rather than three times on the way.

  Future<List<Meal>> pendingMeals() => _backend.listPending();

  Future<void> setStatus(String subject, MealStatus status) =>
      _backend.setStatus(subject, status);

  Future<void> saveEstimate(String subject, MealEstimate estimate) =>
      _backend.applyEstimate(subject, estimate);

  /// Deliberately does not re-read the day, unlike every other write here: an
  /// embedding changes nothing anybody is looking at, and a backfill over a
  /// year of history would otherwise re-query and rebuild the visible list once
  /// per meal while the user is trying to use the app.
  Future<void> saveEmbedding(String subject, MealEmbedding embedding) =>
      _backend.setEmbedding(subject, embedding);

  /// Run a write, then re-read the day.
  ///
  /// Re-reading rather than patching the list in place: the store is not the
  /// only writer — Phase 4's estimator and a sync from another device both
  /// change meals underneath it — so the list after a write is a question for
  /// the database, not an assumption.
  Future<void> _guard(Future<void> Function() write) async {
    _error = null;
    try {
      await write();
    } catch (e) {
      _error = _messageFor(e);
      notifyListeners();
      return;
    }
    await load();
  }

  /// Bridge errors arrive as `Exception: <what Rust said>`; the prefix is noise
  /// on a screen and the rest is the only clue there is.
  static String _messageFor(Object e) {
    final text = e.toString();
    return text.startsWith('Exception: ') ? text.substring(11) : text;
  }
}
