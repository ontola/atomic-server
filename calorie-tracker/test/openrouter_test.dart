import 'dart:convert';

import 'package:calorie_tracker/services/openrouter.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The parts of the OpenRouter layer the queue's tests do not reach: which
/// models the picker is allowed to offer, and where the key comes from.
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  OpenRouterClient clientReturning(String body, {int status = 200}) =>
      OpenRouterClient(
        account: OpenRouterAccount(),
        httpClient: MockClient((_) async => http.Response(body, status)),
      );

  group('the model catalogue', () {
    test('offers only models that can look at a photo', () async {
      final models = await clientReturning(_catalogue).visionModels();

      expect(
        models.map((m) => m.id),
        isNot(contains('someone/text-only')),
        reason: 'most meals arrive as a photograph and nothing else',
      );
      expect(models.map((m) => m.id), contains('openai/gpt-5.6-luna'));
    });

    test('puts the cheapest first, because that is what the list is read for',
        () async {
      final models = await clientReturning(_catalogue).visionModels();

      expect(
        models.map((m) => m.id).toList(),
        ['someone/cheap-vision', 'openai/gpt-5.6-luna', 'someone/dear-vision'],
      );
    });

    test('says which models do not promise to follow a schema', () async {
      final models = await clientReturning(_catalogue).visionModels();
      final loose = models.firstWhere((m) => m.id == 'someone/dear-vision');

      expect(loose.followsSchemas, isFalse);
      expect(
        models.firstWhere((m) => m.id == 'openai/gpt-5.6-luna').followsSchemas,
        isTrue,
      );
    });

    test('a catalogue that will not load says why', () async {
      final client = clientReturning(
        jsonEncode({'error': {'message': 'Upstream is down'}}),
        status: 503,
      );

      await expectLater(
        client.visionModels(),
        throwsA(isA<OpenRouterException>()
            .having((e) => e.message, 'message', 'Upstream is down')
            .having((e) => e.retryable, 'retryable', isTrue)),
      );
    });
  });

  group('the key', () {
    test('a stored key is what gets sent', () async {
      FlutterSecureStorage.setMockInitialValues(
        {'openrouter_api_key': 'sk-or-mine'},
      );
      final account = OpenRouterAccount();
      await account.load();

      expect(account.isConnected, isTrue);
      expect(account.apiKey, 'sk-or-mine');
      expect(
        account.usingBuildKey,
        isFalse,
        reason: 'a key someone signed in with is never the build fallback',
      );
    });

    test('disconnecting forgets it', () async {
      FlutterSecureStorage.setMockInitialValues(
        {'openrouter_api_key': 'sk-or-mine'},
      );
      final account = OpenRouterAccount();
      await account.load();

      await account.disconnect();

      expect(account.isConnected, isFalse);
      expect(account.apiKey, isNull);
    });

    /// Not connected is not broken: meals are logged and kept, they just wait.
    /// The call is the only thing that refuses.
    test('estimating without one is refused before anything is sent', () async {
      var called = false;
      final client = OpenRouterClient(
        account: OpenRouterAccount(),
        httpClient: MockClient((_) async {
          called = true;
          return http.Response('{}', 200);
        }),
      );

      await expectLater(
        client.estimate(words: 'a bowl of soup'),
        throwsA(isA<OpenRouterException>()),
      );
      expect(called, isFalse);
    });
  });

  /// The other way in, for a key made by hand on openrouter.ai/keys.
  group('a pasted key', () {
    /// Requests OpenRouter answers 200 for, so `useKey` gets that far.
    OpenRouterAccount accountAnswering(
      Future<http.Response> Function(http.Request) respond,
    ) =>
        OpenRouterAccount(httpClient: MockClient(respond));

    test('is checked against OpenRouter before it is kept', () async {
      http.Request? sent;
      final account = accountAnswering((request) async {
        sent = request;
        return http.Response(jsonEncode({'data': {'label': 'mine'}}), 200);
      });

      await account.useKey('sk-or-typed');

      expect(sent?.url.path, '/api/v1/key');
      expect(sent?.headers['Authorization'], 'Bearer sk-or-typed');
      expect(account.apiKey, 'sk-or-typed');
      expect(account.isConnected, isTrue);
    });

    test('outlives the app, like a key signed in with', () async {
      final account = accountAnswering(
        (_) async => http.Response(jsonEncode({'data': {}}), 200),
      );
      await account.useKey('sk-or-typed');

      final reopened = OpenRouterAccount();
      await reopened.load();

      expect(reopened.apiKey, 'sk-or-typed');
    });

    /// The whole reason it is checked at all: a key that is never verified does
    /// nothing visible until the next meal, which then fails on a 401 the queue
    /// will not retry.
    test('that OpenRouter rejects is not kept, and says why', () async {
      final account = accountAnswering(
        (_) async => http.Response(
          jsonEncode({'error': {'message': 'User not found.'}}),
          401,
        ),
      );

      await expectLater(
        account.useKey('sk-or-wrong'),
        throwsA(isA<OpenRouterException>()
            .having((e) => e.message, 'message', 'User not found.')),
      );
      expect(account.isConnected, isFalse);
      expect(
        await const FlutterSecureStorage().read(key: 'openrouter_api_key'),
        isNull,
      );
    });

    test('surrounded by whitespace still works — it was pasted', () async {
      final account = accountAnswering(
        (_) async => http.Response(jsonEncode({'data': {}}), 200),
      );

      await account.useKey('  sk-or-typed\n');

      expect(account.apiKey, 'sk-or-typed');
    });

    test('that is blank is refused without asking OpenRouter', () async {
      var called = false;
      final account = accountAnswering((_) async {
        called = true;
        return http.Response('{}', 200);
      });

      await expectLater(
        account.useKey('   '),
        throwsA(isA<OpenRouterException>()),
      );
      expect(called, isFalse);
      expect(account.isConnected, isFalse);
    });

    test('beats the key the build was compiled with', () async {
      final account = accountAnswering(
        (_) async => http.Response(jsonEncode({'data': {}}), 200),
      );

      await account.useKey('sk-or-typed');

      expect(
        account.usingBuildKey,
        isFalse,
        reason: 'a key someone pasted is theirs, and is what gets billed',
      );
    });
  });

  group('the model picker default', () {
    test('is a model that exists, sees images and follows schemas', () async {
      final models = await clientReturning(_catalogue).visionModels();
      final chosen = models
          .where((m) => m.id == OpenRouterAccount.defaultModel)
          .toList();

      expect(chosen, hasLength(1));
      expect(chosen.single.seesImages, isTrue);
      expect(chosen.single.followsSchemas, isTrue);
    });

    test('a meal costs a fraction of a cent to estimate', () async {
      final models = await clientReturning(_catalogue).visionModels();
      final chosen =
          models.firstWhere((m) => m.id == OpenRouterAccount.defaultModel);

      // Not a pricing assertion — a units one. Read the per-token price as the
      // per-million price by mistake and this is off by a factor of a million,
      // which is the difference between "a few cents a month" and a bill.
      expect(chosen.dollarsPerMeal, lessThan(0.01));
    });
  });
}

/// Trimmed to the fields this app reads, in the shape `/api/v1/models` uses.
final _catalogue = jsonEncode({
  'data': [
    {
      'id': 'someone/text-only',
      'name': 'Text Only',
      'architecture': {
        'input_modalities': ['text'],
      },
      'supported_parameters': ['structured_outputs'],
      'pricing': {'prompt': '0.0000001', 'completion': '0.0000001'},
    },
    {
      'id': 'openai/gpt-5.6-luna',
      'name': 'GPT-5.6 Luna',
      'architecture': {
        'input_modalities': ['file', 'image', 'text'],
      },
      'supported_parameters': ['structured_outputs', 'tools'],
      'pricing': {'prompt': '0.0000001', 'completion': '0.0000006'},
    },
    {
      'id': 'someone/dear-vision',
      'name': 'Dear Vision',
      'architecture': {
        'input_modalities': ['image', 'text'],
      },
      'supported_parameters': ['tools'],
      'pricing': {'prompt': '0.000005', 'completion': '0.00003'},
    },
    {
      'id': 'someone/cheap-vision',
      'name': 'Cheap Vision',
      'architecture': {
        'input_modalities': ['image', 'text'],
      },
      'supported_parameters': ['structured_outputs'],
      'pricing': {'prompt': '0.00000001', 'completion': '0.00000002'},
    },
  ],
});
