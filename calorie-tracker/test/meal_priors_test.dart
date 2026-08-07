import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/embedding_queue.dart';
import 'package:calorie_tracker/services/image_store.dart';
import 'package:calorie_tracker/services/meal_encoder.dart';
import 'package:calorie_tracker/services/meal_index.dart';
import 'package:calorie_tracker/services/meal_priors.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_compressor.dart';
import 'fake_encoder.dart';
import 'fake_meal_backend.dart';

/// Phase 7.4's medium band: what this person wrote about the nearest thing they
/// have logged before, handed to the estimator as background.
///
/// The point of the whole feature is here. Someone who eats a cheese sandwich
/// most weeks is asked "is there anything on it besides the cheese?" every time,
/// because every meal is estimated from nothing — and they answered that weeks
/// ago. The clarify loop terminates, but a loop that terminates is still a loop
/// the user walks around every time.
void main() {
  const model = 'fake-encoder-v1';
  final noon = DateTime(2026, 8, 6, 12);

  late Directory root;
  late ImageStore images;
  late FakeMealBackend backend;
  late MealStore store;
  late FakeEncoder encoder;
  late EmbeddingQueue embeddings;
  late MealIndex index;
  late MealPriors priors;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('meal_priors_test');
    images = ImageStore(root: root, compressor: FakeCompressor());
    backend = FakeMealBackend();
    store = MealStore(backend: backend, day: noon);
    encoder = FakeEncoder(modelId: model);
    embeddings =
        EmbeddingQueue(encoder: encoder, meals: store, images: images);
    index = MealIndex(meals: store, modelId: model);
    priors = MealPriors(index: index, embeddings: embeddings, modelId: model);
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  Float32List axis(int which, {int length = 8}) {
    final vector = Float32List(length);
    vector[which % length] = 1;
    return vector;
  }

  Float32List near(int which, double degrees, {int length = 8}) {
    final vector = Float32List(length);
    final radians = degrees * math.pi / 180;
    vector[which % length] = math.cos(radians);
    vector[(which + 1) % length] = math.sin(radians);
    return vector;
  }

  var nextId = 0;

  /// A settled meal in the history, with a vector and whatever was said about
  /// it — the thing a prior is retrieved *from*.
  void remember(
    String name, {
    required Float32List vector,
    String notes = '',
    String description = '',
    String subject = '',
    String copiedFrom = '',
  }) =>
      backend.seed(Meal(
        subject: subject.isEmpty ? 'did:ad:meal:${nextId++}' : subject,
        name: name,
        description: description,
        notes: notes,
        consumedAt: noon.subtract(Duration(days: ++nextId)),
        status: MealStatus.estimated,
        calories: 420,
        imagePath: 'photos/$nextId.jpg',
        copiedFromMeal: copiedFrom,
        embedding: DinoV2Encoder.encodeVector(vector),
        embeddedByModel: model,
      ));

  /// The meal about to be estimated: photographed a moment ago, no name, no
  /// number, and — until something encodes it — no vector either.
  Future<Meal> justPhotographed({Float32List? alreadyEmbedded}) async {
    final stored = await images.save(
      Uint8List.fromList(List.filled(2048, 3)),
      at: noon,
    );
    final meal = Meal(
      subject: 'did:ad:meal:new',
      name: '',
      description: '',
      consumedAt: noon,
      status: MealStatus.pending,
      imagePath: stored.imagePath,
      embedding: alreadyEmbedded == null
          ? ''
          : DinoV2Encoder.encodeVector(alreadyEmbedded),
      embeddedByModel: alreadyEmbedded == null ? '' : model,
    );
    backend.seed(meal);
    return meal;
  }

  test('the nearest meal\'s words come back', () async {
    remember('Cheese sandwich',
        vector: axis(0), notes: 'sourdough, and butter under the cheese');
    final meal = await justPhotographed(alreadyEmbedded: near(0, 20));

    expect(await priors.notesFor(meal),
        'sourdough, and butter under the cheese');
  });

  test('nothing that is not close enough to be about the same food', () async {
    remember('Cheese sandwich', vector: axis(0), notes: 'sourdough');
    // Well past [MealPriors.contextThreshold]: a different dish entirely.
    final meal = await justPhotographed(alreadyEmbedded: near(0, 80));

    expect(await priors.notesFor(meal), isEmpty,
        reason: 'a hint about a meal this is not is a sentence the model has '
            'to work out how to ignore');
  });

  /// The band this sits in: below the chip threshold, above this one. A match
  /// good enough to *tap* would never have reached the estimator at all.
  test('a match too weak for a chip is still worth a hint', () async {
    remember('Cheese sandwich', vector: axis(0), notes: 'sourdough');
    // ~0.62 — under 0.55 it would show no chip, over 0.35 it is worth saying.
    final meal = await justPhotographed(alreadyEmbedded: near(0, 51));

    expect(await priors.notesFor(meal), 'sourdough');
  });

  /// The invariant Phase 5 exists to protect, and the easiest thing in this
  /// phase to break by accident. If the model's own words were eligible for
  /// retrieval, the fifth cheese sandwich would be estimated from a chain of
  /// four of its own previous guesses, each labelled as something a human said.
  group('what is never fed forward', () {
    test('the model\'s description', () async {
      remember('Cheese sandwich',
          vector: axis(0),
          description: 'Two slices of white bread with cheddar, about 200g.',
          notes: '');
      final meal = await justPhotographed(alreadyEmbedded: axis(0));

      expect(await priors.notesFor(meal), isEmpty,
          reason: 'a meal the eater never wrote about has no prior to give, '
              'however much the model wrote about it');
    });

    test('the model\'s name for the meal', () async {
      remember('Grilled cheese sandwich', vector: axis(0), notes: 'sourdough');
      final meal = await justPhotographed(alreadyEmbedded: axis(0));

      final prior = await priors.notesFor(meal);

      expect(prior, 'sourdough');
      expect(prior, isNot(contains('Grilled')));
    });
  });

  test('a meal with no vector yet is encoded, once, and the vector is kept',
      () async {
    remember('Cheese sandwich', vector: axis(0), notes: 'sourdough');
    final meal = await justPhotographed();
    encoder.imageVector = near(0, 15);

    expect(await priors.notesFor(meal), 'sourdough');
    expect(encoder.encodedLengths, hasLength(1));
    expect(
      backend.meals.firstWhere((m) => m.subject == meal.subject).embedding,
      isNotEmpty,
      reason: 'the backfill would have reached this meal eventually and now '
          'does not have to — the work is stored, not repeated',
    );
  });

  test('a meal nobody photographed has nothing to match on', () async {
    remember('Cheese sandwich', vector: axis(0), notes: 'sourdough');
    final typed = Meal(
      subject: 'did:ad:meal:typed',
      name: '',
      description: '',
      notes: 'two slices of toast',
      consumedAt: noon,
      status: MealStatus.pending,
    );
    backend.seed(typed);

    expect(await priors.notesFor(typed), isEmpty);
    expect(encoder.encodedLengths, isEmpty);
  });

  test('a phone with no encoder simply has no priors', () async {
    remember('Cheese sandwich', vector: axis(0), notes: 'sourdough');
    final meal = await justPhotographed();
    encoder.unavailable = true;

    expect(await priors.notesFor(meal), isEmpty,
        reason: 'every estimate is exactly what it was before Phase 7.4');
  });

  /// A settled meal being estimated again — the "Estimate it again" button, and
  /// the clarify loop's second round. Without the exclusion the meal retrieves
  /// itself and the copies that took their words from it, and the model is told
  /// that somebody said about a *similar* meal what it is already being told
  /// about this one.
  test('a re-estimate does not retrieve itself, or its own copies', () async {
    remember('Cheese sandwich',
        vector: axis(0), notes: 'sourdough', subject: 'did:ad:sandwich');
    remember('Cheese sandwich',
        vector: axis(0), notes: 'sourdough', copiedFrom: 'did:ad:sandwich');
    remember('Ramen', vector: axis(4), notes: 'extra egg');

    final again = backend.meals.firstWhere((m) => m.subject == 'did:ad:sandwich');

    expect(await priors.notesFor(again), isEmpty,
        reason: 'the only thing close to it is itself');
  });
}
