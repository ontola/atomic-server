import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/meal_store.dart';

/// The meals table, as `rust/src/api/meals.rs` keeps it.
///
/// It models the two things about the bridge the Dart side actually depends on
/// and could get wrong: a calorie count makes a meal `confirmed`, and
/// [list] is a half-open range over the *stored* instants. Everything the store
/// asks of a day boundary goes through those.
class FakeMealBackend implements MealBackend {
  final List<Meal> meals = [];

  /// Thrown by the next write, for the "it did not save" path.
  Object? writeError;

  /// Thrown by the next read, for the "the queue could not even start" path.
  Object? readError;

  int nextId = 1;

  @override
  Future<String> create({
    required DateTime consumedAt,
    String name = '',
    String notes = '',
    String imagePath = '',
    int? calories,
  }) async {
    if (writeError != null) throw writeError!;

    final subject = 'did:ad:meal:${nextId++}';
    meals.add(Meal(
      subject: subject,
      name: name,
      description: '',
      notes: notes,
      consumedAt: consumedAt,
      status: calories == null ? MealStatus.pending : MealStatus.confirmed,
      calories: calories,
      imagePath: imagePath,
    ));
    return subject;
  }

  @override
  Future<void> update(
    String subject, {
    String? name,
    String? notes,
    int? calories,
  }) async {
    if (writeError != null) throw writeError!;

    final index = meals.indexWhere((m) => m.subject == subject);
    if (index < 0) throw Exception('No such meal');

    meals[index] = _copy(
      meals[index],
      name: name,
      notes: notes,
      calories: calories,
      status: calories == null ? null : MealStatus.confirmed,
    );
  }

  @override
  Future<Meal?> bySubject(String subject) async {
    if (readError != null) throw readError!;

    final index = meals.indexWhere((m) => m.subject == subject);
    return index < 0 ? null : meals[index];
  }

  @override
  Future<void> delete(String subject) async {
    if (writeError != null) throw writeError!;
    meals.removeWhere((m) => m.subject == subject);
  }

  /// Oldest first, and only what the estimator would pick up — the same rule
  /// `list_pending_meals` applies, `estimating` included, because a meal left
  /// in that state by a killed app is one nobody else is going to finish.
  @override
  Future<List<Meal>> listPending() async {
    if (readError != null) throw readError!;

    final hits = meals.where((m) => m.status.isQueued).toList()
      ..sort((a, b) => a.consumedAt.compareTo(b.consumedAt));
    return hits;
  }

  @override
  Future<void> setStatus(String subject, MealStatus status) async {
    if (writeError != null) throw writeError!;
    _replace(subject, (old) => _copy(old, status: status));
  }

  /// The rules `update_meal_estimate` applies, which the queue leans on: a
  /// confirmed meal is left alone, and a question is what makes a meal
  /// `needs-info` rather than `estimated`.
  @override
  Future<void> applyEstimate(String subject, MealEstimate estimate) async {
    if (writeError != null) throw writeError!;

    _replace(subject, (old) {
      if (old.status == MealStatus.confirmed) return old;
      return _copy(
        old,
        name: estimate.name,
        description: estimate.description,
        status: estimate.clarifyingQuestion.isEmpty
            ? MealStatus.estimated
            : MealStatus.needsInfo,
        calories: estimate.calories,
        caloriesMin: estimate.caloriesMin,
        caloriesMax: estimate.caloriesMax,
        confidence: estimate.confidence,
        estimatedByModel: estimate.model,
        clarifyingQuestion: estimate.clarifyingQuestion,
      );
    });
  }

  void _replace(String subject, Meal Function(Meal) change) {
    final index = meals.indexWhere((m) => m.subject == subject);
    if (index < 0) throw Exception('No such meal');
    meals[index] = change(meals[index]);
  }

  /// A meal with some fields replaced. Here rather than on [Meal] itself
  /// because nothing in the app ever needs one: the store re-reads the table
  /// after a write instead of patching a copy in memory, which is the whole
  /// reason a second writer — the estimator — does not corrupt what is on
  /// screen.
  static Meal _copy(
    Meal old, {
    String? name,
    String? description,
    String? notes,
    MealStatus? status,
    int? calories,
    int? caloriesMin,
    int? caloriesMax,
    MealConfidence? confidence,
    String? estimatedByModel,
    String? clarifyingQuestion,
  }) =>
      Meal(
        subject: old.subject,
        name: name ?? old.name,
        description: description ?? old.description,
        // Never passed by [applyEstimate], which is the point: `meal-notes` is
        // the one text an estimate does not write, so the answer the eater gave
        // survives every round of the clarify loop.
        notes: notes ?? old.notes,
        consumedAt: old.consumedAt,
        status: status ?? old.status,
        calories: calories ?? old.calories,
        caloriesMin: caloriesMin ?? old.caloriesMin,
        caloriesMax: caloriesMax ?? old.caloriesMax,
        imagePath: old.imagePath,
        confidence: confidence ?? old.confidence,
        estimatedByModel: estimatedByModel ?? old.estimatedByModel,
        clarifyingQuestion: clarifyingQuestion ?? old.clarifyingQuestion,
        proteinGrams: old.proteinGrams,
        carbsGrams: old.carbsGrams,
        fatGrams: old.fatGrams,
      );

  @override
  Future<List<Meal>> list(int fromMs, int toMs) async {
    if (readError != null) throw readError!;

    final hits = meals.where((m) {
      final at = m.consumedAt.millisecondsSinceEpoch;
      return at >= fromMs && at < toMs;
    }).toList();
    hits.sort((a, b) => b.consumedAt.compareTo(a.consumedAt));
    return hits;
  }

  /// Put a meal in the table directly — for the states no write reaches, like
  /// an estimate with bounds.
  void seed(Meal meal) => meals.add(meal);
}
