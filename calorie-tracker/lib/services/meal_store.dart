import 'package:flutter/foundation.dart';

import '../atomic/atomic_client.dart';
import '../models/meal.dart';

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
    String description,
    String imagePath,
    int? calories,
  });

  /// A null argument leaves that field as it was.
  Future<void> update(
    String subject, {
    String? name,
    String? description,
    int? calories,
  });

  Future<void> delete(String subject);

  /// Meals in `[fromMs, toMs)`, newest first.
  Future<List<Meal>> list(int fromMs, int toMs);
}

class FfiMealBackend implements MealBackend {
  const FfiMealBackend();

  @override
  Future<String> create({
    required DateTime consumedAt,
    String name = '',
    String description = '',
    String imagePath = '',
    int? calories,
  }) =>
      AtomicClient.createMeal(
        consumedAtMs: consumedAt.millisecondsSinceEpoch,
        name: name,
        description: description,
        imagePath: imagePath,
        calories: calories,
      );

  @override
  Future<void> update(
    String subject, {
    String? name,
    String? description,
    int? calories,
  }) =>
      AtomicClient.updateMeal(
        subject,
        name: name,
        description: description,
        calories: calories,
      );

  @override
  Future<void> delete(String subject) => AtomicClient.deleteResource(subject);

  @override
  Future<List<Meal>> list(int fromMs, int toMs) async {
    final items = await AtomicClient.listMeals(fromMs, toMs);
    return items.map(Meal.fromItem).toList();
  }
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
    String description = '',
    String imagePath = '',
    DateTime? consumedAt,
  }) async {
    await _guard(() => _backend.create(
          consumedAt: consumedAt ?? DateTime.now(),
          name: name,
          description: description,
          imagePath: imagePath,
          calories: calories,
        ));
  }

  Future<void> editMeal(
    String subject, {
    String? name,
    String? description,
    int? calories,
  }) async {
    await _guard(() => _backend.update(
          subject,
          name: name,
          description: description,
          calories: calories,
        ));
  }

  Future<void> deleteMeal(String subject) async {
    await _guard(() => _backend.delete(subject));
  }

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
