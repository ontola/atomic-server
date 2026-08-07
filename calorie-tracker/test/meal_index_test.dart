import 'dart:math' as math;
import 'dart:typed_data';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/meal_encoder.dart';
import 'package:calorie_tracker/services/meal_index.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_meal_backend.dart';

/// The decoded matrix and the scan over it (`calorie-tracker-embeddings.md` §7).
///
/// No model anywhere in here. The vectors are written by hand, because what is
/// worth testing is which meals are in the index at all, what counts as one
/// meal, and what a scan does with a tie — none of which is about the encoder,
/// and all of which decides whether a chip names the right meal.
void main() {
  const model = 'fake-encoder-v1';
  final now = DateTime(2026, 8, 6, 12);

  /// Unit vectors far enough apart to be different meals: one axis each.
  Float32List axis(int which, {int length = 8}) {
    final vector = Float32List(length);
    vector[which % length] = 1;
    return vector;
  }

  /// A vector [degrees] off [which], for the "near, but not that near" cases
  /// the two thresholds live between.
  Float32List near(int which, double degrees, {int length = 8}) {
    final vector = Float32List(length);
    final radians = degrees * math.pi / 180;
    vector[which % length] = math.cos(radians);
    vector[(which + 1) % length] = math.sin(radians);
    return vector;
  }

  var nextId = 0;
  Meal meal(
    String name, {
    required int daysAgo,
    Float32List? vector,
    int calories = 400,
    MealStatus status = MealStatus.estimated,
    String copiedFrom = '',
    String subject = '',
    String notes = '',
    String description = '',
    String embeddedBy = model,
  }) =>
      Meal(
        subject: subject.isEmpty ? 'did:ad:meal:${nextId++}' : subject,
        name: name,
        description: description,
        notes: notes,
        consumedAt: now.subtract(Duration(days: daysAgo, hours: 1)),
        status: status,
        calories: calories,
        copiedFromMeal: copiedFrom,
        imagePath: 'photos/$nextId.jpg',
        embedding: vector == null ? '' : DinoV2Encoder.encodeVector(vector),
        embeddedByModel: vector == null ? '' : embeddedBy,
      );

  Future<MealIndex> indexOf(List<Meal> meals) async {
    final backend = FakeMealBackend();
    for (final m in meals) {
      backend.seed(m);
    }
    final index = MealIndex(meals: MealStore(backend: backend), modelId: model);
    await index.refresh();
    return index;
  }

  test('a fresh install has nothing to match against', () async {
    final index = await indexOf([]);

    expect(index.isEmpty, isTrue);
    expect(index.nearest(axis(0)), isEmpty);
  });

  test('the closest meal comes first', () async {
    final index = await indexOf([
      meal('Porridge', daysAgo: 1, vector: axis(0)),
      meal('Ramen', daysAgo: 2, vector: axis(1)),
      meal('Cheese sandwich', daysAgo: 3, vector: axis(2)),
    ]);

    final best = index.nearest(axis(1)).first;

    expect(best.suggestion.name, 'Ramen');
    expect(best.score, closeTo(1.0, 0.02));
  });

  test('the score is a cosine, so a near miss scores near', () async {
    final index = await indexOf([meal('Porridge', daysAgo: 1, vector: axis(0))]);

    expect(index.nearest(near(0, 60)).single.score, closeTo(0.5, 0.02));
  });

  /// §7: four suggestions should be four different meals. The forty logs of one
  /// breakfast are one candidate, and the index is where that has to hold —
  /// otherwise the whole chip row is that breakfast at four slightly different
  /// scores.
  test('the same meal is one entry however many times it was photographed',
      () async {
    final index = await indexOf([
      for (var i = 0; i < 5; i++)
        meal('Porridge', daysAgo: i, vector: near(0, i * 2.0)),
      meal('Ramen', daysAgo: 1, vector: axis(3)),
    ]);

    expect(index.size, 2);
    expect(index.nearest(axis(0)).map((m) => m.suggestion.name), ['Porridge', 'Ramen']);
  });

  /// §7: "take the best-scoring representative of each". A meal photographed
  /// from five angles should be found by whichever angle the camera is at, not
  /// by the average of them.
  test('a group scores as its best photograph, not its newest', () async {
    final index = await indexOf([
      meal('Porridge', daysAgo: 9, vector: axis(0)),
      // The newest one is the one whose numbers a tap takes, and it looks
      // nothing like what is in frame.
      meal('Porridge', daysAgo: 1, vector: axis(5), calories: 420,
          copiedFrom: 'did:ad:porridge'),
      meal('Porridge', daysAgo: 9, vector: axis(0), subject: 'did:ad:porridge'),
    ]);

    final match = index.nearest(axis(0)).single;

    expect(match.score, closeTo(1.0, 0.02));
    expect(match.suggestion.calories, 420,
        reason: 'found by the angle that matches, logged as the meal the user '
            'last agreed to');
  });

  test('an equal score is broken by which was eaten most recently', () async {
    final index = await indexOf([
      meal('Ramen', daysAgo: 20, vector: axis(0)),
      meal('Porridge', daysAgo: 1, vector: axis(0)),
    ]);

    expect(index.nearest(axis(0)).first.suggestion.name, 'Porridge');
  });

  test('it hands back at most as many as it was asked for', () async {
    final index = await indexOf([
      for (var i = 0; i < 6; i++) meal('Meal $i', daysAgo: i, vector: axis(i)),
    ]);

    expect(index.nearest(axis(0), limit: 2), hasLength(2));
  });

  group('what is not in it', () {
    test('a meal nobody has encoded', () async {
      final index = await indexOf([meal('Porridge', daysAgo: 1)]);

      expect(index.isEmpty, isTrue,
          reason: 'invisible rather than broken — the frequency row still '
              'offers it');
    });

    /// §9: an embedding is only comparable to embeddings from the same encoder.
    /// A model change has to make suggestions go *quiet*, not go wrong, and this
    /// is the line that does it.
    test('a meal encoded by something else', () async {
      final index = await indexOf([
        meal('Porridge', daysAgo: 1, vector: axis(0), embeddedBy: 'older-model'),
      ]);

      expect(index.isEmpty, isTrue);
    });

    test('a meal that is not an answer to anything', () async {
      final index = await indexOf([
        for (final status in [
          MealStatus.pending,
          MealStatus.estimating,
          MealStatus.needsInfo,
          MealStatus.failed,
        ])
          meal('Mystery', daysAgo: 1, vector: axis(0), status: status),
      ]);

      expect(index.isEmpty, isTrue);
    });

    test('a meal with no number to copy', () async {
      final backend = FakeMealBackend()
        ..seed(Meal(
          subject: 'did:ad:meal:nonumber',
          name: 'Something',
          description: '',
          consumedAt: now,
          status: MealStatus.estimated,
          embedding: DinoV2Encoder.encodeVector(axis(0)),
          embeddedByModel: model,
          imagePath: 'photos/x.jpg',
        ));
      final index =
          MealIndex(meals: MealStore(backend: backend), modelId: model);
      await index.refresh();

      expect(index.isEmpty, isTrue,
          reason: 'a suggestion with no number saves nobody an estimate');
    });

    /// What a re-estimate passes, so a meal cannot be handed its own words back
    /// as what somebody said about a *different* meal (Phase 7.4).
    test('a lineage the caller asked to leave out', () async {
      final index = await indexOf([
        meal('Porridge', daysAgo: 5, vector: axis(0), subject: 'did:ad:porridge'),
        meal('Porridge', daysAgo: 1, vector: axis(0), copiedFrom: 'did:ad:porridge'),
        meal('Ramen', daysAgo: 1, vector: axis(3)),
      ]);

      final matches = index.nearest(axis(0), without: 'did:ad:porridge');

      expect(matches.map((m) => m.suggestion.name), ['Ramen'],
          reason: 'the copies took their words from the original, so retrieving '
              'them is the meal talking to itself');
    });
  });

  group('the notes it carries', () {
    /// The one string that leaves this file for a model prompt, and the whole
    /// reason Phase 5 made `meal-notes` the eater's words and nothing else.
    test('are the eater\'s, never the model\'s', () async {
      final index = await indexOf([
        meal('Cheese sandwich', daysAgo: 1, vector: axis(0),
            description: 'A sandwich on a white plate, about 200g.',
            notes: 'sourdough, and there is butter under the cheese'),
      ]);

      final match = index.nearest(axis(0)).single;

      expect(match.notes, 'sourdough, and there is butter under the cheese');
      expect(match.notes, isNot(contains('white plate')));
      expect(match.notes, isNot(contains('Cheese sandwich')));
    });

    test('are the most recent thing said about the meal', () async {
      final index = await indexOf([
        meal('Cheese sandwich', daysAgo: 9, vector: axis(0),
            subject: 'did:ad:sandwich', notes: 'plain cheese'),
        meal('Cheese sandwich', daysAgo: 1, vector: axis(0),
            copiedFrom: 'did:ad:sandwich', notes: 'with pickle now'),
      ]);

      expect(index.nearest(axis(0)).single.notes, 'with pickle now');
    });

    test('are empty when nobody wrote anything', () async {
      final index = await indexOf([
        meal('Porridge', daysAgo: 1, vector: axis(0), description: 'Oats.'),
      ]);

      expect(index.nearest(axis(0)).single.notes, isEmpty);
    });
  });
}
