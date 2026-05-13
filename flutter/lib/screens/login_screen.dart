import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../atomic/atomic_client.dart';
import '../atomic/session.dart';
import '../theme.dart';
import 'pair_screen.dart';

class LoginScreen extends StatefulWidget {
  final VoidCallback onLoggedIn;

  const LoginScreen({super.key, required this.onLoggedIn});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

enum _Step { loading, welcome, createAgent, showSecret, signIn, needsSync }

class _LoginScreenState extends State<LoginScreen> {
  _Step _step = _Step.loading;
  final _nameController = TextEditingController(text: '');
  final _secretController = TextEditingController();
  String? _error;
  bool _busy = false;

  // After setup
  String? _generatedSecret;

  @override
  void initState() {
    super.initState();
    _tryAutoLogin();
  }

  @override
  void dispose() {
    _nameController.dispose();
    _secretController.dispose();
    super.dispose();
  }

  /// Start Iroh peer and announce drive on DHT. Non-blocking.
  void _startNetworking(String driveSubject) {
    Future(() async {
      try {
        await AtomicClient.startPeer();
        await AtomicClient.peerAnnounce(driveSubject);
      } catch (e) {
        debugPrint('Networking start failed (offline?): $e');
      }
    });
  }

  Future<void> _tryAutoLogin() async {
    try {
      final session = await AtomicSession.load();
      if (session == null || session.secret.isEmpty) {
        setState(() => _step = _Step.welcome);
        return;
      }

      final agent = await AtomicClient.getActiveAgent();
      if (agent != null) {
        final drive = AtomicClient.getActiveDrive();
        if (drive != null) {
          _startNetworking(drive);
          widget.onLoggedIn();
          return;
        }
      }

      // Fallback: reload agent from session
      final result = await AtomicClient.loadAgent(session.secret);
      final drive = AtomicClient.getActiveDrive();
      if (result == 'needs_sync') {
        _startNetworking(drive ?? '');
        setState(() => _step = _Step.needsSync);
        return;
      }
      if (drive != null) {
        _startNetworking(drive);
        widget.onLoggedIn();
        return;
      }
    } catch (_) {}

    setState(() => _step = _Step.welcome);
  }

  // ── Step: Create Agent ──────────────────────────────────────────────

  Future<void> _doSetup() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Enter a name');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await AtomicClient.setup(name);
      await AtomicSession.save(
        serverUrl: '',
        secret: result.agentSecret,
        drive: result.driveSubject,
      );

      // Start networking in background (non-blocking)
      _startNetworking(result.driveSubject);

      setState(() {
        _generatedSecret = result.agentSecret;
        _step = _Step.showSecret;
        _busy = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _busy = false;
      });
    }
  }

  // ── Step: Sign In ───────────────────────────────────────────────────

  Future<void> _doSignIn() async {
    final secret = _secretController.text.trim();
    if (secret.isEmpty) {
      setState(() => _error = 'Paste your secret');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await AtomicClient.loadAgent(secret);
      await AtomicSession.save(serverUrl: '', secret: secret, drive: null);

      final drive = AtomicClient.getActiveDrive();
      if (drive != null) {
        await AtomicSession.saveDrive(drive);
      }

      if (result == 'needs_sync') {
        // Drive exists in secret but not locally — must pair first
        _startNetworking(drive ?? '');
        setState(() {
          _busy = false;
          _step = _Step.needsSync;
        });
      } else {
        _startNetworking(drive ?? '');
        widget.onLoggedIn();
      }
    } catch (e) {
      setState(() {
        _error = e.toString();
        _busy = false;
      });
    }
  }

  // ── Build ───────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    return Scaffold(
      backgroundColor: c.canvasBg,
      body: SafeArea(
          child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(32),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 200),
              child: _buildStep(c),
            ),
          ),
        ),
      )),
    );
  }

  Widget _buildStep(AppColors c) {
    switch (_step) {
      case _Step.loading:
        return const Center(
            key: ValueKey('loading'), child: CircularProgressIndicator());
      case _Step.welcome:
        return _buildWelcome(c);
      case _Step.createAgent:
        return _buildCreateAgent(c);
      case _Step.showSecret:
        return _buildShowSecret(c);
      case _Step.signIn:
        return _buildSignIn(c);
      case _Step.needsSync:
        return _buildNeedsSync(c);
    }
  }

  // ── Welcome ─────────────────────────────────────────────────────────

  Widget _buildWelcome(AppColors c) {
    return Column(
      key: const ValueKey('welcome'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.brush, size: 48, color: Colors.blue),
        const SizedBox(height: 16),
        const Text(
          'Atomic Canvas',
          style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          'Your data stays on this device.\nSync with others when you choose to.',
          style: TextStyle(fontSize: 14, color: c.iconDisabled),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 40),
        ElevatedButton(
          onPressed: () => setState(() {
            _step = _Step.createAgent;
            _error = null;
          }),
          style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: const Text('Get Started'),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: () => setState(() {
            _step = _Step.signIn;
            _error = null;
          }),
          style: OutlinedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: const Text('I have a secret — Sign In'),
        ),
      ],
    );
  }

  // ── Create Agent ────────────────────────────────────────────────────

  Widget _buildCreateAgent(AppColors c) {
    return Column(
      key: const ValueKey('create'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            IconButton(
              icon: const Icon(Icons.arrow_back),
              onPressed: () => setState(() {
                _step = _Step.welcome;
                _error = null;
              }),
            ),
            const Text('Create your identity',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          'This creates a cryptographic identity and a personal drive to store your data.',
          style: TextStyle(fontSize: 13, color: c.iconDisabled),
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _nameController,
          decoration: const InputDecoration(
            labelText: 'Your name',
            border: OutlineInputBorder(),
            isDense: true,
          ),
          autofocus: true,
          textInputAction: TextInputAction.go,
          onSubmitted: (_) => _doSetup(),
        ),
        const SizedBox(height: 16),
        ElevatedButton(
          onPressed: _busy ? null : _doSetup,
          style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Create'),
        ),
        _errorWidget(),
      ],
    );
  }

  // ── Show Secret ─────────────────────────────────────────────────────

  Widget _buildShowSecret(AppColors c) {
    return Column(
      key: const ValueKey('secret'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.check_circle, color: Colors.green, size: 48),
        const SizedBox(height: 16),
        const Text(
          'You\'re all set!',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: c.warningBg,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: c.warningBorder),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Save this secret — it\'s the only way to recover your account on another device.',
                style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
              ),
              const SizedBox(height: 12),
              SelectableText(
                _generatedSecret ?? '',
                style: const TextStyle(fontSize: 11, fontFamily: 'monospace'),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _generatedSecret!));
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Copied to clipboard')),
                  );
                },
                icon: const Icon(Icons.copy, size: 16),
                label: const Text('Copy secret'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        ElevatedButton(
          onPressed: () => widget.onLoggedIn(),
          style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: const Text('Continue to Canvas'),
        ),
      ],
    );
  }

  // ── Sign In ─────────────────────────────────────────────────────────

  Widget _buildSignIn(AppColors c) {
    return Column(
      key: const ValueKey('signin'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            IconButton(
              icon: const Icon(Icons.arrow_back),
              onPressed: () => setState(() {
                _step = _Step.welcome;
                _error = null;
              }),
            ),
            const Text('Sign in',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          'Paste your secret to restore your identity.',
          style: TextStyle(fontSize: 13, color: c.iconDisabled),
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _secretController,
          decoration: const InputDecoration(
            labelText: 'Your secret',
            border: OutlineInputBorder(),
            isDense: true,
          ),
          maxLines: 3,
          autofocus: true,
        ),
        const SizedBox(height: 16),
        ElevatedButton(
          onPressed: _busy ? null : _doSignIn,
          style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Sign In'),
        ),
        _errorWidget(),
      ],
    );
  }

  // ── Needs Sync ──────────────────────────────────────────────────────

  Widget _buildNeedsSync(AppColors c) {
    return Column(
      key: const ValueKey('needsSync'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.sync_problem, size: 48, color: Colors.orange),
        const SizedBox(height: 16),
        const Text(
          'Pair with your other device',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 12),
        Text(
          'Your drive was created on another device. '
          'Scan that device\'s QR code to sync your data.',
          style: TextStyle(fontSize: 14, color: c.iconDisabled),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        ElevatedButton.icon(
          icon: const Icon(Icons.qr_code_scanner),
          label: const Text('Pair with QR Code'),
          style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          onPressed: () async {
            await PairScreen.show(context);
            // Check if drive is now available
            final drive = AtomicClient.getActiveDrive();
            if (drive != null) {
              try {
                final name = await AtomicClient.getProperty(
                    drive, 'https://atomicdata.dev/properties/name');
                if (name.isNotEmpty) {
                  widget.onLoggedIn();
                  return;
                }
              } catch (_) {}
            }
            // Still no drive — stay on this screen
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                    content: Text('Drive not synced yet — try again')),
              );
            }
          },
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: () => setState(() {
            _step = _Step.welcome;
          }),
          child: const Text('Back'),
        ),
      ],
    );
  }

  Widget _errorWidget() {
    if (_error == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Theme.of(context).extension<AppColors>()?.errorBg ??
              Colors.red.shade50,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(_error!,
            style: const TextStyle(color: Colors.red, fontSize: 12)),
      ),
    );
  }
}
