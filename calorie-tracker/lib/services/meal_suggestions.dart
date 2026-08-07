import '../models/meal.dart';

/// A past meal offered as a way to log the one in front of the camera.
///
/// Tapping one logs a `confirmed` meal carrying [sourceSubject]'s numbers, with
/// no model call and no waiting. It is the whole of what a suggestion is worth,
/// so everything here exists to be shown on a chip or written to the copy.
class MealSuggestion {
  const MealSuggestion({
    required this.sourceSubject,
    required this.name,
    required this.calories,
    required this.lastEatenAt,
    required this.timesLogged,
    this.imagePath = '',
  });

  /// The meal whose numbers a tap takes. Always an original rather than a copy
  /// of one — see [Meal.lineage] — so the chip and the resulting
  /// `copied-from-meal` name the same resource.
  final String sourceSubject;

  final String name;

  /// Never null: a suggestion with no number saves nobody an estimate, and
  /// [MealSuggestions.frequent] filters those out before ranking.
  final int calories;

  /// When this was last eaten, which the chip renders as "2 days ago" and which
  /// breaks ties between equally frequent meals.
  final DateTime lastEatenAt;

  /// How many times this meal has been logged inside the window. What "most
  /// logged" is measured in, and why one-off meals are not offered.
  final int timesLogged;

  /// The representative's photo, for the chip's thumbnail. May be evicted by the
  /// time it is drawn, which `MealThumbnail` already treats as ordinary.
  final String imagePath;
}

/// Which past meals to offer, when nothing has been recognised.
///
/// This is the **frequency baseline** of `calorie-tracker-embeddings.md` §7, and
/// it is not scaffolding that Phase 7.3 threw away. It is what gets shown below
/// the similarity threshold and on a phone that has never embedded anything, so
/// it has to exist regardless — and it is the honest baseline the embedding has
/// to *beat* during calibration. If "the four things you eat most" turns out to
/// capture most of the value, that is worth learning from the data rather than
/// assuming either way.
abstract final class MealSuggestions {
  /// How far back "most-logged recently" looks.
  static const window = Duration(days: 30);

  /// Four, because that is what fits above the shutter without crowding it.
  static const limit = 4;

  /// Below this, a meal is something that happened rather than something the
  /// eater does.
  ///
  /// It is also what makes cold start silent: on a fresh install nothing has
  /// been logged twice, so the row is absent rather than showing a
  /// single breakfast back at somebody who has used the app once. §8 asks for
  /// nothing at all until the feature works — no spinner, no empty state.
  ///
  /// It applies to *frequency* only. A meal the camera actually recognises is
  /// offered the first time it comes round again, which is the whole difference
  /// between the two rankings.
  static const minTimesLogged = 2;

  /// The most-logged distinct meals of the last [window], newest-tied-first.
  ///
  /// [meals] is the history to draw on and [now] the instant the window ends —
  /// passed rather than read so this is a pure function, which is what lets the
  /// tests state the interesting cases as data.
  static List<MealSuggestion> frequent(
    Iterable<Meal> meals, {
    required DateTime now,
    int limit = limit,
  }) {
    final since = now.subtract(window);

    final groups = groupsOf(meals.where((m) =>
        isCopyable(m) &&
        m.consumedAt.isAfter(since) &&
        !m.consumedAt.isAfter(now)));

    final ranked = groups
      ..sort((a, b) {
        // Frequency first, because that is what this ranks by; then recency,
        // because a sandwich that was 420 kcal last week is a better prior than
        // the one that was 380 last month.
        final byCount = b.meals.length.compareTo(a.meals.length);
        if (byCount != 0) return byCount;
        return b.newest.consumedAt.compareTo(a.newest.consumedAt);
      });

    return [
      for (final group in ranked)
        if (group.meals.length >= minTimesLogged) group.suggestion,
    ].take(limit).toList();
  }

  /// Whether a tap on this meal would produce a meal worth having.
  ///
  /// §7: only meals with a calorie number and a settled status. A `pending`,
  /// `failed` or `needs-info` meal is not an answer to anything, and one with no
  /// name has nothing to put on a chip.
  static bool isCopyable(Meal meal) =>
      meal.status.isSettled && meal.calories != null && meal.name.isNotEmpty;

  /// Meals collapsed into the distinct *things* they are, in no order.
  ///
  /// Shared by the frequency ranking and by the similarity index, because both
  /// answer the same question about identity: four suggestions should be four
  /// different meals, however the four were chosen. Someone who eats the same
  /// breakfast forty times would otherwise get four chips that are all that
  /// breakfast.
  ///
  /// Two passes. **Lineage first**, because it is the stronger claim: a copy
  /// took its numbers from the original, so they are the same meal whatever
  /// either ended up being called. **Then name**, which merges lineages that
  /// came out alike — meals estimated from separate photos that are plainly the
  /// same food.
  static List<MealGroup> groupsOf(Iterable<Meal> meals) {
    final byLineage = <String, MealGroup>{};
    for (final meal in meals) {
      byLineage.putIfAbsent(meal.lineage, MealGroup.new).add(meal);
    }

    final byName = <String, MealGroup>{};
    for (final group in byLineage.values) {
      final key = _normaliseName(group.newest.name);
      final existing = byName[key];
      if (existing == null) {
        byName[key] = group;
      } else {
        existing.absorb(group);
      }
    }
    return byName.values.toList();
  }

  /// Case and surrounding whitespace are not differences between meals. Nothing
  /// cleverer — "Cheese sandwich" and "Cheese sandwiches" staying apart is the
  /// safe failure, since it costs a duplicate chip rather than a wrong number.
  static String _normaliseName(String name) => name.trim().toLowerCase();
}

/// The meals that are all the same meal, and which of them speaks for the rest.
class MealGroup {
  final List<Meal> meals = [];

  /// The most recent member, which represents the group: it is the last thing
  /// the user actually agreed to, and its photo is the one most likely to still
  /// be on disk. Also where §7's recency preference comes from.
  late Meal newest;

  void add(Meal meal) {
    if (meals.isEmpty || meal.consumedAt.isAfter(newest.consumedAt)) {
      newest = meal;
    }
    meals.add(meal);
  }

  void absorb(MealGroup other) {
    for (final meal in other.meals) {
      add(meal);
    }
  }

  MealSuggestion get suggestion => MealSuggestion(
        sourceSubject: newest.lineage,
        name: newest.name,
        calories: newest.calories!,
        lastEatenAt: newest.consumedAt,
        timesLogged: meals.length,
        imagePath: newest.imagePath,
      );

  /// The last thing the *eater* wrote about this meal, or empty.
  ///
  /// `meal-notes` and nothing else — never `description`, never `name`. This is
  /// the only text that leaves this file for a model prompt (Phase 7.4), and
  /// keeping the choice here rather than at the call site is what makes the
  /// invariant Phase 5 exists to protect a property of one line instead of a
  /// rule somebody has to remember.
  String get notes {
    Meal? latest;
    for (final meal in meals) {
      if (meal.notes.trim().isEmpty) continue;
      if (latest == null || meal.consumedAt.isAfter(latest.consumedAt)) {
        latest = meal;
      }
    }
    return latest?.notes.trim() ?? '';
  }
}
