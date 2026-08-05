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

  int nextId = 1;

  @override
  Future<String> create({
    required DateTime consumedAt,
    String name = '',
    String description = '',
    String imagePath = '',
    int? calories,
  }) async {
    if (writeError != null) throw writeError!;

    final subject = 'did:ad:meal:${nextId++}';
    meals.add(Meal(
      subject: subject,
      name: name,
      description: description,
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
    String? description,
    int? calories,
  }) async {
    if (writeError != null) throw writeError!;

    final index = meals.indexWhere((m) => m.subject == subject);
    if (index < 0) throw Exception('No such meal');
    final old = meals[index];

    meals[index] = Meal(
      subject: old.subject,
      name: name ?? old.name,
      description: description ?? old.description,
      consumedAt: old.consumedAt,
      status: calories == null ? old.status : MealStatus.confirmed,
      calories: calories ?? old.calories,
      caloriesMin: old.caloriesMin,
      caloriesMax: old.caloriesMax,
      imagePath: old.imagePath,
    );
  }

  @override
  Future<void> delete(String subject) async {
    if (writeError != null) throw writeError!;
    meals.removeWhere((m) => m.subject == subject);
  }

  @override
  Future<List<Meal>> list(int fromMs, int toMs) async {
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
