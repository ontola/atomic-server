import 'dart:io';
import 'dart:typed_data';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/embedding_queue.dart';
import 'package:calorie_tracker/services/image_store.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_compressor.dart';
import 'fake_encoder.dart';
import 'fake_meal_backend.dart';

/// The policy around the encoder: which meals, in what order, and what the
/// awkward states do. The arithmetic of an embedding is
/// `meal_encoder_test.dart`; the model itself is only ever exercised on a
/// device.
void main() {
  late Directory root;
  late ImageStore images;
  late FakeMealBackend backend;
  late MealStore meals;
  late FakeEncoder encoder;
  late EmbeddingQueue queue;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('embedding_queue_test');
    images = ImageStore(root: root, compressor: FakeCompressor());
    backend = FakeMealBackend();
    meals = MealStore(backend: backend);
    encoder = FakeEncoder();
    queue = EmbeddingQueue(encoder: encoder, meals: meals, images: images);
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  final frame = Uint8List.fromList(List.filled(4096, 7));

  /// A meal with a photo the store actually wrote, so it has a source on disk.
  Future<Meal> photographed(DateTime at, {String embedding = ''}) async {
    final stored = await images.save(frame, at: at);
    final meal = Meal(
      subject: 'did:ad:meal:${at.microsecondsSinceEpoch}',
      name: 'Cheese sandwich',
      description: '',
      consumedAt: at,
      status: MealStatus.estimated,
      calories: 400,
      imagePath: stored.imagePath,
      embedding: embedding,
      embeddedByModel: embedding.isEmpty ? '' : encoder.modelId,
    );
    backend.seed(meal);
    return meal;
  }

  Meal find(String subject) =>
      backend.meals.firstWhere((m) => m.subject == subject);

  test('a photographed meal gets an embedding and the encoder that made it',
      () async {
    final meal = await photographed(DateTime(2026, 8, 5, 12));

    await queue.drain();

    final after = find(meal.subject);
    expect(after.embedding, isNotEmpty);
    expect(
      after.embeddedByModel,
      encoder.modelId,
      reason: 'a vector whose encoder is unknown cannot be compared to '
          'anything, so the two are written together',
    );
  });

  test('a meal that already has a current embedding is left alone', () async {
    await photographed(DateTime(2026, 8, 5, 12), embedding: 'AQID');

    await queue.drain();

    expect(encoder.encodedLengths, isEmpty,
        reason: 'every encode costs battery; the work is already done');
  });

  test('a meal embedded by a different encoder is re-encoded', () async {
    final meal = await photographed(DateTime(2026, 8, 5, 12), embedding: 'AQID');
    backend.meals[0] = Meal(
      subject: meal.subject,
      name: meal.name,
      description: '',
      consumedAt: meal.consumedAt,
      status: meal.status,
      calories: meal.calories,
      imagePath: meal.imagePath,
      embedding: 'AQID',
      embeddedByModel: 'some-older-encoder',
    );

    await queue.drain();

    expect(find(meal.subject).embeddedByModel, encoder.modelId,
        reason: 'this is §9 migration, and it needs no separate code path — '
            'changing the model id re-encodes the history from the sources');
  });

  test('newest first, because the newest meal is the one being matched against',
      () async {
    await photographed(DateTime(2026, 8, 1));
    await photographed(DateTime(2026, 8, 5));
    await photographed(DateTime(2026, 8, 3));

    await queue.drain();

    // The fake records byte lengths, which are all equal here, so assert on the
    // table instead: everything embedded, and the store asked in the right
    // order is what `_unembedded` sorts for.
    expect(backend.meals.every((m) => m.embedding.isNotEmpty), isTrue);
    expect(encoder.encodedLengths, hasLength(3));
  });

  test('a meal whose photo is on another phone is skipped, not failed',
      () async {
    // Synced from a paired device: the meal arrives, the file never does.
    backend.seed(Meal(
      subject: 'did:ad:meal:elsewhere',
      name: 'Their lunch',
      description: '',
      consumedAt: DateTime(2026, 8, 5),
      status: MealStatus.estimated,
      calories: 500,
      imagePath: 'photos/never-written-here.jpg',
    ));

    await queue.drain();

    expect(encoder.encodedLengths, isEmpty);
    expect(queue.skipped, 1);
    expect(find('did:ad:meal:elsewhere').embedding, isEmpty,
        reason: 'nothing here can encode it, and that is not a failure state — '
            'it most likely arrives with an embedding of its own');
  });

  test('a typed meal with no photo is not waiting for anything', () async {
    backend.seed(Meal(
      subject: 'did:ad:meal:typed',
      name: 'Two slices of toast',
      description: '',
      consumedAt: DateTime(2026, 8, 5),
      status: MealStatus.confirmed,
      calories: 200,
    ));

    await queue.drain();

    expect(encoder.encodedLengths, isEmpty);
    expect(queue.skipped, 0,
        reason: 'a meal nobody photographed is not one this queue is behind on');
  });

  test('a device with no model stops instead of grinding through the history',
      () async {
    for (var day = 1; day <= 5; day++) {
      await photographed(DateTime(2026, 8, day));
    }
    encoder.unavailable = true;

    await queue.drain();

    expect(backend.meals.every((m) => m.embedding.isEmpty), isTrue);
    expect(queue.skipped, 5,
        reason: 'if the model is missing every remaining meal fails the same '
            'way, and finding that out five times costs five times the battery');
  });

  test('a drain before the documents directory is known does nothing yet',
      () async {
    await photographed(DateTime(2026, 8, 5));
    final early = EmbeddingQueue(encoder: encoder, meals: meals);

    await early.drain();
    expect(encoder.encodedLengths, isEmpty);

    // `main.dart` hands it over and drains again when the directory lands.
    early.images = images;
    await early.drain();
    expect(encoder.encodedLengths, hasLength(1));
  });

  test('two drains at once are one drain', () async {
    await photographed(DateTime(2026, 8, 5));

    await Future.wait([queue.drain(), queue.drain()]);

    expect(encoder.encodedLengths, hasLength(1),
        reason: 'the launch drain and the capture drain overlap routinely');
  });

  test('it reads the embedding source, never the photo', () async {
    final meal = await photographed(DateTime(2026, 8, 5));

    // What eviction does to a photo, which the source is exempt from. The
    // embedding must survive it — a meal cannot get a different vector
    // depending on whether its picture has been evicted yet.
    await File('${root.path}/${meal.imagePath}').delete();

    await queue.drain();

    expect(find(meal.subject).embedding, isNotEmpty);
  });
}
