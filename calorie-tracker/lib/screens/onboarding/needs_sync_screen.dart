import 'package:flutter/material.dart';

import '../../services/app_session.dart';
import '../pair_screen.dart';

/// The secret was good; the data it points at is somewhere else.
///
/// A secret says who you are, never what you have — restore one on a new phone
/// and the account is back while the drive holding the meals is still on the
/// old one. Nothing can be written until it arrives, so this screen exists to
/// go and get it rather than to report a failure.
class NeedsSyncScreen extends StatefulWidget {
  const NeedsSyncScreen({super.key, required this.session});

  final AppSession session;

  @override
  State<NeedsSyncScreen> createState() => _NeedsSyncScreenState();
}

class _NeedsSyncScreenState extends State<NeedsSyncScreen> {
  String? _lastAttempt;

  /// Look on arrival: the usual case is the other device sitting on the same
  /// Wi-Fi, and finding it takes no input from anybody.
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _sync());
  }

  Future<void> _sync() async {
    final message = await widget.session.retrySync();
    if (!mounted) return;
    setState(() => _lastAttempt = message.isEmpty ? null : message);
  }

  Future<void> _pair() async {
    await PairScreen.show(context);
    if (!mounted) return;
    await _sync();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final busy = widget.session.busy;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.sync,
                      size: 56, color: theme.colorScheme.secondary),
                  const SizedBox(height: 20),
                  Text(
                    'Getting your meals',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 10),
                  Text(
                    'Your account is restored. The meals live on the device you '
                    'came from — keep it open and on the same Wi-Fi.',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const SizedBox(height: 28),
                  FilledButton.icon(
                    onPressed: busy ? null : _sync,
                    icon: busy
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh),
                    label: Text(busy ? 'Looking…' : 'Try again'),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: busy ? null : _pair,
                    icon: const Icon(Icons.qr_code_scanner, size: 18),
                    label: const Text('Scan the other device'),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: busy ? null : widget.session.signOut,
                    child: const Text('Use a different account'),
                  ),
                  if (_lastAttempt != null) ...[
                    const SizedBox(height: 20),
                    SelectableText(
                      _lastAttempt!,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: theme.colorScheme.outline),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
