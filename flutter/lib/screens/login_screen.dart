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
  final _serverController = TextEditingController();
  String? _error;
  bool _busy = false;

  // After setup
  String? _generatedSecret;
  bool _peerSyncAttempted = false;

  @override
  void initState() {
    super.initState();
    _tryAutoLogin();
  }

  @override
  void dispose() {
    _nameController.dispose();
    _secretController.dispose();
    _serverController.dispose();
    super.dispose();
  }

  String get _serverOrigin => _serverController.text.trim();

  /// Open WS sync to the server (primary path for multi-device).
  Future<void> _startNetworking(String driveSubject, {String? serverUrl}) async {
    final origin = (serverUrl != null && serverUrl.isNotEmpty)
        ? serverUrl
        : _serverOrigin;
    try {
      await AtomicClient.openWsSync(origin);
    } catch (e) {
      debugPrint('WS sync failed (offline?): $e');
    }
  }

  /// True when the active drive exists in the local DB (name property readable).
  Future<bool> _driveReady() async {
    final drive = AtomicClient.getActiveDrive();
    if (drive == null) return false;
    try {
      final name = await AtomicClient.getProperty(
          drive, 'https://atomicdata.dev/properties/name');
      return name.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  Future<void> _tryAutoLogin() async {
    try {
      final session = await AtomicSession.load();
      if (session == null || session.secret.isEmpty) {
        setState(() => _step = _Step.welcome);
        return;
      }
      if (session.serverUrl.isNotEmpty) {
        _serverController.text = session.serverUrl;
      }

      final status = await AtomicClient.resumeSession(
        serverUrl: session.serverUrl,
        secret: session.secret,
        drive: session.drive,
      );

      final drive = AtomicClient.getActiveDrive();
      if (drive != null) {
        await AtomicSession.saveDrive(drive);
      }

      if (status == 'ok' && await _driveReady()) {
        widget.onLoggedIn();
        return;
      }

      setState(() {
        _step = _Step.needsSync;
        _peerSyncAttempted = false;
      });
      return;
    } catch (e) {
      debugPrint('Auto-login failed: $e');
    }

    setState(() => _step = _Step.welcome);
  }

  /// Re-run boot sync: optional WS hub (if configured) + Iroh known peers / discover.
  Future<void> _retryPeerSync() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final session = await AtomicSession.load();
      if (session == null) {
        setState(() => _error = 'No saved session');
        return;
      }
      final status = await AtomicClient.resumeSession(
        serverUrl: session.serverUrl,
        secret: session.secret,
        drive: session.drive,
      );
      final drive = AtomicClient.getActiveDrive();
      if (drive != null) {
        await AtomicSession.saveDrive(drive);
      }
      if (status == 'ok' && await _driveReady()) {
        widget.onLoggedIn();
        return;
      }
      setState(() => _error = 'Drive not available on this device yet');
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
        serverUrl: _serverOrigin,
        secret: result.agentSecret,
        drive: result.driveSubject,
      );

      await _startNetworking(result.driveSubject, serverUrl: _serverOrigin);

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
      await AtomicSession.save(
        serverUrl: _serverOrigin,
        secret: secret,
        drive: null,
      );

      final status = await AtomicClient.resumeSession(
        serverUrl: _serverOrigin,
        secret: secret,
      );

      final drive = AtomicClient.getActiveDrive();
      if (drive != null) {
        await AtomicSession.saveDrive(drive);
      }

      if (status == 'ok' && await _driveReady()) {
        widget.onLoggedIn();
      } else {
        setState(() {
          _busy = false;
          _step = _Step.needsSync;
          _peerSyncAttempted = false;
        });
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
        _serverUrlField(),
        const SizedBox(height: 12),
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
        _serverUrlField(),
        const SizedBox(height: 12),
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
    if (!_peerSyncAttempted && !_busy) {
      _peerSyncAttempted = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _retryPeerSync());
    }
    return Column(
      key: const ValueKey('needsSync'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.sync_problem, size: 48, color: Colors.orange),
        const SizedBox(height: 16),
        const Text(
          'Sync your drive',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 12),
        Text(
          'This device does not have your drive yet. '
          'We look for other devices on the network, or you can pair with QR.',
          style: TextStyle(fontSize: 14, color: c.iconDisabled),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        ElevatedButton.icon(
          icon: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.sync),
          label: Text(_busy ? 'Syncing…' : 'Try again'),
          style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          onPressed: _busy ? null : _retryPeerSync,
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          icon: const Icon(Icons.qr_code_scanner),
          label: const Text('Pair with QR'),
          style: OutlinedButton.styleFrom(
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

  Widget _serverUrlField() {
    return TextField(
      controller: _serverController,
      decoration: const InputDecoration(
        labelText: 'Sync hub URL (optional)',
        hintText: 'Leave empty for device-to-device only',
        border: OutlineInputBorder(),
        isDense: true,
      ),
      keyboardType: TextInputType.url,
      autocorrect: false,
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
