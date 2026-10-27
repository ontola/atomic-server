import 'package:atomic_chat/atomic_chat.dart'
    show
        AppTopBar,
        ChatScreen,
        ResourceRow,
        RowShape,
        formatCredits,
        iconForClass,
        readableHorizontalPadding;
import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:flutter/material.dart';

import '../assistant/atomic_assistant_api.dart';
import '../atomic/account_store.dart';
import '../theme.dart';

/// What the included AI used: the credits of this period, and, when the
/// provider reports it, the tokens and cost per model and per chat. A chat
/// opens on tap.
class AiUsageScreen extends StatefulWidget {
  /// The account's credits; [AccountStore.aiCredits] by default.
  final Future<shared.AtomicAiCredits?> Function()? loadCredits;

  /// The usage report; [AccountStore.aiUsage] by default. Null result: the
  /// provider has none.
  final Future<shared.AtomicAiUsage?> Function()? loadUsage;

  /// The names of the AI chats by subject; the app's chats by default.
  final Future<Map<String, String>> Function()? loadChatNames;

  const AiUsageScreen(
      {super.key, this.loadCredits, this.loadUsage, this.loadChatNames});

  @override
  State<AiUsageScreen> createState() => _AiUsageScreenState();
}

class _AiUsageScreenState extends State<AiUsageScreen> {
  shared.AtomicAiCredits? _credits;
  shared.AtomicAiUsage? _usage;
  Map<String, String> _names = const {};
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    shared.AtomicAiCredits? credits;
    shared.AtomicAiUsage? usage;
    var names = const <String, String>{};
    String? error;
    try {
      credits = await (widget.loadCredits ?? AccountStore.aiCredits)();
      // An older portal has no report: the credits are all there is.
      usage = await (widget.loadUsage ?? AccountStore.aiUsage)();
      if (usage != null && usage.chats.isNotEmpty) {
        names = await (widget.loadChatNames ?? _chatNames)()
            .catchError((Object _) => const <String, String>{});
      }
    } catch (e) {
      error = '$e';
    }
    if (!mounted) return;
    setState(() {
      _credits = credits;
      _usage = usage;
      _names = names;
      _error = error;
      _loading = false;
    });
  }

  static Future<Map<String, String>> _chatNames() async => {
        for (final c in await const AtomicAssistantApi().chats())
          c.subject: c.name,
      };

  static String _tokens(shared.AtomicAiUsageTotal t) => [
        '${t.promptTokens} in, ${t.completionTokens} out',
        if (t.costMicros > 0) formatCredits(t.costMicros),
        '${t.requests} ${t.requests == 1 ? 'request' : 'requests'}',
      ].join(' · ');

  String _modelName(String id) =>
      _credits?.models.where((m) => m.id == id).firstOrNull?.name ?? id;

  void _openChat(String subject, String title) =>
      Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => ChatScreen(
            api: const AtomicAssistantApi(), subject: subject, title: title),
      ));

  List<Widget> _creditRows(shared.AtomicAiCredits c) {
    final resets = c.resetsAt?.toLocal();
    return [
      shared.SyncRow(
        icon: Icons.auto_awesome_outlined,
        title: 'Used this period',
        subtitle: c.allowance > 0
            ? '${c.used} of ${c.allowance} credits'
            : '${c.used} credits',
      ),
      shared.SyncRow(
        icon: Icons.hourglass_bottom,
        title: 'Left',
        subtitle: '${c.remaining} credits',
      ),
      if (c.purchased > 0)
        shared.SyncRow(
          icon: Icons.add_card_outlined,
          title: 'Purchased',
          subtitle: '${c.purchased} credits left',
        ),
      if (resets != null)
        shared.SyncRow(
          icon: Icons.event_repeat,
          title: 'Resets',
          subtitle: '${resets.year}-${resets.month.toString().padLeft(2, '0')}-'
              '${resets.day.toString().padLeft(2, '0')}',
        ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    final credits = _credits;
    final usage = _usage;
    return Scaffold(
      backgroundColor: c.bgBody,
      appBar: AppTopBar(title: 'AI usage', actions: [
        IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _load),
      ]),
      body: LayoutBuilder(
        builder: (context, box) => ListView(
          padding: readableHorizontalPadding(box.maxWidth),
          children: [
            if (_loading && credits == null)
              const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator()),
              ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: shared.ErrorText(_error!, color: c.alert),
              ),
            if (credits != null)
              shared.SyncSection(
                  title: 'Credits', children: _creditRows(credits)),
            if (!_loading && _error == null && credits != null && usage == null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                    'Usage per model and per chat is not available from your '
                    'account provider.',
                    key: const Key('ai-usage-unavailable'),
                    style: TextStyle(color: c.textSecondary)),
              ),
            if (usage != null && usage.models.isNotEmpty)
              shared.SyncSection(title: 'Models', children: [
                for (final m in usage.models)
                  shared.SyncRow(
                    key: Key('ai-usage-model-${m.id}'),
                    icon: Icons.memory,
                    title: _modelName(m.id),
                    subtitle: _tokens(m),
                  ),
              ]),
            if (usage != null && usage.chats.isNotEmpty)
              shared.SyncSection(title: 'Chats', padded: false, children: [
                for (final t in usage.chats)
                  ResourceRow(
                    key: Key('ai-usage-chat-${t.id}'),
                    icon: iconForClass('ai-chat'),
                    shape: RowShape.circle,
                    title: _names[t.id] ?? 'AI chat',
                    detail: _tokens(t),
                    onTap: () => _openChat(t.id, _names[t.id] ?? ''),
                  ),
              ]),
          ],
        ),
      ),
    );
  }
}
