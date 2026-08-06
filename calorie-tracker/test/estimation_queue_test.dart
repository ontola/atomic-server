import 'dart:convert';
import 'dart:io';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/estimation_queue.dart';
import 'package:calorie_tracker/services/image_store.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:calorie_tracker/services/openrouter.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_meal_backend.dart';
import 'fake_notifier.dart';

/// The queue against a fake meals table and a mocked OpenRouter.
///
/// The HTTP client is mocked rather than the client that wraps it, deliberately:
/// what can go wrong here is what comes back over the wire — an answer that is
/// not the JSON that was asked for, a 429, a model that wants to ask something
/// — and a fake [OpenRouterClient] could only ever fail in the ways it was
/// written to.
void main() {
  late FakeMealBackend backend;
  late MealStore store;
  late OpenRouterAccount account;
  late Directory root;
  late ImageStore images;
  late FakeNotifier notifier;

  /// Every request the queue made, in order. The retry tests are entirely about
  /// how long this gets.
  late List<http.Request> requests;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});

    backend = FakeMealBackend();
    store = MealStore(backend: backend, day: _noon);
    account = OpenRouterAccount();
    requests = [];
    root = await Directory.systemTemp.createTemp('estimation_queue_test');
    images = ImageStore(root: root);
    notifier = FakeNotifier();
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  /// A queue whose OpenRouter answers with [respond], and which never actually
  /// waits out a backoff.
  Future<EstimationQueue> queueThat(
    Future<http.Response> Function(http.Request) respond, {
    bool connected = true,
  }) async {
    if (connected) {
      FlutterSecureStorage.setMockInitialValues(
        {'openrouter_api_key': 'sk-or-test'},
      );
    }
    await account.load();

    final client = OpenRouterClient(
      account: account,
      httpClient: MockClient((request) {
        requests.add(request);
        return respond(request);
      }),
    );

    return EstimationQueue(
      meals: store,
      account: account,
      client: client,
      notifier: notifier,
      wait: (_) async {},
    )..images = images;
  }

  /// A meal captured at noon with a photo actually on disk, since that is what
  /// the queue reads before it calls anything.
  Future<String> photographedMeal({DateTime? at}) async {
    final when = at ?? _noon;
    final name = '${when.microsecondsSinceEpoch}.jpg';
    final path = p.join(ImageStore.fullDir, name);
    await Directory(p.join(root.path, ImageStore.fullDir))
        .create(recursive: true);
    await File(p.join(root.path, path)).writeAsBytes(List.filled(64, 7));

    return backend.create(consumedAt: when, imagePath: path);
  }

  Meal mealAt(String subject) =>
      backend.meals.firstWhere((m) => m.subject == subject);

  // ── The happy path ───────────────────────────────────────────────────────

  test('a photographed meal comes back with a name, a number and a range',
      () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => _answers(_estimateJson()));

    await queue.drain();

    final meal = mealAt(subject);
    expect(meal.status, MealStatus.estimated);
    expect(meal.name, 'Cappuccino with oat milk');
    expect(meal.calories, 120);
    expect(meal.caloriesMin, 90);
    expect(meal.caloriesMax, 160);
    expect(meal.confidence, MealConfidence.medium);
    expect(meal.estimatedByModel, OpenRouterAccount.defaultModel);
    expect(queue.waiting, 0);
  });

  test('the photo goes with the request, and so does the model', () async {
    await photographedMeal();
    await account.setModel('some/other-model');
    final queue = await queueThat((_) async => _answers(_estimateJson()));

    await queue.drain();

    final body = jsonDecode(requests.single.body) as Map<String, dynamic>;
    expect(body['model'], 'some/other-model');
    expect(requests.single.headers['Authorization'], 'Bearer sk-or-test');

    final parts = ((body['messages'] as List).last as Map)['content'] as List;
    final image = parts.firstWhere((part) => part['type'] == 'image_url');
    expect(
      image['image_url']['url'],
      startsWith('data:image/jpeg;base64,'),
      reason: 'the mime type comes from the stored file, not from a constant',
    );
  });

  /// A typed meal with no number is the user asking the model rather than
  /// telling it, and their words are the only input there is.
  test('a meal typed without a number is estimated from its words', () async {
    final subject = await backend.create(
      consumedAt: _noon,
      name: 'Two slices of margherita',
      notes: 'Two slices of margherita',
    );
    final queue = await queueThat((_) async => _answers(_estimateJson()));

    await queue.drain();

    final parts =
        ((jsonDecode(requests.single.body)['messages'] as List).last
            as Map)['content'] as List;
    expect(parts.length, 1, reason: 'there is no photo to send');
    expect(parts.single['text'], contains('Two slices of margherita'));
    expect(
      mealAt(subject).notes,
      'Two slices of margherita',
      reason: "the user's own words are the half nobody can reconstruct, and "
          'an estimate replacing the name must not take them with it',
    );
    expect(mealAt(subject).name, 'Cappuccino with oat milk');
  });

  /// The half of the clarify loop that lives here: an answer reaches the model
  /// exactly once, however many estimates have run over the meal since.
  test('a re-estimate sends the answer and never the last estimate', () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => _answers(_estimateJson(
          confidence: 'low',
          question: 'Was that milk or oat milk?',
        )));

    await queue.drain();
    await backend.update(subject, notes: 'Oat milk');
    await queue.retry(mealAt(subject));

    final second = jsonDecode(requests.last.body);
    final text = (((second['messages'] as List).last as Map)['content']
        as List)[0]['text'] as String;
    expect(text, contains('Oat milk'));
    expect(
      text,
      isNot(contains('A takeaway cup')),
      reason: "the model's own last reasoning is not something the eater wrote",
    );
    expect(mealAt(subject).notes, 'Oat milk');
  });

  test('a meal somebody put a number on is not estimated at all', () async {
    await backend.create(consumedAt: _noon, name: 'Toast', calories: 200);
    final queue = await queueThat((_) async => _answers(_estimateJson()));

    await queue.drain();

    expect(requests, isEmpty);
  });

  // ── Low confidence ───────────────────────────────────────────────────────

  test('a question the model asks makes the meal need an answer', () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => _answers(_estimateJson(
          confidence: 'low',
          question: 'Was that milk or oat milk?',
        )));

    await queue.drain();

    final meal = mealAt(subject);
    expect(meal.status, MealStatus.needsInfo);
    expect(meal.clarifyingQuestion, 'Was that milk or oat milk?');
    expect(meal.calories, 120, reason: 'an uncertain guess is still a guess');
    expect(
      notifier.asked[subject],
      'Was that milk or oat milk?',
      reason: 'the point of a question is that nobody may be looking at the app',
    );
  });

  /// The other half of the loop from the notification's side: once the answer
  /// has been estimated with, the question on the lock screen is stale — and a
  /// question that outlives its answer is the app not having listened.
  test('an answered question is taken back off the lock screen', () async {
    final subject = await photographedMeal();
    var call = 0;
    final queue = await queueThat((_) async {
      call++;
      return _answers(_estimateJson(
        confidence: call == 1 ? 'low' : 'high',
        question: call == 1 ? 'Was that milk or oat milk?' : null,
      ));
    });

    await queue.drain();
    expect(notifier.asked, contains(subject));

    await backend.update(subject, notes: 'Oat milk');
    await queue.retry(mealAt(subject));

    expect(notifier.asked, isEmpty);
    expect(notifier.history, [subject], reason: 'and it is not asked again');
    expect(mealAt(subject).status, MealStatus.estimated);
  });

  test('a meal answered by hand stops being asked about', () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => _answers(_estimateJson(
          confidence: 'low',
          question: 'Was that milk or oat milk?',
        )));

    await queue.drain();
    await queue.forget(subject);

    expect(notifier.asked, isEmpty);
  });

  test('an estimate with nothing to ask asks nothing', () async {
    await photographedMeal();
    final queue = await queueThat((_) async => _answers(_estimateJson()));

    await queue.drain();

    expect(notifier.asked, isEmpty);
    expect(notifier.history, isEmpty);
  });

  /// Low confidence on its own is a wide range, which the bounds already say.
  /// Only a question is answerable, and a "needs an answer" chip with no
  /// question behind it is a dead end.
  test('low confidence without a question is just an estimate', () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => _answers(_estimateJson(confidence: 'low')));

    await queue.drain();

    expect(mealAt(subject).status, MealStatus.estimated);
    expect(mealAt(subject).confidence, MealConfidence.low);
  });

  // ── When it goes wrong ───────────────────────────────────────────────────

  test('a rate limit is waited out and retried', () async {
    final subject = await photographedMeal();
    var call = 0;
    final queue = await queueThat((_) async {
      call++;
      if (call < 3) {
        return http.Response(
          jsonEncode({'error': {'message': 'Rate limited', 'code': 429}}),
          429,
        );
      }
      return _answers(_estimateJson());
    });

    await queue.drain();

    expect(requests.length, 3);
    expect(mealAt(subject).status, MealStatus.estimated);
  });

  test('a meal that is rate limited every time gives up, and keeps its photo',
      () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => http.Response('{}', 429));

    await queue.drain();

    expect(
      requests.length,
      EstimationQueue.maxAttempts,
      reason: 'a fourth automatic attempt has never been what fixes it',
    );
    final meal = mealAt(subject);
    expect(meal.status, MealStatus.failed);
    expect(await images.stateOf(meal.imagePath), PhotoState.stored,
        reason: 'the retry the user is offered needs something to send');
  });

  /// Retrying a model that just broke a strict schema costs money and returns
  /// the same thing, so this one does not get three goes.
  test('an answer that is not the JSON it was asked for fails once', () async {
    final subject = await photographedMeal();
    final queue = await queueThat(
      (_) async => _answers('I think that is about 300 calories!'),
    );

    await queue.drain();

    expect(requests.length, 1);
    expect(mealAt(subject).status, MealStatus.failed);
  });

  test('a rejected key fails without retrying', () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => http.Response(
          jsonEncode({'error': {'message': 'No auth credentials found'}}),
          401,
        ));

    await queue.drain();

    expect(requests.length, 1);
    expect(mealAt(subject).status, MealStatus.failed);
  });

  test('one meal failing does not stop the ones behind it', () async {
    final first = await photographedMeal(at: _noon.subtract(_anHour));
    final second = await photographedMeal(at: _noon);
    var call = 0;
    final queue = await queueThat((_) async {
      call++;
      return call == 1
          ? _answers('not json')
          : _answers(_estimateJson(name: 'Soup'));
    });

    await queue.drain();

    expect(mealAt(first).status, MealStatus.failed);
    expect(mealAt(second).status, MealStatus.estimated);
    expect(mealAt(second).name, 'Soup');
  });

  test('a failed meal is only tried again when asked', () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => _answers('not json'));
    await queue.drain();
    requests.clear();

    await queue.drain();
    expect(requests, isEmpty, reason: 'the queue does not pick failures back up');

    await queue.retry(mealAt(subject));
    expect(requests.length, 1);
  });

  // ── Without a key ────────────────────────────────────────────────────────

  test('meals wait rather than fail when there is nothing to estimate with',
      () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => _answers(_estimateJson()),
        connected: false);

    await queue.drain();

    expect(requests, isEmpty);
    expect(mealAt(subject).status, MealStatus.pending);
    expect(queue.needsKey, isTrue);
    expect(queue.waiting, 1, reason: 'the count is the argument for connecting');
  });

  test('a day with nothing waiting does not ask anyone to connect', () async {
    final queue = await queueThat((_) async => _answers(_estimateJson()),
        connected: false);

    await queue.drain();

    expect(queue.needsKey, isFalse);
  });

  // ── Races ────────────────────────────────────────────────────────────────

  /// The documents directory is found in parallel with the store at launch, so
  /// a drain can start before there is anywhere to read a photo from. Failing
  /// the meal there would throw away the estimate's only input.
  test('a photographed meal waits until there is somewhere to read it from',
      () async {
    final subject = await photographedMeal();
    final queue = await queueThat((_) async => _answers(_estimateJson()));
    queue.images = null;

    await queue.drain();
    expect(requests, isEmpty);
    expect(mealAt(subject).status, MealStatus.pending);

    queue.images = images;
    await queue.drain();
    expect(mealAt(subject).status, MealStatus.estimated);
  });

  /// A photo the user deleted cannot be estimated — the 256px thumbnail is not
  /// a substitute — and there is nothing to be gained by asking three times.
  test('a meal whose photo is gone fails without a call', () async {
    final subject = await photographedMeal();
    await images.deleteAll();
    final queue = await queueThat((_) async => _answers(_estimateJson()));

    await queue.drain();

    expect(requests, isEmpty);
    expect(mealAt(subject).status, MealStatus.failed);
  });

  /// Meals sync between devices and photos do not (plan §10), so a paired phone
  /// sees meals whose picture was never on it. Failing one would be worse than
  /// doing nothing: `failed` syncs back to the phone that *does* hold the photo,
  /// and the queue does not pick failures back up — so this device would have
  /// talked that one out of ever estimating it.
  test('a meal photographed on another device is left for that device',
      () async {
    final subject = await photographedMeal();
    await images.deleteAll();
    final queue = await queueThat((_) async => _answers(_estimateJson()));
    queue.paired = true;

    await queue.drain();

    expect(requests, isEmpty);
    expect(mealAt(subject).status, MealStatus.pending);
    expect(queue.waiting, 0,
        reason: 'it is not this phone that is waiting to do it');
  });

  test('a typed meal from another device is estimated here — no photo needed',
      () async {
    final subject = await backend.create(
      consumedAt: _noon,
      notes: 'two slices of margherita',
    );
    final queue = await queueThat((_) async => _answers(_estimateJson()));
    queue.paired = true;

    await queue.drain();

    expect(requests.length, 1);
    expect(mealAt(subject).status, MealStatus.estimated);
  });

  test('the user confirming a meal mid-flight wins', () async {
    final subject = await photographedMeal();
    final queue = await queueThat((request) async {
      // The correction lands while the model is thinking, which is exactly the
      // window this is about.
      await store.editMeal(subject, calories: 300);
      return _answers(_estimateJson());
    });

    await queue.drain();

    final meal = mealAt(subject);
    expect(meal.calories, 300);
    expect(meal.status, MealStatus.confirmed);
  });

  test('a store that cannot be read leaves the queue with a reason', () async {
    backend.readError = Exception('database is closed');
    final queue = await queueThat((_) async => _answers(_estimateJson()));

    await queue.drain();

    expect(queue.error, contains('database is closed'));
    expect(queue.running, isFalse);
  });
}

final _noon = DateTime(2026, 8, 5, 12);
const _anHour = Duration(hours: 1);

/// A chat completion carrying [content] the way OpenRouter wraps it.
http.Response _answers(String content) => http.Response(
      jsonEncode({
        'choices': [
          {
            'message': {'role': 'assistant', 'content': content},
          },
        ],
      }),
      200,
      headers: {'content-type': 'application/json'},
    );

String _estimateJson({
  String name = 'Cappuccino with oat milk',
  int calories = 120,
  String confidence = 'medium',
  String? question,
}) =>
    jsonEncode({
      'name': name,
      'description': 'A takeaway cup, roughly 250 ml',
      'calories': calories,
      'calories_min': 90,
      'calories_max': 160,
      'protein_g': 4.5,
      'carbs_g': 12,
      'fat_g': 5.5,
      'confidence': confidence,
      'clarifying_question': question,
    });
