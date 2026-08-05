import 'dart:convert';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/screens/today_screen.dart';
import 'package:calorie_tracker/services/estimation_queue.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:calorie_tracker/services/openrouter.dart';
import 'package:calorie_tracker/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_meal_backend.dart';
import 'fake_notifier.dart';
import 'today_screen_test.dart' show readySession;

/// The uncertainty loop, end to end and through the screens: a meal the
/// estimator could not finish, the question it asked, the answer typed into the
/// sheet, and the second estimate that answer produces.
///
/// The whole thing is here rather than split between a queue test and a widget
/// test because the bug it exists to catch lives between them — an answer that
/// is saved and not sent, or sent and not saved, leaves a meal exactly as stuck
/// as it was and both halves still pass on their own.
void main() {
  late FakeMealBackend backend;
  late MealStore store;
  late FakeNotifier notifier;
  late List<http.Request> requests;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({'openrouter_api_key': 'sk-test'});
    backend = FakeMealBackend();
    store = MealStore(backend: backend, day: DateTime.now());
    notifier = FakeNotifier();
    requests = [];
  });

  /// A typed meal the estimator has already looked at once and had to ask
  /// about. Typed rather than photographed so re-estimating is offered without
  /// a photo directory in the picture — the words are what it would be sent.
  String seedAskedAbout() {
    final now = DateTime.now();
    backend.seed(Meal(
      subject: 'a',
      name: 'Glass of something white',
      description: 'A tall glass, roughly 250 ml',
      consumedAt: DateTime(now.year, now.month, now.day, 9),
      status: MealStatus.needsInfo,
      calories: 140,
      clarifyingQuestion: 'Was that milk or oat milk?',
    ));
    return 'a';
  }

  /// Today's list over [backend], with a queue whose OpenRouter answers with
  /// [respond].
  Future<EstimationQueue> pumpDay(
    WidgetTester tester,
    Future<http.Response> Function(http.Request) respond,
  ) async {
    final account = OpenRouterAccount();
    await account.load();
    final queue = EstimationQueue(
      meals: store,
      account: account,
      notifier: notifier,
      client: OpenRouterClient(
        account: account,
        httpClient: MockClient((request) {
          requests.add(request);
          return respond(request);
        }),
      ),
      wait: (_) async {},
    );

    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark),
      home: TodayScreen(
        session: await readySession(),
        store: store,
        queue: queue,
      ),
    ));
    await tester.pumpAndSettle();
    return queue;
  }

  testWidgets('the question is on the meal, and answering it re-estimates',
      (tester) async {
    seedAskedAbout();
    await pumpDay(tester, (_) async => _answers(_estimate(name: 'Glass of oat milk')));

    expect(find.text('needs an answer'), findsOneWidget);

    await tester.tap(find.text('Glass of something white'));
    await tester.pumpAndSettle();

    expect(find.text('One question'), findsOneWidget);
    expect(find.text('Was that milk or oat milk?'), findsOneWidget);

    await tester.enterText(
        find.widgetWithText(TextFormField, 'Your answer'), 'Oat milk');
    await tester.tap(find.text('Answer and estimate again'));
    await tester.pumpAndSettle();

    // The answer reached the model...
    final sent = jsonDecode(requests.single.body);
    final text = (((sent['messages'] as List).last as Map)['content'] as List)
        .first['text'] as String;
    expect(text, contains('Oat milk'));

    // ...and the meal came back finished, with the answer still on it.
    final meal = backend.meals.single;
    expect(meal.status, MealStatus.estimated);
    expect(meal.name, 'Glass of oat milk');
    expect(meal.calories, 90);
    expect(meal.notes, 'Oat milk',
        reason: 'the estimate must not take the answer with it');
    expect(meal.clarifyingQuestion, '');
    expect(find.text('needs an answer'), findsNothing);
  });

  /// Answering by typing a number instead of words. It is the same question
  /// answered, and it must not leave the estimator anything left to do.
  testWidgets('a number typed into the sheet ends the question', (tester) async {
    seedAskedAbout();
    await pumpDay(tester, (_) async => fail('nothing should be asked'));

    await tester.tap(find.text('Glass of something white'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Calories'), '180');
    await tester.tap(find.text('Just save it'));
    await tester.pumpAndSettle();

    expect(backend.meals.single.status, MealStatus.confirmed);
    expect(backend.meals.single.calories, 180);
    expect(requests, isEmpty);
    expect(notifier.asked, isEmpty, reason: 'nothing left to ask about');
  });

  /// An estimate nobody has checked is not the same as one somebody agreed
  /// with, and agreeing has to be cheaper than retyping the number.
  testWidgets('an estimate can be confirmed as it stands', (tester) async {
    final now = DateTime.now();
    backend.seed(Meal(
      subject: 'a',
      name: 'Porridge',
      description: 'A bowl with berries',
      consumedAt: DateTime(now.year, now.month, now.day, 8),
      status: MealStatus.estimated,
      calories: 320,
      caloriesMin: 260,
      caloriesMax: 400,
      estimatedByModel: 'openai/gpt-5.6-luna',
      confidence: MealConfidence.medium,
    ));
    await pumpDay(tester, (_) async => fail('nothing should be asked'));

    await tester.tap(find.text('Porridge'));
    await tester.pumpAndSettle();

    expect(find.text('Somewhere between 260 and 400 kcal'), findsOneWidget);
    expect(find.textContaining('openai/gpt-5.6-luna'), findsOneWidget);

    await tester.tap(find.text('Looks right'));
    await tester.pumpAndSettle();

    expect(backend.meals.single.status, MealStatus.confirmed);
    expect(backend.meals.single.calories, 320,
        reason: 'confirming is agreeing with the number, not replacing it');
  });

  /// A meal deleted while its question is on a lock screen would leave the tap
  /// with nothing to open.
  testWidgets('deleting a meal takes its question with it', (tester) async {
    final subject = seedAskedAbout();
    await pumpDay(tester, (_) async => fail('nothing should be asked'));
    await notifier.ask(subject, 'Was that milk or oat milk?');

    await tester.tap(find.text('Glass of something white'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(backend.meals, isEmpty);
    expect(notifier.asked, isEmpty);
  });
}

http.Response _answers(Map<String, dynamic> estimate) => http.Response(
      jsonEncode({
        'choices': [
          {
            'message': {'content': jsonEncode(estimate)},
          },
        ],
      }),
      200,
    );

Map<String, dynamic> _estimate({required String name}) => {
      'name': name,
      'description': 'A tall glass of oat milk, roughly 250 ml',
      'calories': 90,
      'calories_min': 80,
      'calories_max': 110,
      'protein_g': 2.0,
      'carbs_g': 16.0,
      'fat_g': 1.5,
      'confidence': 'high',
      'clarifying_question': null,
    };
