import 'package:atomic_chat/atomic_chat.dart'
    show
        AiChatSettings,
        AppTopBar,
        ChatUsageStore,
        HostedAi,
        HostedAvailability,
        SpeechInput,
        VoiceSettings,
        accountVoiceAvailability,
        readableHorizontalPadding,
        showAiModelPicker;
import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../assistant/atomic_assistant_api.dart';
import '../atomic/account_store.dart';
import '../atomic/own_ai.dart';
import '../theme.dart';
import 'ai_usage_screen.dart';

/// Everything about the AI in one place, as the web app's AI settings: which
/// AI answers (the included AI of the atomic.place account, or the person's
/// own OpenRouter key), the credits and where to buy more, the model, and
/// whether chats show their token usage; the voice input; and, when opened
/// from a chat, what that chat used and Report this chat.
class AiSettingsScreen extends StatefulWidget {
  /// The account's credits; [AccountStore.aiCredits] by default.
  final Future<shared.AtomicAiCredits?> Function()? loadCredits;

  /// The account's usage report; [AccountStore.aiUsage] by default.
  final Future<shared.AtomicAiUsage?> Function()? loadUsage;

  /// Every model of the included AI; [AccountStore.aiModels] by default.
  final Future<List<shared.AtomicAiModel>?> Function()? loadModels;

  /// Every model of the own provider; [OwnAi.models] by default.
  final Future<List<shared.AtomicAiModel>?> Function()? loadOwnModels;

  /// The account portal, where credits are bought; [AccountStore.portal] by
  /// default.
  final Future<Uri?> Function()? loadPortal;

  /// The chat these settings were opened from, if any.
  final AiChatSettings? chat;

  /// The device's speech recogniser, for the voice language list; the
  /// platform's by default.
  final SpeechInput? speechInput;

  /// Whether the account can transcribe; looked up from the linked account by
  /// default.
  final Future<HostedAvailability> Function()? voiceAvailability;

  const AiSettingsScreen({
    super.key,
    this.chat,
    this.speechInput,
    this.voiceAvailability,
    this.loadCredits,
    this.loadUsage,
    this.loadModels,
    this.loadOwnModels,
    this.loadPortal,
  });

  @override
  State<AiSettingsScreen> createState() => _AiSettingsScreenState();
}

class _AiSettingsScreenState extends State<AiSettingsScreen> {
  bool _own = false, _hasKey = false, _showUsage = false;
  shared.AtomicAiCredits? _credits;
  Uri? _portal;
  bool _loading = false, _failed = false;
  String? _model, _modelLabel;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final own = await OwnAi.enabled();
    final hasKey = await OwnAi.apiKey() != null;
    final show = await ChatUsageStore.shown();
    final model = await HostedAi.storedModel();
    final label = await HostedAi.storedModelLabel();
    Uri? portal;
    shared.AtomicAiCredits? credits = _credits;
    var failed = false;
    try {
      portal = await (widget.loadPortal ?? AccountStore.portal)();
      credits = await (widget.loadCredits ?? AccountStore.aiCredits)();
    } catch (_) {
      failed = true;
    }
    if (!mounted) return;
    setState(() {
      _own = own;
      _hasKey = hasKey;
      _showUsage = show;
      _model = model;
      _modelLabel = label;
      _portal = portal;
      _credits = credits;
      _failed = failed;
      _loading = false;
    });
  }

  Future<void> _useIncluded() async {
    await OwnAi.setEnabled(false);
    if (mounted) setState(() => _own = false);
  }

  Future<void> _useOwn() async {
    if (_hasKey) {
      await OwnAi.setEnabled(true);
      if (mounted) setState(() => _own = true);
    } else {
      await _editKey();
    }
  }

  /// Asks for the OpenRouter key; saving it switches to it, removing it
  /// switches back.
  Future<void> _editKey() async {
    final field = TextEditingController();
    final key = await showDialog<String>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('OpenRouter API key'),
        content: TextField(
          key: const Key('ai-key-field'),
          controller: field,
          obscureText: true,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'sk-or-…'),
        ),
        actions: [
          if (_hasKey)
            TextButton(
              key: const Key('ai-key-remove'),
              onPressed: () => Navigator.pop(dialog, ''),
              child: const Text('Remove key'),
            ),
          TextButton(
              onPressed: () => Navigator.pop(dialog),
              child: const Text('Cancel')),
          TextButton(
              key: const Key('ai-key-save'),
              onPressed: () => Navigator.pop(dialog, field.text.trim()),
              child: const Text('Save')),
        ],
      ),
    );
    if (key == null) return;
    await OwnAi.setApiKey(key);
    if (key.isNotEmpty) await OwnAi.setEnabled(true);
    if (mounted) {
      setState(() {
        _hasKey = key.isNotEmpty;
        _own = key.isNotEmpty;
      });
    }
  }

  /// The model in use: the stored choice while the provider allows it, else
  /// its default.
  shared.AtomicAiModel? get _chosenModel {
    final stored = _model;
    if (_own) {
      return shared.AtomicAiModel(
          id: stored ?? OwnAi.defaultModel,
          label: stored == null ? OwnAi.defaultModel : (_modelLabel ?? ''));
    }
    final models = _credits?.models ?? const <shared.AtomicAiModel>[];
    final listed = models.where((m) => m.id == stored).firstOrNull;
    if (listed != null) return listed;
    if (_credits?.allModels == true && stored != null && stored.isNotEmpty) {
      return shared.AtomicAiModel(id: stored, label: _modelLabel ?? '');
    }
    return models.firstOrNull;
  }

  Future<void> _pickModel() async {
    final credits = _credits;
    final picked = await showAiModelPicker(context,
        models:
            _own ? const [] : credits?.models ?? const <shared.AtomicAiModel>[],
        selected: _chosenModel?.id ?? '',
        loadAll: _own
            ? (widget.loadOwnModels ?? OwnAi.models)
            : credits?.allModels == true
                ? (widget.loadModels ?? AccountStore.aiModels)
                : null);
    if (picked == null) return;
    await HostedAi.storeModel(picked.id, label: picked.name);
    if (mounted) {
      setState(() {
        _model = picked.id;
        _modelLabel = picked.name;
      });
    }
  }

  String _creditsLine() {
    final c = _credits;
    if (c == null) return _failed ? 'Could not load' : '—';
    final resets = c.resetsAt?.toLocal();
    return [
      if (c.allowance > 0)
        '${c.remaining} of ${c.allowance} this month'
      else
        '${c.remaining} left',
      if (c.used > 0) '${c.used} used',
      if (c.purchased > 0) '${c.purchased} purchased',
      if (resets != null)
        'resets ${resets.year}-${resets.month.toString().padLeft(2, '0')}-'
            '${resets.day.toString().padLeft(2, '0')}',
      if (_failed) 'offline, last known',
    ].join(' · ');
  }

  Future<HostedAvailability> _voiceAvailability() async =>
      accountVoiceAvailability(await const AtomicAssistantApi().hostedAi());

  Widget _radio(bool on) =>
      Icon(on ? Icons.radio_button_checked : Icons.radio_button_unchecked,
          size: 24);

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    final credits = _credits;
    final canChoose = _own ||
        (credits != null && (credits.allModels || credits.models.length > 1));
    return Scaffold(
      backgroundColor: c.bgBody,
      appBar: const AppTopBar(title: 'AI settings'),
      body: LayoutBuilder(
        builder: (context, box) => ListView(
          padding: readableHorizontalPadding(box.maxWidth),
          children: [
            if (widget.chat != null)
              shared.SyncSection(title: 'This chat', children: [
                shared.SyncRow(
                  key: const Key('chat-usage'),
                  icon: Icons.data_usage,
                  title: 'Used in this chat',
                  subtitle: widget.chat!.usage,
                ),
                if (widget.chat!.onReport != null)
                  shared.SyncRow(
                    key: const Key('chat-report'),
                    icon: Icons.flag_outlined,
                    title: 'Report this chat',
                    subtitle: 'Tell us what went wrong',
                    onTap: widget.chat!.onReport,
                  ),
              ]),
            shared.SyncSection(title: 'AI provider', children: [
              shared.SyncRow(
                key: const Key('ai-mode-included'),
                icon: Icons.auto_awesome_outlined,
                title: 'Included AI',
                subtitle: credits == null && !_loading
                    ? 'Your atomic.place account (not linked)'
                    : 'Your atomic.place account, paid with its credits',
                trailing: _radio(!_own),
                onTap: _useIncluded,
              ),
              shared.SyncRow(
                key: const Key('ai-mode-own'),
                icon: Icons.key_outlined,
                title: 'Your own OpenRouter key',
                subtitle: _hasKey ? 'Key saved' : 'Add an API key',
                trailing: _radio(_own),
                onTap: _useOwn,
              ),
              if (_hasKey)
                shared.SyncRow(
                  key: const Key('ai-key-row'),
                  icon: Icons.edit_outlined,
                  title: 'Change or remove the key',
                  onTap: _editKey,
                ),
            ]),
            if (!_own)
              shared.SyncSection(title: 'Credits', children: [
                shared.SyncRow(
                  key: const Key('ai-credits-row'),
                  icon: Icons.account_balance_wallet_outlined,
                  title: 'AI credits',
                  subtitle: _creditsLine(),
                  trailing: _loading
                      ? const shared.SyncSpinner()
                      : IconButton(
                          tooltip: 'Refresh AI credits',
                          icon: const Icon(Icons.refresh, size: 24),
                          constraints:
                              const BoxConstraints(minWidth: 48, minHeight: 48),
                          onPressed: _load),
                ),
                if (_portal != null)
                  shared.SyncRow(
                    key: const Key('ai-buy-credits'),
                    icon: Icons.add_card_outlined,
                    title: 'Buy credits',
                    onTap: () => launchUrl(
                        _portal!.replace(
                            path: '/dashboard', query: null, fragment: null),
                        mode: LaunchMode.externalApplication),
                  ),
                if (credits != null)
                  shared.SyncRow(
                    key: const Key('ai-usage-row'),
                    icon: Icons.bar_chart,
                    title: 'AI usage',
                    subtitle: 'Credits, models and chats this month',
                    onTap: () =>
                        Navigator.of(context).push(MaterialPageRoute<void>(
                      builder: (_) => AiUsageScreen(
                          loadCredits: widget.loadCredits,
                          loadUsage: widget.loadUsage),
                    )),
                  ),
              ]),
            shared.SyncSection(title: 'Chat', children: [
              if (canChoose)
                shared.SyncRow(
                  key: const Key('ai-model-row'),
                  icon: Icons.tune,
                  title: 'AI model',
                  subtitle: _chosenModel?.name,
                  onTap: _pickModel,
                ),
              shared.SyncRow(
                icon: Icons.numbers,
                title: 'Show token usage',
                subtitle: 'In each AI chat',
                trailing: Switch(
                  key: const Key('ai-show-usage'),
                  value: _showUsage,
                  onChanged: (v) {
                    setState(() => _showUsage = v);
                    ChatUsageStore.setShown(v);
                  },
                ),
              ),
            ]),
            VoiceSettings(
              input: widget.speechInput,
              availability: widget.voiceAvailability ?? _voiceAvailability,
            ),
          ],
        ),
      ),
    );
  }
}
