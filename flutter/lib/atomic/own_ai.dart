import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_chat/atomic_chat.dart'
    show HostedAi, VoiceTranscribeError;
import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'session.dart' show createSecureStorage;

/// The person's own AI provider instead of the included AI: an OpenRouter
/// API key, kept in secure storage like the other secrets. The chat talks to
/// OpenRouter's `chat/completions` with the same streaming and tool code as
/// the included AI.
class OwnAi {
  static const _keyName = 'openrouter_api_key';
  static const _modeKey = 'ai_mode_own';
  static const origin = 'https://openrouter.ai';

  /// The model used until one is chosen.
  static const defaultModel = 'openrouter/auto';

  /// The model that transcribes voice input: it takes audio and answers with
  /// text.
  static const transcriptionModel = 'google/gemini-2.5-flash';

  static const _transcribePrompt = 'Transcribe this audio verbatim. Reply '
      'with only the transcript, no commentary.';

  static final _secure = createSecureStorage();

  /// This run's key, for when the Keychain will not keep it.
  static String? _memory;

  static Future<String?> apiKey() async {
    try {
      return await _secure.read(key: _keyName) ?? _memory;
    } catch (e) {
      debugPrint('Reading the AI key failed: $e');
      return _memory;
    }
  }

  /// Saves [key]; null or empty removes it (and so leaves own-provider mode).
  static Future<void> setApiKey(String? key) async {
    final value = key?.trim();
    _memory = value == null || value.isEmpty ? null : value;
    try {
      if (_memory == null) {
        await _secure.delete(key: _keyName);
      } else {
        await _secure.write(key: _keyName, value: _memory);
      }
    } catch (e) {
      debugPrint('Saving the AI key failed: $e');
    }
    if (_memory == null) await setEnabled(false);
  }

  /// Whether the own provider is the one in use (it needs a key).
  static Future<bool> enabled() async {
    try {
      final on =
          (await SharedPreferences.getInstance()).getBool(_modeKey) ?? false;
      return on && await apiKey() != null;
    } catch (_) {
      return false;
    }
  }

  static Future<void> setEnabled(bool on) async {
    try {
      await (await SharedPreferences.getInstance()).setBool(_modeKey, on);
    } catch (_) {}
  }

  /// What the saved key has spent, in dollars, from OpenRouter; null without
  /// a key or when OpenRouter can't be reached.
  static Future<OwnKeyUsage?> keyUsage(
      {String? key, http.Client? client}) async {
    key ??= await apiKey();
    if (key == null) return null;
    final http_ = client ?? http.Client();
    final headers = {'Authorization': 'Bearer $key'};
    Future<Map?> data(String path) async {
      try {
        final response =
            await http_.get(Uri.parse('$origin$path'), headers: headers);
        if (response.statusCode != 200) return null;
        return (jsonDecode(response.body) as Map)['data'] as Map?;
      } catch (e) {
        debugPrint('Reading $path from OpenRouter failed: $e');
        return null;
      }
    }

    try {
      // The key's own spending, and the account's balance it draws from.
      final [keyData, credits] =
          await Future.wait([data('/api/v1/key'), data('/api/v1/credits')]);
      if (keyData == null && credits == null) return null;
      double? number(Object? value) => value is num ? value.toDouble() : null;
      final total = number(credits?['total_credits']);
      final spent = number(credits?['total_usage']);
      return OwnKeyUsage(
        used: number(keyData?['usage']) ?? spent ?? 0,
        thisMonth: number(keyData?['usage_monthly']),
        left: number(keyData?['limit_remaining']) ??
            (total != null && spent != null ? total - spent : null),
      );
    } finally {
      if (client == null) http_.close();
    }
  }

  /// The AI when the own provider is in use, else null.
  static Future<HostedAi?> hostedAi({http.Client? client}) async {
    final key = await apiKey();
    if (key == null || !await enabled()) return null;
    final ai = HostedAi(
      status: {
        'enabled': true,
        'consent': true,
        'model': defaultModel,
        'all_models': true,
      },
      chatCompletions: (messages, model, tools, chat) =>
          completions(key, messages, model, tools, client: client),
      loadModels: () => models(client: client),
      enable: () async => {},
      // Voice goes through the same key and costs no account credits.
      transcribe: (wav, {language}) =>
          transcribeWav(key, wav, language: language, client: client),
      voiceStatus: () async => {'enabled': true},
      ownKey: true,
    );
    await ai.restoreChoice();
    return ai;
  }

  /// One streamed answer from OpenRouter: the decoded chunks, as the
  /// included AI's.
  static Stream<Map<String, dynamic>> completions(
      String key,
      List<Map<String, dynamic>> messages,
      String model,
      List<Map<String, dynamic>>? tools,
      {http.Client? client}) async* {
    final http_ = client ?? http.Client();
    try {
      final request =
          http.Request('POST', Uri.parse('$origin/api/v1/chat/completions'))
            ..headers.addAll({
              'Authorization': 'Bearer $key',
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            })
            ..body = jsonEncode({
              'model': model,
              'messages': messages,
              'stream': true,
              'usage': {'include': true},
              if (tools != null && tools.isNotEmpty) ...{
                'tools': tools,
                'tool_choice': 'auto',
              },
            });
      final response = await http_.send(request);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final body = await response.stream.bytesToString();
        var message = 'OpenRouter failed (${response.statusCode})';
        try {
          final error = (jsonDecode(body) as Map)['error'];
          if (error is Map && error['message'] is String) {
            message = error['message'] as String;
          }
        } catch (_) {}
        if (response.statusCode == 401) message = 'OpenRouter rejected the key';
        throw StateError(message);
      }
      yield* shared.AtomicAccountClient.parseCompletionChunks(
          response.stream.transform(utf8.decoder));
    } finally {
      if (client == null) http_.close();
    }
  }

  /// The text of the speech in [wav] (16-bit mono PCM WAV), transcribed by
  /// [transcriptionModel]. [language] is an ISO-639-1 hint. Throws a
  /// [VoiceTranscribeError] with OpenRouter's message when it refuses.
  static Future<String> transcribeWav(String key, Uint8List wav,
      {String? language, http.Client? client}) async {
    final http_ = client ?? http.Client();
    try {
      final hint = language == null || language.isEmpty
          ? ''
          : ' The language is "$language".';
      final http.Response response;
      try {
        response = await http_.post(
          Uri.parse('$origin/api/v1/chat/completions'),
          headers: {
            'Authorization': 'Bearer $key',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'model': transcriptionModel,
            'messages': [
              {
                'role': 'user',
                'content': [
                  {'type': 'text', 'text': '$_transcribePrompt$hint'},
                  {
                    'type': 'input_audio',
                    'input_audio': {
                      'data': base64Encode(wav),
                      'format': 'wav',
                    },
                  },
                ],
              },
            ],
          }),
        );
      } catch (_) {
        throw const VoiceTranscribeError(
            'No internet connection for voice input.');
      }
      Object? body;
      try {
        body = jsonDecode(utf8.decode(response.bodyBytes));
      } catch (_) {}
      if (response.statusCode < 200 || response.statusCode >= 300) {
        var message = 'OpenRouter failed (${response.statusCode})';
        final error = body is Map ? body['error'] : null;
        if (error is Map && error['message'] is String) {
          message = error['message'] as String;
        }
        if (response.statusCode == 401) message = 'OpenRouter rejected the key';
        throw VoiceTranscribeError(message);
      }
      final choices = body is Map ? body['choices'] : null;
      final first = choices is List && choices.isNotEmpty ? choices[0] : null;
      final message = first is Map ? first['message'] : null;
      final content = message is Map ? message['content'] : null;
      if (content is String) return content.trim();
      if (content is List) {
        return [
          for (final part in content)
            if (part is Map && part['text'] is String) part['text'] as String,
        ].join().trim();
      }
      // An error inside a 200 answer.
      final error = body is Map ? body['error'] : null;
      if (error is Map && error['message'] is String) {
        throw VoiceTranscribeError(error['message'] as String);
      }
      throw const VoiceTranscribeError('OpenRouter returned no transcript.');
    } finally {
      if (client == null) http_.close();
    }
  }

  /// OpenRouter's models (public list).
  static Future<List<shared.AtomicAiModel>?> models(
      {http.Client? client}) async {
    final http_ = client ?? http.Client();
    try {
      final response = await http_.get(Uri.parse('$origin/api/v1/models'));
      if (response.statusCode != 200) return null;
      final data = (jsonDecode(response.body) as Map)['data'];
      return [
        if (data is List)
          for (final m in data)
            if (m is Map && m['id'] is String)
              shared.AtomicAiModel(
                  id: m['id'] as String,
                  label: m['name'] as String? ?? '',
                  context: (m['context_length'] as num?)?.toInt() ?? 0),
      ];
    } finally {
      if (client == null) http_.close();
    }
  }
}

/// What an OpenRouter key has spent, in dollars.
class OwnKeyUsage {
  /// Everything the key has spent.
  final double used;

  /// What it spent this calendar month, when OpenRouter says.
  final double? thisMonth;

  /// What it can still spend: its own limit's remainder, else the account's
  /// balance.
  final double? left;

  const OwnKeyUsage({required this.used, this.thisMonth, this.left});

  /// One line for a settings row, such as "\$1.20 this month · \$8.80 left".
  String get line => [
        if (thisMonth != null)
          '${_dollars(thisMonth!)} this month'
        else
          '${_dollars(used)} used',
        if (left != null) '${_dollars(left!)} left',
      ].join(' · ');

  static String _dollars(double value) => '\$${value.toStringAsFixed(2)}';
}
