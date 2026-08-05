import 'dart:io';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/screens/capture_screen.dart';
import 'package:calorie_tracker/services/app_session.dart';
import 'package:calorie_tracker/services/image_store.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:calorie_tracker/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_atomic_backend.dart';
import 'fake_camera.dart';
import 'fake_compressor.dart';
import 'fake_meal_backend.dart';

/// Two things about this file are not obvious, and both are the test framework
/// rather than the app:
///
/// - **A widget test body runs in a fake-async zone**, and a `Future` from
///   `dart:io` completes on the real event loop, which that zone does not pump.
///   The whole capture path writes files, so anything that touches one has to
///   go through [tapShutter] or [onDisk] — otherwise it hangs half-way with the
///   shutter spinner still up, which reads as a bug in the app.
/// - **`pumpAndSettle` never returns while an indeterminate spinner is on
///   screen**, and "the camera has not come up yet" is exactly that state. So
///   the pumps here are counted rather than settled.
void main() {
  late Directory root;
  late FakeCamera camera;
  late FakeMealBackend meals;
  late MealStore store;
  late ImageStore images;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('capture_screen_test');
    camera = FakeCamera();
    meals = FakeMealBackend();
    store = MealStore(backend: meals, day: DateTime.now());
    images = ImageStore(root: root, compressor: FakeCompressor());
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  Future<AppSession> readySession() async {
    final session = AppSession(backend: FakeAtomicBackend(FakeStore()));
    await session.start();
    await session.createAccount();
    return session;
  }

  Future<void> pump(WidgetTester tester, {bool withImages = true}) async {
    final session = await readySession();
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark),
      home: CaptureScreen(
        session: session,
        camera: camera,
        store: store,
        images: withImages ? images : null,
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  Finder shutter() => find.bySemanticsLabel('Log a photo of this meal');

  /// Whether the shutter is still showing its own spinner — the capture is in
  /// flight exactly while it is.
  bool captureInFlight() => find
      .descendant(of: shutter(), matching: find.byType(CircularProgressIndicator))
      .evaluate()
      .isNotEmpty;

  /// Press the shutter and wait for the capture to finish.
  ///
  /// The wait alternates `runAsync` — so the filesystem gets a turn — with
  /// `pump`, so the screen can react to what it answered, and it stops on the
  /// screen's own signal rather than after a guessed number of milliseconds.
  /// Test files run in parallel, and a fixed sleep is fine until the machine is
  /// busy, which is the one time it matters.
  Future<void> tapShutter(WidgetTester tester, {int taps = 1}) async {
    await tester.runAsync(() async {
      for (var i = 0; i < taps; i++) {
        await tester.tap(shutter());
      }
    });

    final deadline = DateTime.now().add(const Duration(seconds: 20));
    do {
      await tester
          .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
      await tester.pump();
    } while (captureInFlight() && DateTime.now().isBefore(deadline));

    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  /// Run a question about the filesystem where the filesystem can answer it.
  Future<T> onDisk<T>(WidgetTester tester, Future<T> Function() body) async =>
      (await tester.runAsync(body)) as T;

  group('the shutter', () {
    testWidgets('writes a photo and a pending meal, and says so',
        (tester) async {
      await pump(tester);

      await tapShutter(tester);

      final meal = meals.meals.single;
      expect(camera.captureCount, 1);
      expect(
        meal.status,
        MealStatus.pending,
        reason: 'a photo nobody has estimated is exactly the estimator queue',
      );
      expect(meal.calories, isNull, reason: 'unknown is not zero');
      expect(meal.name, isEmpty);
      expect(meal.imagePath, isNotEmpty);
      expect(find.text('Logged'), findsOneWidget);
    });

    /// The point of the whole capture path: by the time the shutter has
    /// returned, the photo is on disk and the meal is written. Killing the app
    /// here loses nothing.
    testWidgets('the photo and its thumbnail are written before it returns',
        (tester) async {
      await pump(tester);

      await tapShutter(tester);

      final meal = meals.meals.single;
      expect(
        await onDisk(tester, () => File(p.join(root.path, meal.imagePath)).exists()),
        isTrue,
      );
      expect(
        await onDisk(tester, () => images.loadThumbnail(meal.imagePath)),
        isNotNull,
      );
    });

    testWidgets('a double tap is one meal, not two', (tester) async {
      await pump(tester);

      // Both taps land before the first capture has finished, which is what
      // makes this the real case rather than two separate shots.
      await tapShutter(tester, taps: 2);

      expect(meals.meals, hasLength(1));
      expect(camera.captureCount, 1);
    });

    testWidgets('a shutter that fails says why, and logs nothing',
        (tester) async {
      camera.captureError = Exception('Camera in use by another app');
      await pump(tester);

      await tapShutter(tester);

      expect(find.text('Camera in use by another app'), findsOneWidget);
      expect(meals.meals, isEmpty);
    });

    testWidgets('a meal that fails to save says why', (tester) async {
      meals.writeError = Exception('No active drive');
      await pump(tester);

      await tapShutter(tester);

      expect(find.text('No active drive'), findsOneWidget);
      expect(find.text('Logged'), findsNothing);
    });

    /// The capture writes the meal before it sweeps, never the other way round:
    /// the sweep decides what to evict from the list of meals, so a photo whose
    /// meal does not exist yet is an orphan it would delete on the way past.
    /// What the capture leaves behind has to survive the sweep that follows it —
    /// even under a budget nothing could satisfy.
    testWidgets('what a capture leaves behind survives the sweep after it',
        (tester) async {
      await onDisk(tester, () => images.setBudgetBytes(1));
      await pump(tester);

      await tapShutter(tester);

      final meal = meals.meals.single;
      await onDisk(tester, () => images.sweep(meals: meals.meals));

      expect(
        await onDisk(tester, () => images.load(meal.imagePath)),
        isNotNull,
        reason: 'the meal it belongs to is pending, so the sweep must skip it',
      );
    });
  });

  group('the viewfinder', () {
    testWidgets('shows the day so far, and what it is not counting',
        (tester) async {
      final now = DateTime.now();
      meals
        ..seed(Meal(
          subject: 'a',
          name: 'Pizza',
          description: '',
          consumedAt: DateTime(now.year, now.month, now.day, 13),
          status: MealStatus.confirmed,
          calories: 850,
        ))
        ..seed(Meal(
          subject: 'b',
          name: '',
          description: '',
          consumedAt: DateTime(now.year, now.month, now.day, 18),
          status: MealStatus.pending,
          imagePath: 'photos/whatever.jpg',
        ));

      await pump(tester);

      expect(find.text('850'), findsOneWidget);
      expect(find.text('kcal today'), findsOneWidget);
      expect(find.text('+1 waiting'), findsOneWidget);
    });

    /// The simulator this app is developed on has no camera. That has to leave
    /// a usable app rather than an error screen.
    testWidgets('no camera leaves the way in that does not need one',
        (tester) async {
      camera = FakeCamera(ready: false, error: 'This device has no camera');
      await pump(tester);

      expect(find.text('This device has no camera'), findsOneWidget);

      await tester.tap(find.text('Type a meal instead'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.enterText(find.widgetWithText(TextFormField, 'Meal'), 'Soup');
      await tester.enterText(
          find.widgetWithText(TextFormField, 'Calories'), '180');
      await tester.tap(find.text('Log it'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(meals.meals.single.name, 'Soup');
      expect(meals.meals.single.status, MealStatus.confirmed);
    });

    testWidgets('a camera still coming up is a spinner, not an error',
        (tester) async {
      camera = FakeCamera(ready: false);
      await pump(tester);

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(shutter(), findsOneWidget);

      // Nothing to shoot yet, so nothing happens if you press it.
      await tapShutter(tester);
      expect(camera.captureCount, 0);
      expect(meals.meals, isEmpty);

      camera.becomeReady();
      await tester.pump();
      await tapShutter(tester);

      expect(meals.meals, hasLength(1));
    });
  });

  group('the ways out', () {
    testWidgets('the total opens the day, sharing one store', (tester) async {
      await pump(tester);
      await tapShutter(tester);

      await tester.tap(find.text('kcal today'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.text('Today'), findsOneWidget);
      expect(find.text('Not estimated yet'), findsOneWidget);
      expect(find.text('1 meal not counted yet'), findsOneWidget);
    });

    testWidgets('typing a meal works alongside the camera', (tester) async {
      await pump(tester);

      await tester.tap(find.byTooltip('Type a meal'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.enterText(
          find.widgetWithText(TextFormField, 'Meal'), 'Toast');
      await tester.enterText(
          find.widgetWithText(TextFormField, 'Calories'), '250');
      await tester.tap(find.text('Log it'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(meals.meals.single.name, 'Toast');
      expect(meals.meals.single.imagePath, isEmpty);
    });

    testWidgets('the account, the secret and the photo budget are one tap away',
        (tester) async {
      await pump(tester);

      await tester.runAsync(() async {
        await tester.tap(find.byIcon(Icons.person_outline));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.widgetWithText(AppBar, 'Account'), findsOneWidget);
      expect(find.text('Copy my secret'), findsOneWidget);
      expect(find.text('Photos'), findsOneWidget);
      expect(find.text('No limit'), findsOneWidget);
    });
  });

  group('the camera as a resource', () {
    testWidgets('is opened when the screen appears', (tester) async {
      await pump(tester);
      expect(camera.startCount, greaterThan(0));
    });

    /// Android takes the camera off a backgrounded app whether we let go or
    /// not; letting go is what makes coming back work.
    testWidgets('is let go on the way out and re-opened on the way back in',
        (tester) async {
      await pump(tester);
      final opened = camera.startCount;

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(camera.stopCount, 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(camera.startCount, greaterThan(opened));
    });
  });

  /// Finding the documents directory is one of the things that runs in parallel
  /// with the first frame, so this screen can be up before there is anywhere to
  /// put a photo. A meal is still a meal.
  testWidgets('without a photo directory a capture is still a meal',
      (tester) async {
    await pump(tester, withImages: false);

    await tapShutter(tester);

    expect(meals.meals.single.status, MealStatus.pending);
    expect(meals.meals.single.imagePath, isEmpty);
    expect(find.text('Logged'), findsOneWidget);
  });
}
