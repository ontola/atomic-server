import 'dart:io';
import 'dart:typed_data';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/screens/meal_entry_sheet.dart';
import 'package:calorie_tracker/services/image_store.dart';
import 'package:calorie_tracker/theme.dart';
import 'package:calorie_tracker/widgets/meal_photo.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_compressor.dart';

/// What a meal looks like once its photo is gone.
///
/// Eviction is silent and the meal survives it, so the only place the user ever
/// finds out is here — and finding out has to be a sentence, not a broken
/// image. See the note in `capture_screen_test.dart` about `runAsync`: these
/// widgets read the filesystem too.
void main() {
  late Directory root;
  late ImageStore images;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('meal_photo_test');
    images = ImageStore(root: root, compressor: FakeCompressor());
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  Future<Meal> photographedMeal(WidgetTester tester) async {
    final stored = await tester.runAsync(
      () => images.save(Uint8List(64), at: DateTime(2026, 8, 5, 12)),
    );
    return Meal(
      subject: 'did:ad:meal:1',
      name: 'Pizza',
      description: '',
      consumedAt: DateTime(2026, 8, 5, 12),
      status: MealStatus.confirmed,
      calories: 850,
      imagePath: stored!.imagePath,
    );
  }

  Future<void> evict(WidgetTester tester, Meal meal) async {
    await tester.runAsync(
      () => File(p.join(root.path, meal.imagePath)).delete(),
    );
  }

  Future<void> pumpSheet(WidgetTester tester, Meal meal) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark),
      home: Scaffold(body: MealEntrySheet(meal: meal, images: images)),
    ));
    // Pumps rather than a settle, and through `runAsync` so the two `exists()`
    // calls behind the widget can actually answer.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
  }

  testWidgets('a meal whose photo is still here just shows it', (tester) async {
    final meal = await photographedMeal(tester);

    await pumpSheet(tester, meal);

    expect(find.byType(MealPhoto), findsOneWidget);
    expect(find.text('Photo removed to free up space'), findsNothing);
  });

  /// The meal, its calories and its thumbnail all survive an eviction — so the
  /// sheet keeps working, and says what happened rather than showing a hole.
  testWidgets('an evicted photo says so, and the meal is still editable',
      (tester) async {
    final meal = await photographedMeal(tester);
    await evict(tester, meal);

    await pumpSheet(tester, meal);

    expect(find.text('Photo removed to free up space'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'Meal'), findsOneWidget);
    expect(find.text('Save'), findsOneWidget);
    expect(find.text('Delete'), findsOneWidget);
  });

  /// Phase 4's re-estimate is offered only for [PhotoState.stored]: there is
  /// nothing to send a vision model without the full image, and the thumbnail
  /// is 256px of guesswork.
  testWidgets('an evicted photo is not something to re-estimate from',
      (tester) async {
    final meal = await photographedMeal(tester);

    expect(
      await tester.runAsync(() => images.stateOf(meal.imagePath)),
      PhotoState.stored,
    );

    await evict(tester, meal);

    expect(
      await tester.runAsync(() => images.stateOf(meal.imagePath)),
      PhotoState.evicted,
    );
  });

  testWidgets('a typed meal shows no photo and no explanation', (tester) async {
    await pumpSheet(
      tester,
      Meal(
        subject: 'did:ad:meal:2',
        name: 'Toast',
        description: '',
        consumedAt: DateTime(2026, 8, 5, 9),
        status: MealStatus.confirmed,
        calories: 250,
      ),
    );

    expect(find.text('Photo removed to free up space'), findsNothing);
    expect(find.byType(Image), findsNothing);
  });
}
