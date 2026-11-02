import 'package:atomic_flutter/atomic_flutter.dart'
    show Perf, normalizeServerUrl;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:atomic_chat/atomic_chat.dart'
    show AtomicWordmark, WelcomeDrive, WelcomeDriveBuilder;
import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:url_launcher/url_launcher.dart';
import '../assistant/atomic_assistant_api.dart';
import '../atomic/account_store.dart';
import '../atomic/atomic_client.dart';
import '../atomic/get_started.dart';
import '../atomic/session.dart';
import '../atomic/switch_account.dart';
import '../theme.dart';
import 'account_link_dialog.dart';
import 'needs_sync_view.dart';
import 'pair_screen.dart';
import '../atomic/sync_failure.dart';

class LoginScreen extends StatefulWidget {
  final VoidCallback onLoggedIn;

  /// "Get started" made a new identity: the app opens in [NewIdentity.drive]
  /// and, when the Welcome drive was made, on its Welcome document. Called
  /// just before [onLoggedIn].
  final ValueChanged<NewIdentity>? onStarted;

  /// Test seam: makes the Welcome drive of a new identity (by default the
  /// web's own, run by the embedded page).
  @visibleForTesting
  final Future<WelcomeDrive> Function(String personalDrive)? buildWelcome;

  /// Test seam: the whole of "Get started" (identity, drives, session).
  @visibleForTesting
  final Future<NewIdentity> Function()? startIdentity;

  /// Signs in with the person's atomic.place account and returns the identity
  /// its backup holds; null when cancelled. Replaceable in tests.
  final Future<shared.AtomicRecoveredIdentity?> Function(BuildContext context)?
      accountSignIn;

  /// The account client for the default sign-in, and how it opens a page in
  /// the system browser. Replaceable in tests.
  final shared.AtomicAccountClient Function()? accountClient;
  final Future<void> Function(Uri url)? openBrowser;

  /// Shown while already signed in, from the settings: the same ways to sign
  /// in, without making a new account, and the work of the account signed in
  /// now comes along. Pops with the number of drives that came along, or with
  /// nothing when the person left or signed in as the same account.
  final bool switchAccount;

  /// Test seams: how a switch brings work along, and how the new sign-in is
  /// started (its result is whether the drive is ready).
  @visibleForTesting
  final Future<AccountSwitch> Function(String secret)? switchAccountFn;
  @visibleForTesting
  final Future<bool> Function(String serverUrl, String secret, String? drive)?
      activate;

  const LoginScreen(
      {super.key,
      required this.onLoggedIn,
      this.onStarted,
      this.buildWelcome,
      this.startIdentity,
      this.accountSignIn,
      this.accountClient,
      this.openBrowser,
      this.switchAccount = false,
      this.switchAccountFn,
      this.activate});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

enum _Step {
  loading,
  welcome,

  /// "Sign in": the ways to sign in, one tap each.
  signInOptions,

  /// Signing in with a pasted secret.
  signIn,

  /// "Get started" is making the identity and its drives.
  starting,
  needsSync,
}

class _LoginScreenState extends State<LoginScreen> {
  _Step _step = _Step.loading;
  final _secretController = TextEditingController();
  final _accountNameController = TextEditingController(text: 'atomic.place');
  // A secret is hidden by default — it is a password. A reveal toggle lets
  // someone check a value they typed or pasted.
  bool _obscureSecret = true;
  final _serverController = TextEditingController();
  String? _error;
  bool _busy = false;

  bool _peerSyncAttempted = false;

  /// What the sync step is doing right now, while it is busy.
  String? _status;

  /// What the server lookup did, for the error text.
  String _lookup = '';

  @override
  void initState() {
    super.initState();
    if (widget.switchAccount) {
      _step = _Step.signInOptions;
    } else {
      _tryAutoLogin();
    }
  }

  /// Signed in: tell the app, and when this screen was opened to switch, go
  /// back to where it came from with what came along.
  void _done() {
    widget.onLoggedIn();
    if (widget.switchAccount && mounted) {
      Navigator.of(context).pop(_broughtAlong);
    }
  }

  /// Where "back" leaves to: the welcome, or while switching accounts (which
  /// makes no new identity) the ways to sign in.
  _Step get _home => widget.switchAccount ? _Step.signInOptions : _Step.welcome;

  /// Names of the drives that came along.
  List<String> _broughtAlong = const [];

  @override
  void dispose() {
    _secretController.dispose();
    _accountNameController.dispose();
    _serverController.dispose();
    super.dispose();
  }

  /// Normalized, so `localhost:9883` works as typed — the same rule the
  /// server settings use. Empty stays empty: no hub is a valid choice.
  String get _serverOrigin => normalizeServerUrl(_serverController.text);

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
      final session = await AtomicSession.loadEarly();
      Perf.once('session loaded');
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
        _done();
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
  /// Look for the workspace on the other devices — the slow part sign-in used
  /// to block on. It runs here instead, on a screen built to wait: Iroh
  /// discovery (pkarr + known peers) that can take tens of seconds, or land the
  /// moment a paired device answers.
  Future<void> _retryPeerSync() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // A drive that is not here yet may live on a server that announced it in
      // pkarr: one HTTPS round trip, so it goes before the device search.
      final wanted = AtomicClient.getActiveDrive();
      if (wanted != null && !await _driveReady()) {
        setState(() => _status = 'Looking for the server your drive lives on…');
        String? found;
        try {
          found = await AtomicClient.discoverHomeServer(wanted);
        } catch (e) {
          debugPrint('Home server lookup failed: $e');
        }
        // Said on screen if the devices fail to help either: it is the answer
        // to "why is nothing here".
        _lookup = AtomicClient.discoveryLog.join('\n');
        if (found != null) {
          // Remember where it lives, so the next start reconnects there.
          await AtomicSession.setActiveServer(found);
          await AtomicSession.saveDrive(wanted);
          if (await _driveReady()) {
            _done();
            return;
          }
        }
      }
      if (mounted) setState(() => _status = 'Looking for your devices…');
      final report = await AtomicClient.syncConnectivityNow();

      final drive = AtomicClient.getActiveDrive();
      if (drive != null) {
        await AtomicSession.saveDrive(drive);
      }

      if (drive != null && await _driveReady()) {
        _done();

        return;
      }

      setState(() => _error = [
            if (_lookup.isNotEmpty) _lookup,
            report.imported > 0 || report.livePeers > 0
                ? 'Synced, but your workspace isn’t here yet — try again'
                : report.message,
          ].join('\n'));
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _status = null;
        });
      }
    }
  }

  // ── Get started ─────────────────────────────────────────────────────

  /// A new identity on this device, its personal drive and the Welcome drive,
  /// then straight into the app. No form and no secret to read first: the
  /// secret is kept on the device, and Sync → Copy secret key gives it for
  /// another device.
  Future<void> _getStarted() async {
    setState(() {
      _busy = true;
      _error = null;
      _step = _Step.starting;
    });
    try {
      final made = await (widget.startIdentity ?? _startIdentity)();
      if (!made.secretStored && mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(
            content: Text('Couldn\u2019t save your sign-in on this device; '
                'you\u2019ll need to sign in again next time'),
          ),
        );
      }
      widget.onStarted?.call(made);
      _done();
    } catch (e) {
      debugPrint('Get started: $e');
      if (mounted) {
        setState(() {
          _error = signInError(e);
          _busy = false;
          _step = _Step.welcome;
        });
      }
    }
  }

  Future<NewIdentity> _startIdentity() => startNewIdentity(
        buildWelcome: widget.buildWelcome ??
            (personal) => WelcomeDriveBuilder(
                  api: const AtomicAssistantApi(),
                  timeout: const Duration(seconds: 45),
                ).build(personal),
      );

  // ── Step: Sign In ───────────────────────────────────────────────────

  /// Paste the clipboard into the field and sign in, in one tap — the secret
  /// almost always comes from another device's clipboard, so pasting is the
  /// action, not a step before it.
  Future<void> _pasteSecretAndSignIn() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final pasted = data?.text?.trim() ?? '';

    if (pasted.isEmpty) {
      setState(() => _error = 'Nothing to paste');

      return;
    }

    _secretController.text = pasted;
    await _doSignIn();
  }

  Future<void> _doSignIn() async {
    final secret = _secretController.text.trim();
    if (secret.isEmpty) {
      setState(() => _error = 'Paste your secret');
      return;
    }
    await _signInWithSecret(secret);
  }

  /// "Sign in with atomic.place": the account sign-in (a code approved on a
  /// device or in the browser), then the identity its backup holds, which
  /// signs the app in exactly like a pasted secret.
  Future<void> _signInWithAccount() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    shared.AtomicRecoveredIdentity? identity;
    try {
      identity = await (widget.accountSignIn ?? _defaultAccountSignIn)(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = '$e'.replaceFirst('Bad state: ', '');
          // The account is linked but its secret can't be recovered here:
          // the paste field is the way on.
          if (e is shared.AtomicNoAssistedRecovery) _step = _Step.signIn;
        });
      }
      return;
    }
    if (identity == null) {
      if (mounted) setState(() => _busy = false);
      return;
    }
    await _signInWithSecret(identity.secret, drive: identity.drive);
  }

  Future<shared.AtomicRecoveredIdentity?> _defaultAccountSignIn(
      BuildContext context) async {
    final client = widget.accountClient?.call() ??
        shared.AtomicAccountClient(AccountStore.defaultPortal);
    try {
      final linked = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (_) => AccountLinkDialog(
          client: client,
          deviceName: 'atomic.place',
          save: AccountStore.save,
          // The browser unlocks the backup, which it can for passkey and
          // recovery-code backups too, and sends the secret back sealed.
          handback: true,
          openInBrowser: widget.openBrowser ??
              (url) async {
                await launchUrl(url, mode: LaunchMode.externalApplication);
              },
        ),
      );
      if (linked != true) return null;
      try {
        // An older portal approves without a sealed identity: fall back to
        // the server-assisted backup.
        return client.takeHandedBackIdentity() ??
            await client.recoverIdentity();
      } catch (_) {
        // Without the identity the account session is of no use here, and
        // keeping it made a failed sign-in look half done.
        await AccountStore.clear();
        rethrow;
      }
    } finally {
      client.close();
    }
  }

  /// Starts the session of [secret]; whether its drive is on this device.
  Future<bool> _activate(String serverUrl, String secret, String? drive) async {
    final status = await AtomicClient.resumeSession(
      serverUrl: serverUrl,
      secret: secret,
      drive: drive,
    );
    final activeDrive = AtomicClient.getActiveDrive();
    if (activeDrive != null) {
      await AtomicSession.saveDrive(activeDrive);
    }
    return status == 'ok' && await _driveReady();
  }

  Future<void> _signInWithSecret(String secret, {String? drive}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (widget.switchAccount) {
        final switched =
            await (widget.switchAccountFn ?? switchAccountOnDevice)(secret);
        if (switched.same) {
          if (mounted) Navigator.of(context).pop();
          return;
        }
        // Before anything else changes: the old secret is never dropped.
        final previous = switched.previousSecret;
        if (previous != null) {
          await AtomicSession.archivePreviousSecret(previous);
        }
        _broughtAlong = switched.broughtAlong;
      }
      final stored = await AtomicSession.save(
        serverUrl: _serverOrigin,
        secret: secret,
        drive: drive,
      );
      if (!stored && mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(
            content: Text('Couldn\u2019t save your sign-in on this device; '
                'you\u2019ll need to sign in again next time'),
          ),
        );
      }

      final ready =
          await (widget.activate ?? _activate)(_serverOrigin, secret, drive);

      // The secret was accepted: let the password manager offer to save it.
      TextInput.finishAutofillContext();

      if (ready) {
        _done();
      } else {
        setState(() {
          _busy = false;
          _step = _Step.needsSync;
          _peerSyncAttempted = false;
        });
      }
    } catch (e) {
      debugPrint('Sign in: $e');
      setState(() {
        _error = signInError(e);
        _busy = false;
      });
    }
  }

  // ── Build ───────────────────────────────────────────────────────────

  /// The steps the system back leaves for the welcome screen, as their own
  /// back arrows do; elsewhere back leaves the app.
  static const _backToWelcome = {
    _Step.signInOptions,
    _Step.signIn,
    _Step.starting,
    _Step.needsSync,
  };

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    return PopScope(
      canPop: !_backToWelcome.contains(_step) ||
          (widget.switchAccount && _step == _Step.signInOptions),
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || _busy) return;
        setState(() {
          // The secret field goes back to the ways to sign in.
          _step = _step == _Step.signIn ? _Step.signInOptions : _home;
          _error = null;
        });
      },
      child: _scaffold(c),
    );
  }

  Widget _scaffold(AppColors c) {
    if (_step == _Step.needsSync) return _buildNeedsSync(c);
    return Scaffold(
      backgroundColor: c.pageBg,
      appBar: widget.switchAccount
          ? AppBar(
              backgroundColor: c.pageBg,
              title: const Text('Sign in to another account'))
          : null,
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
      case _Step.signInOptions:
        return _buildSignInOptions(c);
      case _Step.starting:
        return _buildStarting(c);
      case _Step.signIn:
        return _buildSignIn(c);
      case _Step.needsSync:
        return _buildNeedsSync(c);
    }
  }

  // ── Welcome ─────────────────────────────────────────────────────────

  /// The same two choices as the web: Get started, and Sign in.
  Widget _buildWelcome(AppColors c) {
    return Column(
      key: const ValueKey('welcome'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Center(
          child: AtomicWordmark(height: 40, alignment: Alignment.center),
        ),
        const SizedBox(height: 24),
        Text(
          'Your data stays on this device.\nSync with others when you choose to.',
          style: TextStyle(fontSize: 14, color: c.iconDisabled),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 40),
        ElevatedButton(
          key: const ValueKey('get-started'),
          onPressed: _busy ? null : _getStarted,
          style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: const Text('Get started'),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          key: const ValueKey('sign-in'),
          onPressed: _busy
              ? null
              : () => setState(() {
                    _step = _Step.signInOptions;
                    _error = null;
                  }),
          style: OutlinedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: const Text('Sign in'),
        ),
        _errorWidget(),
      ],
    );
  }

  // ── Starting ────────────────────────────────────────────────────────

  Widget _buildStarting(AppColors c) {
    return Column(
      key: const ValueKey('starting'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        const CircularProgressIndicator(),
        const SizedBox(height: 24),
        const Text('Setting up your workspace\u2026',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        Text(
          'Making your identity and a drive to look around in.',
          style: TextStyle(fontSize: 13, color: c.iconDisabled),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }

  // ── Sign in options ─────────────────────────────────────────────────

  /// The ways to sign in, grouped under Sign in: the atomic.place account, or
  /// a secret from another device.
  Widget _buildSignInOptions(AppColors c) {
    return Column(
      key: const ValueKey('signin-options'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            if (!widget.switchAccount)
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
        const SizedBox(height: 24),
        ElevatedButton(
          key: const ValueKey('sign-in-with-account'),
          onPressed: _busy ? null : _signInWithAccount,
          style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: const Text('Sign in with atomic.place'),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          key: const ValueKey('sign-in-with-secret'),
          onPressed: _busy
              ? null
              : () => setState(() {
                    _step = _Step.signIn;
                    _error = null;
                  }),
          style: OutlinedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14)),
          child: const Text('Sign in with a secret'),
        ),
        _errorWidget(),
      ],
    );
  }

  // ── Sign In ─────────────────────────────────────────────────────────

  Widget _buildSignIn(AppColors c) {
    return AutofillGroup(
        key: const ValueKey('signin'),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                IconButton(
                  icon: const Icon(Icons.arrow_back),
                  onPressed: () => setState(() {
                    _step = _Step.signInOptions;
                    _error = null;
                  }),
                ),
                const Text('Your secret',
                    style:
                        TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Paste your secret to restore your identity.',
              style: TextStyle(fontSize: 13, color: c.iconDisabled),
            ),
            const SizedBox(height: 24),
            // Signing in restores who you are. Where your data is, is the next
            // screen's question — and only if it turns out not to be here, which
            // is the moment it can be asked with something to point at (`needsSync`
            // offers pairing). Asking up front asks everyone, before anyone has the
            // problem, and asks it as an address when the answer is usually a
            // device you can just scan.
            // Password managers pair a credential with an account name: a fixed,
            // hidden one, so the secret is saved and offered as "atomic.place"
            // without showing a field nobody fills in.
            Offstage(
              child: TextField(
                key: const ValueKey('signin-username'),
                controller: _accountNameController,
                readOnly: true,
                autofillHints: const [AutofillHints.username],
              ),
            ),
            TextField(
              key: const ValueKey('signin-secret'),
              controller: _secretController,
              obscureText: _obscureSecret,
              autofillHints: const [AutofillHints.password],
              enableSuggestions: false,
              autocorrect: false,
              keyboardType: TextInputType.visiblePassword,
              autofocus: true,
              // Enter submits — a secret is one line, pasted or not.
              onSubmitted: (_) => _busy ? null : _doSignIn(),
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
            Row(
              children: [
                Expanded(
                  child: ElevatedButton(
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
                ),
                const SizedBox(width: 8),
                // Paste-and-go: the secret lives on another device's clipboard,
                // so one tap pastes it and signs in.
                OutlinedButton.icon(
                  onPressed: _busy ? null : _pasteSecretAndSignIn,
                  icon: const Icon(Icons.content_paste, size: 18),
                  label: const Text('Paste'),
                  style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(
                          vertical: 14, horizontal: 12)),
                ),
              ],
            ),
            _errorWidget(),
          ],
        ));
  }

  // ── Needs Sync ──────────────────────────────────────────────────────

  Widget _buildNeedsSync(AppColors c) {
    if (!_peerSyncAttempted && !_busy) {
      _peerSyncAttempted = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _retryPeerSync());
    }
    return NeedsSyncView(
      searching: _busy,
      status: _status,
      failure: _error == null ? null : SyncFailure.parse(_error!),
      onRetry: _retryPeerSync,
      onPair: () => _pairThenCheck(null),
      onPaste: _pasteNodeId,
      onBack: () => setState(() {
        _step = _home;
        _error = null;
      }),
    );
  }

  /// Pair with [nodeId] (or scan a code when null), then continue when the
  /// drive arrived.
  Future<void> _pairThenCheck(String? nodeId) async {
    await PairScreen.show(context, nodeId: nodeId);
    final drive = AtomicClient.getActiveDrive();
    if (drive != null) {
      try {
        final name = await AtomicClient.getProperty(
            drive, 'https://atomicdata.dev/properties/name');
        if (name.isNotEmpty) {
          _done();
          return;
        }
      } catch (_) {}
    }
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Drive not synced yet — try again')),
      );
    }
  }

  /// For when no camera can see the other device's code: its node ID, copied
  /// from its Sync page, pasted here. Prefilled from the clipboard.
  Future<void> _pasteNodeId() async {
    final clip = (await Clipboard.getData(Clipboard.kTextPlain))?.text ?? '';
    if (!mounted) return;
    final controller = TextEditingController(
        text: PairScreen.parsePeerInfo(clip) != null ? clip.trim() : '');
    final nodeId = await showDialog<String>(
      context: context,
      builder: (context) {
        String? error;
        return StatefulBuilder(
          builder: (context, setDialogState) {
            void submit() {
              final info = PairScreen.parsePeerInfo(controller.text);
              if (info == null) {
                setDialogState(() => error = 'Not a node ID');
                return;
              }
              Navigator.of(context).pop(info.nodeId);
            }

            return AlertDialog(
              title: const Text('Paste node ID'),
              content: TextField(
                controller: controller,
                autofocus: true,
                decoration: InputDecoration(
                  hintText: 'did:ad:node:…',
                  errorText: error,
                ),
                onSubmitted: (_) => submit(),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Cancel'),
                ),
                TextButton(onPressed: submit, child: const Text('Connect')),
              ],
            );
          },
        );
      },
    );
    controller.dispose();
    if (nodeId != null && mounted) await _pairThenCheck(nodeId);
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
        child: shared.ErrorText(_error!,
            color:
                Theme.of(context).extension<AppColors>()?.alert ?? Colors.red,
            fontSize: 13),
      ),
    );
  }
}

/// What a failed sign-in with a secret says: a secret that is not one (cut
/// short, a word, something else on the clipboard) gets a sentence a person
/// can act on, not the decoder's "Not valid Base64. Invalid last symbol 116,
/// offset 9."; anything else as it came.
String signInError(Object error) {
  if (error is PlatformException) return keychainErrorMessage(error);
  final text = '$error';
  final notASecret = RegExp(r'Invalid key|Base64|base64|Invalid secret|decode',
          caseSensitive: false)
      .hasMatch(text);
  if (notASecret) {
    return 'That is not a secret. A secret is the long code you saved when '
        'you made your identity; on a device that is signed in, Sync → '
        'Copy secret key gives it.';
  }
  return text.replaceFirst('Bad state: ', '');
}
