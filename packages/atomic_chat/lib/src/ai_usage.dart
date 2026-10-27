import 'dart:convert';

import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'hosted_ai.dart';

/// Credits as the person reads them: micros are thousandths of a credit, so
/// a short answer is a fraction (`0.42 credits`), a long chat whole ones.
String formatCredits(int micros) {
  final credits = micros / 1000;
  final text = credits >= 10
      ? credits.round().toString()
      : credits
          .toStringAsFixed(2)
          .replaceFirst(RegExp(r'0+$'), '')
          .replaceFirst(RegExp(r'\.$'), '');
  return '$text ${text == '1' ? 'credit' : 'credits'}';
}

/// What the AI used for a chat: tokens in and out, and what it cost. The
/// field names are the web app's message metadata (`inputTokensUsed`,
/// `outputTokensUsed`), plus `costMicros`.
class ChatUsage {
  final int inputTokensUsed;
  final int outputTokensUsed;
  final int costMicros;

  const ChatUsage({
    this.inputTokensUsed = 0,
    this.outputTokensUsed = 0,
    this.costMicros = 0,
  });

  factory ChatUsage.fromJson(Map<String, dynamic> json) => ChatUsage(
        inputTokensUsed: (json['inputTokensUsed'] as num?)?.toInt() ?? 0,
        outputTokensUsed: (json['outputTokensUsed'] as num?)?.toInt() ?? 0,
        costMicros: (json['costMicros'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'inputTokensUsed': inputTokensUsed,
        'outputTokensUsed': outputTokensUsed,
        if (costMicros > 0) 'costMicros': costMicros,
      };

  bool get isEmpty =>
      inputTokensUsed == 0 && outputTokensUsed == 0 && costMicros == 0;

  /// This and what a model request [used] on top.
  ChatUsage plus(AiUsage used) => ChatUsage(
        inputTokensUsed: inputTokensUsed + used.promptTokens,
        outputTokensUsed: outputTokensUsed + used.completionTokens,
        costMicros: costMicros + (used.costMicros ?? 0),
      );

  ChatUsage operator +(ChatUsage other) => ChatUsage(
        inputTokensUsed: inputTokensUsed + other.inputTokensUsed,
        outputTokensUsed: outputTokensUsed + other.outputTokensUsed,
        costMicros: costMicros + other.costMicros,
      );

  /// `Tokens: 1200 in, 300 out · 0.42 credits`.
  String get line => [
        'Tokens: $inputTokensUsed in, $outputTokensUsed out',
        if (costMicros > 0) formatCredits(costMicros),
      ].join(' · ');
}

/// The usage of each chat as this device saw it, and whether to show it.
///
/// The web app does not store usage in the chat log, so there is nothing to
/// read back from the chat itself; each answer's usage is added here.
class ChatUsageStore {
  /// SharedPreferences key: show the usage of a chat (default on).
  static const showKey = 'ai_show_usage';
  static String _key(String chat) => 'ai_usage:$chat';

  static Future<bool> shown() async {
    try {
      return (await SharedPreferences.getInstance()).getBool(showKey) ?? true;
    } catch (_) {
      return true;
    }
  }

  static Future<void> setShown(bool value) async {
    try {
      await (await SharedPreferences.getInstance()).setBool(showKey, value);
    } catch (_) {}
  }

  static Future<ChatUsage> load(String chat) async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key(chat));
      if (raw == null) return const ChatUsage();
      return ChatUsage.fromJson(
          Map<String, dynamic>.from(jsonDecode(raw) as Map));
    } catch (_) {
      return const ChatUsage();
    }
  }

  /// Adds [used] to [chat]'s total; returns the new total.
  static Future<ChatUsage> add(String chat, ChatUsage used) async {
    final total = (await load(chat)) + used;
    try {
      await (await SharedPreferences.getInstance())
          .setString(_key(chat), jsonEncode(total.toJson()));
    } catch (_) {}
    return total;
  }
}

/// Asks which of [models] to use: a sheet with a row for each, the price
/// ceiling under its name when the portal gives one. Returns the picked id,
/// null when it is dismissed.
Future<String?> showAiModelPicker(
  BuildContext context, {
  required List<shared.AtomicAiModel> models,
  required String selected,
}) =>
    showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final m in models)
              ListTile(
                key: Key('ai-model-${m.id}'),
                title: Text(m.name),
                subtitle: m.priceHint.isEmpty ? null : Text(m.priceHint),
                trailing: m.id == selected ? const Icon(Icons.check) : null,
                onTap: () => Navigator.pop(sheet, m.id),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
