import 'dart:io';
import 'dart:typed_data';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/image_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_compressor.dart';

/// A real directory in the system temp dir rather than a mock filesystem: the
/// thing under test *is* file bookkeeping — what exists, what it weighs, what
/// happens when it's deleted underneath us — and a fake would only be able to
/// confirm the behaviour it was written to have.
void main() {
  late Directory root;
  late FakeCompressor compressor;
  late ImageStore store;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('image_store_test');
    compressor = FakeCompressor();
    store = ImageStore(root: root, compressor: compressor);
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  final frame = Uint8List.fromList(List.filled(4096, 3));

  /// A meal pointing at a photo the store actually wrote.
  Future<Meal> photographedMeal({
    required DateTime at,
    MealStatus status = MealStatus.estimated,
  }) async {
    final stored = await store.save(frame, at: at);
    return Meal(
      subject: 'did:ad:meal:${at.microsecondsSinceEpoch}',
      name: '',
      description: '',
      consumedAt: at,
      status: status,
      imagePath: stored.imagePath,
    );
  }

  File fileIn(String relative) => File(p.join(root.path, relative));

  /// Backdate a file past [ImageStore.orphanGrace], so the sweep stops treating
  /// it as a capture that might still be on its way to becoming a meal.
  Future<void> backdate(StoredImage stored) async {
    final old = DateTime.now().subtract(const Duration(hours: 1));
    await fileIn(stored.imagePath).setLastModified(old);
    await fileIn(stored.thumbnailPath).setLastModified(old);
  }

  group('save', () {
    test('writes the image and its thumbnail, at the sizes §6 pins', () async {
      final at = DateTime(2026, 8, 5, 12, 30);
      final stored = await store.save(frame, at: at);

      expect(await fileIn(stored.imagePath).exists(), isTrue);
      expect(await fileIn(stored.thumbnailPath).exists(), isTrue);
      expect(stored.imagePath, startsWith('${ImageStore.fullDir}${p.separator}'));
      expect(
        stored.thumbnailPath,
        ImageStore.thumbnailPathFor(stored.imagePath),
        reason: 'the meal stores one path; the other has to be derivable',
      );

      expect(
        compressor.calls,
        [
          (maxEdge: ImageStore.fullEdge, quality: ImageStore.fullQuality),
          (maxEdge: ImageStore.thumbEdge, quality: ImageStore.thumbQuality),
        ],
        reason: 'both encodes come off the camera frame, not one off the other',
      );
    });

    test('counts what it wrote, without going back to the disk', () async {
      final stored = await store.save(frame, at: DateTime(2026, 8, 5));

      expect(await store.totalBytes(), stored.bytes);
      expect(
        await store.recount(),
        stored.bytes,
        reason: 'the counter and the directory have to agree',
      );
    });

    /// The counter is a cache of the directory, and a crash between a write and
    /// its update leaves it behind. Every sweep recounts for this reason.
    test('a recount heals a counter that drifted', () async {
      final stored = await store.save(frame, at: DateTime(2026, 8, 5));
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt('photo_bytes_total', 999999);

      expect(await ImageStore(root: root).recount(), stored.bytes);
    });
  });

  group('load', () {
    test('returns null for a photo that is not there', () async {
      expect(await store.load('photos/never-written.jpg'), isNull);
      expect(await store.load(''), isNull);
    });

    /// Every read path has to tolerate a missing file — that is what makes
    /// eviction a cache policy rather than data loss.
    test('an evicted photo keeps its thumbnail and reports it', () async {
      final meal = await photographedMeal(at: DateTime(2026, 8, 5));
      await fileIn(meal.imagePath).delete();

      expect(await store.load(meal.imagePath), isNull);
      expect(await store.loadThumbnail(meal.imagePath), isNotNull);
      expect(await store.stateOf(meal.imagePath), PhotoState.evicted);
    });

    test('a typed meal has no photo rather than a missing one', () async {
      expect(await store.stateOf(''), PhotoState.none);
    });
  });

  group('sweep', () {
    /// The crash between writing the file and writing the resource. Nobody will
    /// ever ask for these bytes again.
    test('removes files no meal points at, budget or no budget', () async {
      await store.setBudgetBytes(ImageStore.unlimitedBudget);
      final kept = await photographedMeal(at: DateTime(2026, 8, 5, 9));
      final orphan = await store.save(frame, at: DateTime(2026, 8, 5, 10));
      await backdate(orphan);

      final freed = await store.sweep(meals: [kept]);

      expect(freed, orphan.bytes);
      expect(await fileIn(orphan.imagePath).exists(), isFalse);
      expect(await fileIn(orphan.thumbnailPath).exists(), isFalse,
          reason: 'an orphan thumbnail is just as unreferenced');
      expect(await fileIn(kept.imagePath).exists(), isTrue);
      expect(await store.totalBytes(), await store.recount());
    });

    /// A photo written a second ago is not an orphan — it is a capture whose
    /// meal is still being written. The sweep that runs at launch, or after
    /// another shot, must not race it and delete the picture out from under the
    /// meal being logged.
    test('a photo written just now is left alone', () async {
      await store.setBudgetBytes(ImageStore.unlimitedBudget);
      final fresh = await store.save(frame, at: DateTime(2026, 8, 5, 10));

      expect(await store.sweep(meals: const []), 0);
      expect(await fileIn(fresh.imagePath).exists(), isTrue);

      // And once it is old enough to be nobody's, it goes.
      await backdate(fresh);
      expect(await store.sweep(meals: const []), fresh.bytes);
      expect(await fileIn(fresh.imagePath).exists(), isFalse);
    });

    test('under budget, nothing is evicted', () async {
      final meals = [
        await photographedMeal(at: DateTime(2026, 8, 5, 9)),
        await photographedMeal(at: DateTime(2026, 8, 5, 13)),
      ];
      await store.setBudgetBytes(10 * 1024 * 1024);

      expect(await store.sweep(meals: meals), 0);
      for (final meal in meals) {
        expect(await fileIn(meal.imagePath).exists(), isTrue);
      }
    });

    test('over budget, the oldest photos go first', () async {
      final oldest = await photographedMeal(at: DateTime(2026, 8, 1));
      final middle = await photographedMeal(at: DateTime(2026, 8, 3));
      final newest = await photographedMeal(at: DateTime(2026, 8, 5));
      final meals = [newest, oldest, middle]; // deliberately unsorted

      // Room for two of the three, and the hysteresis takes it below that — so
      // exactly the two oldest have to go.
      final total = await store.recount();
      await store.setBudgetBytes((total * 2 / 3).round());

      final freed = await store.sweep(meals: meals);

      expect(await fileIn(oldest.imagePath).exists(), isFalse);
      expect(await fileIn(middle.imagePath).exists(), isFalse);
      expect(await fileIn(newest.imagePath).exists(), isTrue);
      expect(freed, greaterThan(0));
    });

    /// A sweep that stops exactly at the cap is one shot away from the next
    /// sweep, forever. Stopping 10% below means it actually freed something.
    test('it frees headroom, not just enough', () async {
      final meals = [
        for (var day = 1; day <= 4; day++)
          await photographedMeal(at: DateTime(2026, 8, day)),
      ];
      final total = await store.recount();
      final budget = total - 1; // one byte over
      await store.setBudgetBytes(budget);

      await store.sweep(meals: meals);

      final after = await store.recount();
      expect(after, lessThanOrEqualTo(budget - budget ~/ 10));
      expect(after, greaterThan(0), reason: 'it evicts, it does not empty');
    });

    /// The estimator's queue is not a storage problem. Deleting its input would
    /// turn a backlog into meals that can never be estimated at all.
    test('a photo the estimator still needs is never evicted', () async {
      final waiting = <Meal>[
        await photographedMeal(
            at: DateTime(2026, 8, 1), status: MealStatus.pending),
        await photographedMeal(
            at: DateTime(2026, 8, 2), status: MealStatus.estimating),
        await photographedMeal(
            at: DateTime(2026, 8, 3), status: MealStatus.needsInfo),
      ];
      final done = await photographedMeal(
          at: DateTime(2026, 8, 4), status: MealStatus.confirmed);

      // A budget nothing could satisfy, so only the rule decides what survives.
      await store.setBudgetBytes(1);
      await store.sweep(meals: [...waiting, done]);

      for (final meal in waiting) {
        expect(await fileIn(meal.imagePath).exists(), isTrue,
            reason: '${meal.status} is still in the queue');
      }
      expect(await fileIn(done.imagePath).exists(), isFalse,
          reason: 'the confirmed one was the only thing free to evict');
    });

    test('thumbnails survive an eviction', () async {
      final meal = await photographedMeal(at: DateTime(2026, 8, 1));
      await store.setBudgetBytes(1);

      await store.sweep(meals: [meal]);

      expect(await fileIn(meal.imagePath).exists(), isFalse);
      expect(await store.loadThumbnail(meal.imagePath), isNotNull);
    });

    test('no budget means no eviction', () async {
      final meal = await photographedMeal(at: DateTime(2026, 8, 1));
      await store.setBudgetBytes(ImageStore.unlimitedBudget);

      expect(await store.sweep(meals: [meal]), 0);
      expect(await fileIn(meal.imagePath).exists(), isTrue);
    });
  });

  group('deleteAll', () {
    test('takes the photos and the thumbnails, and zeroes the total', () async {
      final meal = await photographedMeal(at: DateTime(2026, 8, 1));

      final freed = await store.deleteAll();

      expect(freed, greaterThan(0));
      expect(await store.load(meal.imagePath), isNull);
      expect(await store.loadThumbnail(meal.imagePath), isNull);
      expect(await store.totalBytes(), 0);
    });
  });

  group('budget', () {
    test('defaults to 250 MB and remembers what it is set to', () async {
      expect(await store.budgetBytes(), ImageStore.defaultBudgetBytes);

      await store.setBudgetBytes(ImageStore.unlimitedBudget);

      expect(
        await ImageStore(root: root).budgetBytes(),
        ImageStore.unlimitedBudget,
        reason: 'the budget outlives the object that set it',
      );
    });
  });
}
