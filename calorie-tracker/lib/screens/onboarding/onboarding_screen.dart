import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../services/app_session.dart';

/// First launch, and nothing else.
///
/// One decision: this is a new account, or it is one that already exists on
/// another device. The new-account path asks for nothing at all — the plan puts
/// the camera one tap from a fresh install (`calorie-tracker-plan.md` §6), and
/// a name field before the first photo is a form standing in front of a camera.
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, required this.session});

  final AppSession session;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final _secretController = TextEditingController();

  bool _importing = false;

  /// A secret is a password. Hidden by default, revealable so someone can check
  /// what they pasted.
  bool _obscureSecret = true;

  @override
  void dispose() {
    _secretController.dispose();
    super.dispose();
  }

  Future<void> _pasteAndImport() async {
    final clipboard = await Clipboard.getData(Clipboard.kTextPlain);
    final pasted = clipboard?.text?.trim() ?? '';
    if (pasted.isNotEmpty) _secretController.text = pasted;

    await widget.session.importAccount(_secretController.text);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: AnimatedSize(
                duration: const Duration(milliseconds: 180),
                alignment: Alignment.topCenter,
                child: _importing ? _buildImport(context) : _buildWelcome(context),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildWelcome(BuildContext context) {
    final theme = Theme.of(context);
    final session = widget.session;

    return Column(
      key: const ValueKey('welcome'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(Icons.photo_camera_outlined,
            size: 64, color: theme.colorScheme.primary),
        const SizedBox(height: 20),
        Text(
          'Calorie Tracker',
          textAlign: TextAlign.center,
          style: theme.textTheme.headlineSmall,
        ),
        const SizedBox(height: 10),
        Text(
          'Snap a photo of a meal, get a calorie estimate.\n'
          'Everything is stored on this phone.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium
              ?.copyWith(color: theme.colorScheme.outline),
        ),
        const SizedBox(height: 36),
        FilledButton(
          onPressed: session.busy ? null : session.createAccount,
          child: session.busy
              ? const _ButtonSpinner()
              : const Text('Start tracking'),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: session.busy
              ? null
              : () => setState(() => _importing = true),
          child: const Text('I already have an account'),
        ),
        _ErrorText(session.error),
      ],
    );
  }

  Widget _buildImport(BuildContext context) {
    final theme = Theme.of(context);
    final session = widget.session;

    return Column(
      key: const ValueKey('import'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: session.busy
                ? null
                : () => setState(() => _importing = false),
            icon: const Icon(Icons.arrow_back, size: 18),
            label: const Text('Back'),
          ),
        ),
        const SizedBox(height: 4),
        Text('Restore your account', style: theme.textTheme.titleLarge),
        const SizedBox(height: 8),
        Text(
          'Paste the secret from your other device. It is the account — there '
          'is no password to reset.',
          style: theme.textTheme.bodyMedium
              ?.copyWith(color: theme.colorScheme.outline),
        ),
        const SizedBox(height: 20),
        TextField(
          controller: _secretController,
          obscureText: _obscureSecret,
          autofocus: true,
          // A secret is one line, typed or pasted — Enter submits it.
          onSubmitted: (value) =>
              session.busy ? null : session.importAccount(value),
          decoration: InputDecoration(
            labelText: 'Your secret',
            border: const OutlineInputBorder(),
            isDense: true,
            suffixIcon: IconButton(
              icon: Icon(
                _obscureSecret ? Icons.visibility : Icons.visibility_off,
                size: 20,
              ),
              tooltip: _obscureSecret ? 'Show' : 'Hide',
              onPressed: () =>
                  setState(() => _obscureSecret = !_obscureSecret),
            ),
          ),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: session.busy
              ? null
              : () => session.importAccount(_secretController.text),
          child: session.busy ? const _ButtonSpinner() : const Text('Restore'),
        ),
        const SizedBox(height: 8),
        // The secret almost always arrives on the other device's clipboard, so
        // pasting is the whole action rather than a step before it.
        OutlinedButton.icon(
          onPressed: session.busy ? null : _pasteAndImport,
          icon: const Icon(Icons.content_paste, size: 18),
          label: const Text('Paste and restore'),
        ),
        _ErrorText(session.error),
      ],
    );
  }
}

class _ButtonSpinner extends StatelessWidget {
  const _ButtonSpinner();

  @override
  Widget build(BuildContext context) => const SizedBox(
        height: 20,
        width: 20,
        child: CircularProgressIndicator(strokeWidth: 2),
      );
}

/// Whatever went wrong, verbatim. These messages come from the store or the
/// bridge and are the only clue a user (or a bug report) gets.
class _ErrorText extends StatelessWidget {
  const _ErrorText(this.message);

  final String? message;

  @override
  Widget build(BuildContext context) {
    if (message == null) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: 20),
      child: SelectableText(
        message!,
        textAlign: TextAlign.center,
        style: TextStyle(color: Theme.of(context).colorScheme.error),
      ),
    );
  }
}
