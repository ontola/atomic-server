import 'dart:convert';

import 'package:atomic_flutter/atomic_flutter.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

AtomicAccountClient _linked(
        int status, Object body, List<http.BaseRequest> seen) =>
    AtomicAccountClient('https://provider.example',
        client: MockClient((request) async {
      seen.add(request);
      return http.Response(jsonEncode(body), status);
    }))
      ..restoreSession(
          jsonEncode({'origin': 'https://provider.example/', 'token': 't'}));

void main() {
  group('status', () {
    test('reads the models, the default first, and the usage fields', () {
      final credits = AtomicAiCredits.fromJson({
        'enabled': true,
        'model': 'google/flash',
        'models': [
          {
            'id': 'google/flash',
            'label': 'Gemini Flash',
            'max_prompt': 0.5,
            'max_completion': 3.0,
          },
          {'id': 'x/big', 'max_prompt': 10, 'max_completion': 30},
          {'label': 'no id'},
        ],
        'used_micros': 4500,
        'granted_micros': 12000,
        'allowance_micros': 10000,
        'remaining_micros': 7500,
      });
      expect(credits.model, 'google/flash');
      expect(credits.models.map((m) => m.id), ['google/flash', 'x/big']);
      expect(credits.models.first.name, 'Gemini Flash');
      expect(credits.models.last.name, 'x/big');
      expect(credits.models.first.priceHint, r'$0.5 in, $3 out per 1M tokens');
      expect(credits.models.last.priceHint, r'$10 in, $30 out per 1M tokens');
      expect(credits.used, 4);
      expect(credits.grantedMicros, 12000);
    });

    test('an older portal lists no models', () {
      final credits = AtomicAiCredits.fromJson(
          {'enabled': true, 'model': 'm', 'remaining_micros': 1000});
      expect(credits.models, isEmpty);
      expect(credits.model, 'm');
      expect(credits.usedMicros, 0);
      expect(const AtomicAiModel(id: 'm').priceHint, '');
    });
  });

  group('usage', () {
    test('reads the totals per model and per chat', () async {
      final seen = <http.BaseRequest>[];
      final usage = await _linked(
              200,
              {
                'from': 1,
                'to': null,
                'models': [
                  {
                    'id': 'm',
                    'requests': 3,
                    'cost_micros': 2500,
                    'pending_micros': 100,
                    'prompt_tokens': 900,
                    'completion_tokens': 40,
                  }
                ],
                'chats': [
                  {'id': 'did:ad:chat', 'requests': 1, 'cost_micros': 1000}
                ],
                'recent': [],
              },
              seen)
          .aiUsage();
      expect(seen.single.url.path, '/api/ai/usage');
      expect(usage!.models.single.promptTokens, 900);
      expect(usage.models.single.credits, 2);
      expect(usage.models.single.pendingMicros, 100);
      expect(usage.chats.single.id, 'did:ad:chat');
      expect(usage.chats.single.completionTokens, 0);
    });

    test('null when the portal has no report or the session is invalid',
        () async {
      expect(await _linked(404, {}, []).aiUsage(), isNull);
      expect(await _linked(401, {}, []).aiUsage(), isNull);
    });
  });

  group('completions', () {
    Future<http.BaseRequest> sent({String? chat}) async {
      final seen = <http.BaseRequest>[];
      final client = AtomicAccountClient('https://provider.example',
          client: MockClient.streaming((request, body) async {
        seen.add(request);
        return http.StreamedResponse(
            Stream.value(utf8.encode('data: [DONE]\n\n')), 200);
      }))
        ..restoreSession(
            jsonEncode({'origin': 'https://provider.example/', 'token': 't'}));
      await client.chatCompletionChunks([
        {'role': 'user', 'content': 'hi'}
      ], model: 'x/big', chat: chat).toList();
      return seen.single;
    }

    test('send the chat subject as X-Atomic-Chat', () async {
      final request = await sent(chat: 'did:ad:chat');
      expect(request.headers['X-Atomic-Chat'], 'did:ad:chat');
    });

    test('send no header without a chat', () async {
      final request = await sent();
      expect(request.headers.containsKey('X-Atomic-Chat'), isFalse);
    });
  });
}
