import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/meal_suggestions.dart';
import 'package:flutter_test/flutter_test.dart';

/// The frequency baseline of `calorie-tracker-embeddings.md` §7 — what the
/// viewfinder offers before there is an encoder, below the similarity threshold
/// once there is one, and the number the embedding has to beat.
///
/// Plain `test()`s over a pure function: `MealSuggestions.frequent` takes the
/// history and the instant, so every case here is stated as data rather than
/// arranged through a store.
void main() {
  final now = DateTime(2026, 8, 6, 12);

  var nextId = 0;
  Meal meal(
    String name, {
    required int daysAgo,
    int calories = 400,
    MealStatus status = MealStatus.estimated,
    String copiedFrom = '',
    String subject = '',
    String imagePath = '',
  }) =>
      Meal(
        subject: subject.isEmpty ? 'did:ad:meal:${nextId++}' : subject,
        name: name,
        description: '',
        consumedAt: now.subtract(Duration(days: daysAgo, hours: 1)),
        status: status,
        calories: calories,
        copiedFromMeal: copiedFrom,
        imagePath: imagePath,
      );

  List<MealSuggestion> suggest(List<Meal> meals) =>
      MealSuggestions.frequent(meals, now: now);

  List<String> namesOf(List<MealSuggestion> suggestions) =>
      suggestions.map((s) => s.name).toList();

  /// §8: "Cold start is silence." No spinner, no empty state, no explanation —
  /// the row simply is not there until the feature works.
  test('a fresh install is offered nothing', () {
    expect(suggest([]), isEmpty);
  });

  test('a meal logged once is something that happened, not a habit', () {
    expect(suggest([meal('Cheese sandwich', daysAgo: 1)]), isEmpty);
  });

  test('the most-logged meals come first, four at most', () {
    final meals = [
      for (var i = 0; i < 5; i++) meal('Porridge', daysAgo: i),
      for (var i = 0; i < 4; i++) meal('Cheese sandwich', daysAgo: i),
      for (var i = 0; i < 3; i++) meal('Ramen', daysAgo: i),
      for (var i = 0; i < 2; i++) meal('Apple', daysAgo: i),
      for (var i = 0; i < 2; i++) meal('Yoghurt', daysAgo: i),
    ];

    expect(
      namesOf(suggest(meals)),
      ['Porridge', 'Cheese sandwich', 'Ramen', 'Apple'],
    );
  });

  /// §7: four suggestions should be four different meals. Someone who eats the
  /// same breakfast forty times would otherwise get four chips that are all it.
  test('the same meal is one chip however many times it was logged', () {
    final suggestions = suggest([
      for (var i = 0; i < 10; i++) meal('Porridge', daysAgo: i),
      for (var i = 0; i < 2; i++) meal('Ramen', daysAgo: i),
    ]);

    expect(namesOf(suggestions), ['Porridge', 'Ramen']);
    expect(suggestions.first.timesLogged, 10);
  });

  test('case and stray whitespace are not differences between meals', () {
    final suggestions = suggest([
      meal('Cheese sandwich', daysAgo: 1),
      meal('cheese sandwich ', daysAgo: 2),
    ]);

    expect(suggestions, hasLength(1));
    expect(suggestions.single.timesLogged, 2);
  });

  /// Lineage is the stronger claim: a copy took its numbers from the original,
  /// so they are the same meal even after one of them is renamed by hand.
  test('a renamed copy stays with the meal it copied', () {
    final original = meal('Cheese sandwich', daysAgo: 3, subject: 'did:ad:1');
    final renamed = meal(
      'Sandwich, cheese',
      daysAgo: 1,
      copiedFrom: 'did:ad:1',
    );

    final suggestions = suggest([original, renamed]);

    expect(suggestions, hasLength(1));
    expect(suggestions.single.timesLogged, 2);
  });

  /// A chip has to name a meal that can actually be copied from. The bridge
  /// resolves a copy through to its original at write time; the suggestion
  /// carries the same subject so the two agree.
  test('a suggestion points at the original, never at a copy of it', () {
    final suggestions = suggest([
      meal('Porridge', daysAgo: 5, subject: 'did:ad:original'),
      meal('Porridge', daysAgo: 1, copiedFrom: 'did:ad:original'),
    ]);

    expect(suggestions.single.sourceSubject, 'did:ad:original');
  });

  /// §7: "Prefer recency between near-equal candidates. If a sandwich was 380
  /// kcal last month and 420 last week, last week is the better prior."
  test('the newest of a group is the one whose numbers a tap would take', () {
    final suggestions = suggest([
      meal('Cheese sandwich', daysAgo: 20, calories: 380),
      meal('Cheese sandwich', daysAgo: 2, calories: 420, imagePath: 'photos/a.jpg'),
    ]);

    expect(suggestions.single.calories, 420);
    expect(suggestions.single.imagePath, 'photos/a.jpg');
    expect(suggestions.single.lastEatenAt, now.subtract(const Duration(days: 2, hours: 1)));
  });

  test('equally frequent meals are ordered by which was eaten most recently', () {
    final suggestions = suggest([
      for (var i = 0; i < 2; i++) meal('Ramen', daysAgo: 20 + i),
      for (var i = 0; i < 2; i++) meal('Porridge', daysAgo: 1 + i),
    ]);

    expect(namesOf(suggestions), ['Porridge', 'Ramen']);
  });

  /// §7: only meals with a calorie number and a settled status. A `pending`,
  /// `failed` or `needs-info` meal is not an answer to anything.
  test('only meals that are an answer to something are offered', () {
    final unsettled = [
      for (final status in [
        MealStatus.pending,
        MealStatus.estimating,
        MealStatus.needsInfo,
        MealStatus.failed,
      ]) ...[
        meal('Mystery', daysAgo: 1, status: status),
        meal('Mystery', daysAgo: 2, status: status),
      ],
    ];

    expect(suggest(unsettled), isEmpty);
  });

  test('a meal nobody has put a number on is not offered', () {
    final noNumber = [
      for (var i = 0; i < 3; i++)
        Meal(
          subject: 'did:ad:none:$i',
          name: 'Something',
          description: '',
          consumedAt: now.subtract(Duration(days: i + 1)),
          status: MealStatus.estimated,
        ),
    ];

    expect(suggest(noNumber), isEmpty);
  });

  test('a meal with no name yet has nothing to put on a chip', () {
    expect(suggest([for (var i = 0; i < 3; i++) meal('', daysAgo: i)]), isEmpty);
  });

  test('what was eaten before the window does not count towards frequency', () {
    final suggestions = suggest([
      meal('Porridge', daysAgo: 1),
      meal('Porridge', daysAgo: 40),
      meal('Porridge', daysAgo: 50),
    ]);

    expect(
      suggestions,
      isEmpty,
      reason: 'once inside 30 days is once, whatever the year before held',
    );
  });

  /// Not a real case, but the history is a range query and a clock that went
  /// backwards should not be able to put a meal in the future on a chip.
  test('a meal in the future is not history', () {
    expect(suggest([for (var i = 0; i < 3; i++) meal('Later', daysAgo: -i - 1)]),
        isEmpty);
  });
}
