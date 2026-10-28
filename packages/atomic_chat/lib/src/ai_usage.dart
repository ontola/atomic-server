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
  /// SharedPreferences key: show the usage of a chat (default off).
  static const showKey = 'ai_show_usage';
  static String _key(String chat) => 'ai_usage:$chat';

  static Future<bool> shown() async {
    try {
      return (await SharedPreferences.getInstance()).getBool(showKey) ?? false;
    } catch (_) {
      return false;
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
/// ceiling under its name when the portal gives one. With [loadAll] (the
/// account may use any model) it ends with an "All models…" row that opens
/// the whole list to search. Returns the picked model, null when dismissed.
Future<shared.AtomicAiModel?> showAiModelPicker(
  BuildContext context, {
  required List<shared.AtomicAiModel> models,
  required String selected,
  Future<List<shared.AtomicAiModel>?> Function()? loadAll,
}) =>
    showModalBottomSheet<shared.AtomicAiModel>(
      context: context,
      showDragHandle: true,
      isScrollControlled: loadAll != null,
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
                onTap: () => Navigator.pop(sheet, m),
              ),
            if (loadAll != null)
              ListTile(
                key: const Key('ai-model-all'),
                title: const Text('All models…'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () async {
                  final picked = await Navigator.of(sheet).push(
                    MaterialPageRoute<shared.AtomicAiModel>(
                      builder: (_) =>
                          AllAiModelsPage(load: loadAll, selected: selected),
                    ),
                  );
                  if (picked != null && sheet.mounted) {
                    Navigator.pop(sheet, picked);
                  }
                },
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );

/// Whether [m] matches the search [query] on its label or id.
bool aiModelMatches(shared.AtomicAiModel m, String query) {
  final q = query.trim().toLowerCase();
  return q.isEmpty ||
      m.label.toLowerCase().contains(q) ||
      m.id.toLowerCase().contains(q);
}

/// The whole list of models, filtered as the person types. Pops the picked
/// model.
class AllAiModelsPage extends StatefulWidget {
  const AllAiModelsPage({super.key, required this.load, this.selected = ''});

  final Future<List<shared.AtomicAiModel>?> Function() load;
  final String selected;

  @override
  State<AllAiModelsPage> createState() => _AllAiModelsPageState();
}

class _AllAiModelsPageState extends State<AllAiModelsPage> {
  List<shared.AtomicAiModel>? _all;
  bool _failed = false;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    List<shared.AtomicAiModel>? all;
    try {
      all = await widget.load();
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _all = all;
      _failed = all == null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final all = _all;
    final shown = [
      if (all != null)
        for (final m in all)
          if (aiModelMatches(m, _query)) m,
    ];
    return Scaffold(
      appBar: AppBar(title: const Text('All models')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              key: const Key('ai-model-search'),
              autofocus: true,
              decoration: const InputDecoration(
                hintText: 'Search models',
                prefixIcon: Icon(Icons.search),
              ),
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          Expanded(
            child: all == null && !_failed
                ? const Center(child: CircularProgressIndicator())
                : _failed
                    ? const Center(child: Text('Could not load the models.'))
                    : ListView.builder(
                        itemCount: shown.length,
                        itemBuilder: (_, i) {
                          final m = shown[i];
                          return ListTile(
                            key: Key('ai-model-${m.id}'),
                            title: Text(m.name),
                            subtitle: Text([
                              m.id,
                              if (m.priceHint.isNotEmpty) m.priceHint,
                            ].join('\n')),
                            isThreeLine: m.priceHint.isNotEmpty,
                            trailing: m.id == widget.selected
                                ? const Icon(Icons.check)
                                : null,
                            onTap: () => Navigator.pop(context, m),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}
