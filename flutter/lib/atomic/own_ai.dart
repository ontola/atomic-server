import 'dart:convert';

import 'package:atomic_chat/atomic_chat.dart' show HostedAi;
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
