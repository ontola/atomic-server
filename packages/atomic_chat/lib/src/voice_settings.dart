import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:atomic_flutter/atomic_flutter.dart' show AppColorsExt;
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'hosted_voice.dart';
import 'voice.dart';

/// The "Voice" section of the AI settings: which engine transcribes (this
/// device or the atomic.place account) and its language. The device engine
/// lists the recogniser's languages (suggested ones first, with a search
/// field) in a sheet; the account engine detects the language by itself, with
/// an optional hint when the server takes one. Choices are saved as they are
/// made, under [voiceEngineKey], [voiceLocaleKey] and [voiceLanguageKey].
class VoiceSettings extends StatefulWidget {
  /// The device recogniser; the platform's by default.
  final SpeechInput? input;

  /// Whether the account can transcribe now; not linked by default.
  final Future<HostedAvailability> Function()? availability;
  final bool languageHints;

  const VoiceSettings({
    super.key,
    this.input,
    this.availability,
    this.languageHints = hostedLanguageHintSupported,
  });

  @override
  State<VoiceSettings> createState() => _VoiceSettingsState();
}

/// A row of the language sheet; [id] null is auto-detect.
typedef _Lang = ({
  Key? key,
  String? id,
  String title,
  String? sub,
  String? group,
});

class _VoiceSettingsState extends State<VoiceSettings> {
  SharedPreferences? _prefs;
  HostedAvailability? _avail;
  String? _engine, _locale, _language;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      _prefs = await SharedPreferences.getInstance();
    } catch (_) {}
    final p = _prefs;
    if (mounted) {
      setState(() {
        _engine = p?.getString(voiceEngineKey);
        _locale = p?.getString(voiceLocaleKey);
        _language = p?.getString(voiceLanguageKey);
      });
    }
    HostedAvailability avail;
    try {
      avail = widget.availability == null
          ? const HostedAvailability.unavailable(notLinkedMessage)
          : await widget.availability!();
    } catch (_) {
      avail = const HostedAvailability.unavailable(
          'Could not reach your account.');
    }
    if (mounted) setState(() => _avail = avail);
  }

  /// The engine in effect: the chosen one, else the account's when usable;
  /// the account's is never in effect while unusable.
  String get _effective {
    if (_engine == voiceEngineDevice) return voiceEngineDevice;
    return _avail?.ok == true ? voiceEngineAccount : voiceEngineDevice;
  }

  Future<void> _save(String key, String? value) async {
    try {
      if (value == null) {
        await _prefs?.remove(key);
      } else {
        await _prefs?.setString(key, value);
      }
    } catch (_) {}
  }

  Future<void> _pickEngine(String engine) async {
    setState(() => _engine = engine);
    await _save(voiceEngineKey, engine);
  }

  /// The language rows: the recogniser's (suggested first) or the account's.
  Future<List<_Lang>> _languages() async {
    if (_effective == voiceEngineAccount) {
      return [
        (
          key: const Key('language-auto'),
          id: null,
          title: 'Auto-detect',
          sub: null,
          group: null,
        ),
        for (final (code, name) in hostedLanguages)
          (
            key: Key('language-$code'),
            id: code,
            title: name,
            sub: code,
            group: null,
          ),
      ];
    }
    final input = widget.input ?? PluginSpeechInput();
    final all = await input.locales();
    final system = await input.systemLocale();
    final byId = {for (final l in all) l.id: l};
    final suggested = <SpeechLocale>[];
    for (final id in [system, 'nl_NL', 'en_US', 'en_GB']) {
      final l = id == null ? null : byId[id];
      if (l != null && !suggested.contains(l)) suggested.add(l);
    }
    final rest = [
      for (final l in all)
        if (!suggested.contains(l)) l,
    ]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    _Lang row(SpeechLocale l, String group) =>
        (key: null, id: l.id, title: l.name, sub: l.id, group: group);
    return [
      for (final l in suggested) row(l, 'Suggested'),
      for (final l in rest) row(l, 'All languages'),
    ];
  }

  Future<void> _pickLanguage() async {
    final account = _effective == voiceEngineAccount;
    final items = await _languages();
    if (!mounted) return;
    final picked = await showModalBottomSheet<({String? id})>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _LanguageSheet(
        items: items,
        selected: account ? _language : _locale,
        searchable: !account,
      ),
    );
    if (picked == null) return;
    await _save(account ? voiceLanguageKey : voiceLocaleKey, picked.id);
    if (!mounted) return;
    setState(() {
      if (account) {
        _language = picked.id;
      } else {
        _locale = picked.id;
      }
    });
  }

  Widget _engineRow({
    required Key key,
    required String engine,
    required String title,
    required String subtitle,
    bool enabled = true,
  }) {
    final c = context.appColors;
    final on = _effective == engine;
    return shared.SyncRow(
      key: key,
      icon: engine == voiceEngineAccount
          ? Icons.cloud_outlined
          : Icons.mic_none_outlined,
      title: title,
      subtitle: subtitle,
      trailing: Icon(
        on ? Icons.radio_button_checked : Icons.radio_button_unchecked,
        size: 24,
        color: on ? c.main : null,
      ),
      onTap: enabled ? () => _pickEngine(engine) : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final avail = _avail;
    final account = _effective == voiceEngineAccount;
    final hint = account && !widget.languageHints;
    final language = account
        ? _languageName(_language)
        : (_locale?.replaceAll('_', '-') ?? 'System default');
    return shared.SyncSection(title: 'Voice input', children: [
      _engineRow(
        key: const Key('engine-account'),
        engine: voiceEngineAccount,
        title: 'atomic.place account',
        subtitle: avail == null
            ? 'Checking your account…'
            : avail.ok
                ? 'Whisper, any language, uses credits'
                : avail.reason ?? 'Not available',
        enabled: avail?.ok == true,
      ),
      _engineRow(
        key: const Key('engine-device'),
        engine: voiceEngineDevice,
        title: 'This device',
        subtitle: 'Google speech recognition, free, live words',
      ),
      shared.SyncRow(
        key: const Key('voice-language-row'),
        icon: Icons.translate,
        title: 'Language',
        subtitle:
            hint ? 'Auto-detect, Whisper recognises it by itself' : language,
        onTap: hint ? null : _pickLanguage,
      ),
    ]);
  }

  String _languageName(String? code) {
    for (final (c, name) in hostedLanguages) {
      if (c == code) return name;
    }
    return 'Auto-detect';
  }
}

/// The languages to pick from, filtered by the search field when [searchable].
/// Pops the picked language's id (null: auto-detect), wrapped so a dismissed
/// sheet differs from it.
class _LanguageSheet extends StatefulWidget {
  final List<_Lang> items;
  final String? selected;
  final bool searchable;

  const _LanguageSheet({
    required this.items,
    required this.selected,
    required this.searchable,
  });

  @override
  State<_LanguageSheet> createState() => _LanguageSheetState();
}

class _LanguageSheetState extends State<_LanguageSheet> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    final q = _query.trim().toLowerCase();
    final shown = [
      for (final l in widget.items)
        if (q.isEmpty ||
            l.title.toLowerCase().contains(q) ||
            (l.sub ?? '').toLowerCase().contains(q))
          l,
    ];
    final rows = <Widget>[];
    String? group;
    for (final l in shown) {
      if (l.group != null &&
          l.group != group &&
          (group != null || l.group == 'Suggested')) {
        rows.add(Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
          child: Text(l.group!,
              style: TextStyle(color: c.textSecondary, fontSize: 12)),
        ));
      }
      group = l.group ?? group;
      rows.add(ListTile(
        key: l.key,
        dense: true,
        title: Text(l.title),
        subtitle: l.sub == null ? null : Text(l.sub!),
        selected: l.id == widget.selected,
        onTap: () => Navigator.pop(context, (id: l.id)),
      ));
    }
    return SafeArea(
      child: Padding(
        padding:
            EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.75,
          child: Column(children: [
            if (widget.searchable)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                child: TextField(
                  key: const Key('locale-search'),
                  decoration: const InputDecoration(
                    hintText: 'Search language',
                    prefixIcon: Icon(Icons.search),
                  ),
                  onChanged: (v) => setState(() => _query = v),
                ),
              ),
            Expanded(
              child: widget.items.isEmpty
                  ? Center(
                      child: Text('No languages available.',
                          style: TextStyle(color: c.textSecondary)))
                  : ListView(children: rows),
            ),
          ]),
        ),
      ),
    );
  }
}
