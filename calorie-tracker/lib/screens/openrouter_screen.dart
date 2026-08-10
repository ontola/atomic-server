import 'package:flutter/material.dart';

import '../services/openrouter.dart';

/// Where the calorie estimates come from: the account that pays for them, and
/// which model does the looking.
///
/// Reached from Settings › AI. The connect step is deliberately not part of
/// onboarding (plan §7) — it is offered here and from the banner on a day with
/// meals waiting, by which point the user has seen what it is for.
class OpenRouterScreen extends StatefulWidget {
  const OpenRouterScreen({super.key, required this.account, this.client});

  final OpenRouterAccount account;

  /// Injected by tests, which have no network. The screen builds its own
  /// otherwise — a client is an account and an HTTP connection, so there is
  /// nothing to share by threading one down from `main`.
  final OpenRouterClient? client;

  static Future<void> open(
    BuildContext context, {
    required OpenRouterAccount account,
  }) {
    return Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => OpenRouterScreen(account: account),
    ));
  }

  @override
  State<OpenRouterScreen> createState() => _OpenRouterScreenState();
}

class _OpenRouterScreenState extends State<OpenRouterScreen> {
  late final OpenRouterClient _client =
      widget.client ?? OpenRouterClient(account: widget.account);

  List<OpenRouterModel>? _models;
  String? _modelsError;
  String _filter = '';

  @override
  void initState() {
    super.initState();
    _loadModels();
  }

  /// The catalogue is public, so this runs whether or not anyone is signed in —
  /// which is the order this screen is used in: look at what it would cost,
  /// then decide to connect.
  Future<void> _loadModels() async {
    setState(() => _modelsError = null);
    try {
      final models = await _client.visionModels();
      if (!mounted) return;
      setState(() => _models = models);
    } catch (e) {
      if (!mounted) return;
      setState(() => _modelsError = e.toString());
    }
  }

  Future<void> _connect() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.account.connect();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _disconnect() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Disconnect OpenRouter?'),
        content: const Text(
          'This device forgets the key. Meals already estimated keep their '
          'numbers; new ones wait until you connect again.\n\n'
          'The key itself stays valid — only openrouter.ai can revoke it.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Disconnect'),
          ),
        ],
      ),
    );
    if (confirmed == true) await widget.account.disconnect();
  }

  /// The chosen model always shows, however the search box is set: a picker
  /// that can hide what is currently selected is one you cannot read the state
  /// of.
  List<OpenRouterModel> get _visible {
    final models = _models ?? const <OpenRouterModel>[];
    final needle = _filter.trim().toLowerCase();
    if (needle.isEmpty) return models;
    return models
        .where((m) =>
            m.id == widget.account.model ||
            m.id.toLowerCase().contains(needle) ||
            m.name.toLowerCase().contains(needle))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Estimates')),
      body: AnimatedBuilder(
        animation: widget.account,
        builder: (context, _) {
          final models = _visible;

          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
            children: [
              _ConnectionCard(
                account: widget.account,
                onConnect: _connect,
                onUseKey: widget.account.useKey,
                onDisconnect: _disconnect,
              ),
              const SizedBox(height: 24),
              Text('Model', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 4),
              Text(
                'Every model here can look at a photo. The price is what one '
                'meal costs, roughly.',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.outline,
                    ),
              ),
              const SizedBox(height: 12),
              if (_models != null)
                TextField(
                  onChanged: (value) => setState(() => _filter = value),
                  decoration: const InputDecoration(
                    prefixIcon: Icon(Icons.search, size: 20),
                    hintText: 'Search models',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                ),
              const SizedBox(height: 8),
              if (_modelsError != null)
                _ModelsUnavailable(
                  message: _modelsError!,
                  current: widget.account.model,
                  onRetry: _loadModels,
                )
              else if (_models == null)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: Center(child: CircularProgressIndicator()),
                )
              else
                for (final model in models)
                  _ModelTile(
                    model: model,
                    selected: model.id == widget.account.model,
                    isDefault: model.id == OpenRouterAccount.defaultModel,
                    onSelected: () => widget.account.setModel(model.id),
                  ),
            ],
          );
        },
      ),
    );
  }
}

/// Connected or not, and the two ways to change it.
class _ConnectionCard extends StatefulWidget {
  const _ConnectionCard({
    required this.account,
    required this.onConnect,
    required this.onUseKey,
    required this.onDisconnect,
  });

  final OpenRouterAccount account;
  final VoidCallback onConnect;

  /// Throws an [OpenRouterException] worth showing when the key is not one.
  final Future<void> Function(String key) onUseKey;

  final VoidCallback onDisconnect;

  @override
  State<_ConnectionCard> createState() => _ConnectionCardState();
}

class _ConnectionCardState extends State<_ConnectionCard> {
  final _keyField = TextEditingController();

  bool _pasting = false;
  bool _showKey = false;
  String? _keyError;

  @override
  void dispose() {
    _keyField.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _keyError = null);
    try {
      await widget.onUseKey(_keyField.text);
      if (!mounted) return;
      setState(() {
        _pasting = false;
        _showKey = false;
        _keyField.clear();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _keyError = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final account = widget.account;
    final connected = account.isConnected;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  connected ? Icons.check_circle : Icons.link_off,
                  size: 20,
                  color: connected
                      ? theme.colorScheme.primary
                      : theme.colorScheme.outline,
                ),
                const SizedBox(width: 8),
                Text(
                  connected ? 'Connected to OpenRouter' : 'Not connected',
                  style: theme.textTheme.titleSmall,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              connected
                  ? 'Photos are sent to the model below, and you are billed by '
                      'OpenRouter for each one — a few cents a month at five '
                      'meals a day.'
                  : 'Meals are logged and kept either way. Without a key they '
                      'wait, unestimated, until there is one.',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
            if (account.usingBuildKey) ...[
              const SizedBox(height: 8),
              Text(
                'Using the key this build was compiled with '
                '(OPENROUTER_API_KEY). Sign in to use your own.',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.tertiary),
              ),
            ],
            const SizedBox(height: 12),
            if (account.connecting)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(8),
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            else if (connected && !account.usingBuildKey)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: widget.onDisconnect,
                  style: TextButton.styleFrom(
                    foregroundColor: theme.colorScheme.error,
                  ),
                  child: const Text('Disconnect'),
                ),
              )
            else ...[
              FilledButton.icon(
                onPressed: widget.onConnect,
                icon: const Icon(Icons.open_in_new, size: 18),
                label: const Text('Connect OpenRouter'),
              ),
              if (_pasting)
                _KeyField(
                  controller: _keyField,
                  error: _keyError,
                  obscured: !_showKey,
                  onToggleVisible: () => setState(() => _showKey = !_showKey),
                  onSave: _save,
                  onCancel: () => setState(() {
                    _pasting = false;
                    _showKey = false;
                    _keyError = null;
                    _keyField.clear();
                  }),
                )
              else
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: () => setState(() => _pasting = true),
                    child: const Text('Paste a key instead'),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

/// For a key made by hand on openrouter.ai/keys.
///
/// Obscured by default because it is a credential on a screen someone may well
/// be showing to somebody, and revealable because a key you cannot read is one
/// you cannot check you pasted whole.
class _KeyField extends StatelessWidget {
  const _KeyField({
    required this.controller,
    required this.error,
    required this.obscured,
    required this.onToggleVisible,
    required this.onSave,
    required this.onCancel,
  });

  final TextEditingController controller;
  final String? error;
  final bool obscured;
  final VoidCallback onToggleVisible;
  final Future<void> Function() onSave;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 16),
        TextField(
          controller: controller,
          obscureText: obscured,
          autofocus: true,
          autocorrect: false,
          enableSuggestions: false,
          onSubmitted: (_) => onSave(),
          decoration: InputDecoration(
            labelText: 'API key',
            hintText: 'sk-or-...',
            errorText: error,
            errorMaxLines: 3,
            isDense: true,
            border: const OutlineInputBorder(),
            suffixIcon: IconButton(
              tooltip: obscured ? 'Show' : 'Hide',
              icon: Icon(
                obscured ? Icons.visibility_off : Icons.visibility,
                size: 20,
              ),
              onPressed: onToggleVisible,
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          'Made at openrouter.ai/keys. It is kept on this device only, in the '
          'same place as your account secret.',
          style: theme.textTheme.bodySmall
              ?.copyWith(color: theme.colorScheme.outline),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            // Expanded because the theme's filled buttons are full-width, and
            // a full-width button inside a Row is an infinite one.
            Expanded(
              child: FilledButton.tonal(
                onPressed: onSave,
                child: const Text('Save key'),
              ),
            ),
            const SizedBox(width: 8),
            TextButton(onPressed: onCancel, child: const Text('Cancel')),
          ],
        ),
      ],
    );
  }
}

class _ModelTile extends StatelessWidget {
  const _ModelTile({
    required this.model,
    required this.selected,
    required this.isDefault,
    required this.onSelected,
  });

  final OpenRouterModel model;
  final bool selected;
  final bool isDefault;
  final VoidCallback onSelected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return ListTile(
      onTap: onSelected,
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
        color: selected ? theme.colorScheme.primary : theme.colorScheme.outline,
      ),
      title: Text(model.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Row(
        children: [
          Flexible(
            child: Text(
              model.id,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
          ),
          const SizedBox(width: 8),
          Text(formatMealPrice(model.dollarsPerMeal),
              style: theme.textTheme.labelSmall),
          if (isDefault) ...[
            const SizedBox(width: 8),
            Text('default',
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: theme.colorScheme.primary)),
          ],
          if (!model.followsSchemas) ...[
            const SizedBox(width: 8),
            // Not disqualifying — most of these still answer in the JSON they
            // were asked for — but it is why one of them might keep failing.
            Text('no schema',
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: theme.colorScheme.tertiary)),
          ],
        ],
      ),
    );
  }
}

/// The catalogue did not load. The model in use still works — it is a string
/// sent with each call, not something looked up — so this is a browsing problem,
/// not a broken app.
class _ModelsUnavailable extends StatelessWidget {
  const _ModelsUnavailable({
    required this.message,
    required this.current,
    required this.onRetry,
  });

  final String message;
  final String current;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Column(
        children: [
          Text(
            'Could not list the models.\nStill estimating with $current.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 6),
          Text(
            message,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
        ],
      ),
    );
  }
}

/// `0.03¢` — the numbers here are small enough that dollars are all zeroes.
String formatMealPrice(double dollars) {
  if (dollars <= 0) return 'free';
  final cents = dollars * 100;
  if (cents < 1) return '${cents.toStringAsFixed(2)}¢ / meal';
  if (cents < 10) return '${cents.toStringAsFixed(1)}¢ / meal';
  return '${cents.round()}¢ / meal';
}
