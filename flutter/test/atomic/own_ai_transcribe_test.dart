import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_chat/atomic_chat.dart' show VoiceTranscribeError;
import 'package:atomic_app/atomic/own_ai.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  final wav = Uint8List.fromList([1, 2, 3, 4]);

  test('posts the audio to OpenRouter and returns the transcript', () async {
    late http.Request seen;
    final client = MockClient((request) async {
      seen = request;
      return http.Response(
        jsonEncode({
          'choices': [
            {
              'message': {'content': '  goedemorgen allemaal \n'},
            },
          ],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final text = await OwnAi.transcribeWav('sk-key', wav,
        language: 'nl', client: client);
    expect(text, 'goedemorgen allemaal');
    expect(seen.url.toString(),
        'https://openrouter.ai/api/v1/chat/completions');
    expect(seen.headers['Authorization'], 'Bearer sk-key');
    final body = jsonDecode(seen.body) as Map<String, dynamic>;
    expect(body['model'], 'google/gemini-2.5-flash');
    final message = (body['messages'] as List).single as Map;
    final content = message['content'] as List;
    expect(content[0]['type'], 'text');
    expect(content[0]['text'], contains('Transcribe this audio verbatim.'));
    expect(content[0]['text'], contains('"nl"'));
    expect(content[1]['type'], 'input_audio');
    expect(content[1]['input_audio']['format'], 'wav');
    expect(content[1]['input_audio']['data'], base64Encode(wav));
  });

  test('no language hint without a language', () async {
    late String prompt;
    final client = MockClient((request) async {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      final message = (body['messages'] as List).single as Map;
      prompt = (message['content'] as List)[0]['text'] as String;
      return http.Response(
          jsonEncode({
            'choices': [
              {
                'message': {'content': 'hi'},
              },
            ],
          }),
          200);
    });
    await OwnAi.transcribeWav('k', wav, client: client);
    expect(prompt, isNot(contains('language')));
  });

  test('an error shows OpenRouter\'s message', () async {
    final client = MockClient((request) async => http.Response(
        jsonEncode({
          'error': {'message': 'Insufficient credits', 'code': 402},
        }),
        402));
    await expectLater(
      OwnAi.transcribeWav('k', wav, client: client),
      throwsA(isA<VoiceTranscribeError>()
          .having((e) => e.message, 'message', 'Insufficient credits')),
    );
  });

  test('a rejected key and a missing transcript have plain messages', () async {
    final rejected = MockClient((request) async => http.Response('{}', 401));
    await expectLater(
      OwnAi.transcribeWav('k', wav, client: rejected),
      throwsA(isA<VoiceTranscribeError>()
          .having((e) => e.message, 'message', 'OpenRouter rejected the key')),
    );
    final empty = MockClient((request) async => http.Response('{}', 200));
    await expectLater(
      OwnAi.transcribeWav('k', wav, client: empty),
      throwsA(isA<VoiceTranscribeError>()),
    );
  });

  test('a network failure is the offline message', () async {
    final client =
        MockClient((request) async => throw http.ClientException('x'));
    await expectLater(
      OwnAi.transcribeWav('k', wav, client: client),
      throwsA(isA<VoiceTranscribeError>().having((e) => e.message, 'message',
          'No internet connection for voice input.')),
    );
  });
}
