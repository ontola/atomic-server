import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../atomic/atomic_client.dart';
import '../atomic/session.dart';
import '../rust_init.dart';

export '../atomic/atomic_client.dart' show AgentInfo, SyncConnectivityReport;

/// What the app can be doing at launch.
///
/// [needsSync] is its own state rather than an error: the secret was good and
/// the account is restored, but the drive it names lives on another device and
/// has not arrived here yet. Nothing can be written until it does, so this
/// device waits with something to do about it, instead of failing.
enum SessionPhase { starting, onboarding, needsSync, ready, failed }

/// Everything onboarding needs from the atomic layer.
///
/// An interface rather than the static [AtomicClient] because the test VM has
/// no Rust library and no platform channels: the flow — create, restore, import
/// a bad secret, land on a drive that isn't here — is exactly what has to be
/// covered by fast tests, and every step of it is one of these calls.
/// [FfiAtomicSession] is the real one; the app never builds another.
abstract class AtomicBackend {
  /// Open the local store. Must complete before anything else here is called.
  Future<void> open();

  /// Mint an agent and its drive.
  Future<
      ({
        String agentSecret,
        String agentSubject,
        String driveSubject
      })> setup(String name);

  /// Restore an agent from its secret. Returns the agent subject, or
  /// `needs_sync` when the drive that secret names isn't on this device.
  Future<String> loadAgent(String secret);

  Future<AgentInfo?> activeAgent();

  String? activeDrive();

  Future<void> setActiveDrive(String subject);

  /// Whether the active drive's own resource is actually here — a drive
  /// subject is just a string until the genesis commit arrives.
  Future<bool> driveReady();

  Future<String> ensureMealsContainer();

  /// Look for this account's other devices and pull what they have.
  Future<SyncConnectivityReport> syncNow();

  Future<void> forgetAgent();
}

/// The real backend: the Rust bridge, plus the one bit of platform state it
/// needs (where to put the database).
class FfiAtomicSession implements AtomicBackend {
  const FfiAtomicSession();

  static const _nameProperty = 'https://atomicdata.dev/properties/name';

  @override
  Future<void> open() async {
    await initRustBridge();
    final dir = await getApplicationDocumentsDirectory();
    await AtomicClient.openDb(dir.path);
  }

  @override
  Future<({String agentSecret, String agentSubject, String driveSubject})>
      setup(String name) => AtomicClient.setup(name);

  @override
  Future<String> loadAgent(String secret) => AtomicClient.loadAgent(secret);

  @override
  Future<AgentInfo?> activeAgent() => AtomicClient.getActiveAgent();

  @override
  String? activeDrive() => AtomicClient.getActiveDrive();

  @override
  Future<void> setActiveDrive(String subject) =>
      AtomicClient.setActiveDrive(subject);

  @override
  Future<bool> driveReady() async {
    final drive = AtomicClient.getActiveDrive();
    if (drive == null) return false;
    try {
      return (await AtomicClient.getProperty(drive, _nameProperty)).isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<String> ensureMealsContainer() => AtomicClient.ensureMealsContainer();

  @override
  Future<SyncConnectivityReport> syncNow() => AtomicClient.syncConnectivityNow();

  @override
  Future<void> forgetAgent() => AtomicClient.clearAgent();
}

/// Who is signed in, and where their meals go.
///
/// One object owns the whole boot: open the store, restore the saved account or
/// ask for one, and make sure the meals container exists before any screen can
/// try to write to it. Screens read [phase] and act on it; nothing else in the
/// app talks to [AtomicSession] or calls `setup` itself.
///
/// Deliberately *not* awaited by `main()` — see the note there. The UI renders
/// against whatever phase this is in and updates when it moves.
class AppSession extends ChangeNotifier {
  AppSession({AtomicBackend backend = const FfiAtomicSession()})
      : _backend = backend;

  final AtomicBackend _backend;

  /// The name a zero-input signup gives the agent. Onboarding asks for nothing
  /// — a calorie tracker with one user has no one to tell your name apart from
  /// — and Settings can rename it later.
  static const defaultAgentName = 'Me';

  SessionPhase _phase = SessionPhase.starting;
  bool _busy = false;
  AgentInfo? _agent;
  String? _drive;
  String? _mealsContainer;
  String? _error;

  SessionPhase get phase => _phase;

  /// A call is in flight. Separate from [phase] on purpose: creating an account
  /// must not throw the onboarding screen away and put a splash in its place —
  /// the button it was tapped on is where the spinner and any error belong.
  bool get busy => _busy;

  AgentInfo? get agent => _agent;

  String? get drive => _drive;

  /// The subject every meal is created under. Non-null exactly when
  /// [phase] is [SessionPhase.ready].
  String? get mealsContainer => _mealsContainer;

  /// Why the last thing failed, in the words the layer below used.
  String? get error => _error;

  /// Open the store and restore the saved account, if there is one.
  ///
  /// A failure here is the one that gets its own screen: the store did not
  /// open, so there is no account to sign in to and nothing to retry from.
  Future<void> start() async {
    await _guard(() async {
      await _backend.open();
      final saved = await AtomicSession.load();

      if (saved == null || saved.secret.isEmpty) {
        _phase = SessionPhase.onboarding;
        return;
      }

      await _adopt(saved.secret, driveHint: saved.drive);
    }, onError: SessionPhase.failed);
  }

  /// Onboarding's default path: a new account, no questions asked.
  Future<void> createAccount({String name = defaultAgentName}) async {
    // Onboarding stays put when this fails, with the reason on it: a fresh
    // install that lands on a dead-end error screen has nothing to tap.
    await _guard(() async {
      final result = await _backend.setup(name);
      await AtomicSession.save(
        serverUrl: AtomicClient.defaultServerUrl,
        secret: result.agentSecret,
        drive: result.driveSubject,
      );
      await _finish();
    });
  }

  /// Onboarding's other path: an account that already exists somewhere else.
  Future<void> importAccount(String secret) async {
    final trimmed = secret.trim();
    if (trimmed.isEmpty) {
      _error = 'Paste your secret first';
      notifyListeners();
      return;
    }

    await _guard(() => _adopt(trimmed));
  }

  /// Restore an agent from a secret and, if its data is here, finish the boot.
  ///
  /// The secret is saved either way. A secret that loads is the account even
  /// when its drive is still elsewhere — dropping it on the way to the sync
  /// screen would mean re-pasting it after every relaunch.
  Future<void> _adopt(String secret, {String? driveHint}) async {
    final status = await _backend.loadAgent(secret);

    if (driveHint != null &&
        driveHint.isNotEmpty &&
        _backend.activeDrive() == null) {
      await _backend.setActiveDrive(driveHint);
    }

    await AtomicSession.save(
      serverUrl: AtomicClient.defaultServerUrl,
      secret: secret,
      drive: _backend.activeDrive(),
    );

    if (status == 'needs_sync' || !await _backend.driveReady()) {
      _agent = await _backend.activeAgent();
      _drive = _backend.activeDrive();
      _phase = SessionPhase.needsSync;
      return;
    }

    await _finish();
  }

  /// Everything that has to be true before a screen may write a meal.
  Future<void> _finish() async {
    _agent = await _backend.activeAgent();
    _drive = _backend.activeDrive();
    _mealsContainer = await _backend.ensureMealsContainer();
    _phase = SessionPhase.ready;
  }

  /// From the sync screen: look for the other devices again.
  /// Returns what to tell the user when the drive still isn't here.
  Future<String> retrySync() async {
    if (_busy) return '';
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final report = await _backend.syncNow();
      final drive = _backend.activeDrive();
      if (drive != null) await AtomicSession.saveDrive(drive);

      if (await _backend.driveReady()) {
        await _finish();
        return report.message;
      }

      // Reached devices but still no drive: the account is on this network,
      // its data is not — say so rather than repeat the connection message.
      return report.imported > 0 || report.livePeers > 0
          ? 'Connected, but your meals are not here yet — try again'
          : report.message;
    } catch (e) {
      return _messageFor(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Forget the account on this device. The data stays in the local store and
  /// the secret brings it back; callers are expected to have offered the secret
  /// first, because nothing else can.
  Future<void> signOut() async {
    await AtomicSession.clear();
    await _backend.forgetAgent();
    _agent = null;
    _drive = null;
    _mealsContainer = null;
    _error = null;
    _phase = SessionPhase.onboarding;
    notifyListeners();
  }

  /// Run one session-changing step: at most one at a time, errors kept as text
  /// for a screen to show rather than thrown at a UI callback that cannot
  /// handle them.
  Future<void> _guard(
    Future<void> Function() step, {
    SessionPhase? onError,
  }) async {
    if (_busy) return;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      await step();
    } catch (e) {
      _error = _messageFor(e);
      if (onError != null) _phase = onError;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Bridge errors arrive as `Exception: <what Rust said>`; the prefix is noise
  /// on a screen and the rest is the only clue there is.
  static String _messageFor(Object e) {
    final text = e.toString();
    return text.startsWith('Exception: ') ? text.substring(11) : text;
  }
}
