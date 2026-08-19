import 'package:path_provider/path_provider.dart';

import 'atomic_client.dart';
import 'rust_init.dart';
import 'session.dart';

/// High-level entry point for app builders.
///
/// ```dart
/// await Atomic.init();
/// await Atomic.setup(name: 'Ada');
/// // or: await Atomic.resumeSession();
/// ```
class Atomic {
  Atomic._();

  static bool _ready = false;

  /// Whether [init] has completed.
  static bool get isReady => _ready;

  /// Initialize the Rust bridge and open the local database.
  ///
  /// Call once from `main()` before any other Atomic API. When [dbPath] is
  /// omitted, uses the app documents directory.
  static Future<void> init({String? dbPath}) async {
    if (_ready) return;
    await initRustBridge();
    final path = dbPath ?? (await getApplicationDocumentsDirectory()).path;
    await AtomicClient.openDb(path);
    _ready = true;
  }

  /// Create a new agent + personal workspace. Persists the session.
  static Future<
          ({String agentSecret, String agentSubject, String driveSubject})>
      setup({required String name, String serverUrl = ''}) async {
    _ensureReady();
    final result = await AtomicClient.setup(name);
    await AtomicSession.save(
      serverUrl: serverUrl,
      secret: result.agentSecret,
      drive: result.driveSubject,
    );
    return result;
  }

  /// Load an existing agent from its secret and persist the session.
  static Future<String> signIn({
    required String secret,
    String serverUrl = '',
    String? drive,
  }) async {
    _ensureReady();
    final subject = await AtomicClient.loadAgent(secret);
    await AtomicSession.save(
      serverUrl: serverUrl,
      secret: secret,
      drive: drive ?? AtomicClient.getActiveDrive(),
    );
    return subject;
  }

  /// Restore the last session (secret from secure storage → WS + Iroh).
  ///
  /// Returns `ok`, `needs_sync`, or `null` when nothing was saved.
  static Future<String?> resumeSession() async {
    _ensureReady();
    final session = await AtomicSession.load();
    if (session == null || session.secret.isEmpty) return null;
    final status = await AtomicClient.resumeSession(
      serverUrl: session.serverUrl,
      secret: session.secret,
      drive: session.drive,
    );
    final drive = AtomicClient.getActiveDrive();
    if (drive != null) await AtomicSession.saveDrive(drive);
    return status;
  }

  /// Clear the local session (does not delete the local database).
  static Future<void> signOut() async {
    await AtomicSession.clear();
  }

  // ── Workspaces (drives) ─────────────────────────────────────────────

  static Future<String> createDrive(String name) {
    _ensureReady();
    return AtomicClient.createDrive(name);
  }

  static Future<List<String>> listDrives() {
    _ensureReady();
    return AtomicClient.listDrives();
  }

  static String? get activeDrive {
    _ensureReady();
    return AtomicClient.getActiveDrive();
  }

  static Future<void> setActiveDrive(String subject) async {
    _ensureReady();
    await AtomicClient.setActiveDrive(subject);
    await AtomicSession.saveDrive(subject);
  }

  // ── Resources ───────────────────────────────────────────────────────

  static Future<String> getProperty(String subject, String property) {
    _ensureReady();
    return AtomicClient.getProperty(subject, property);
  }

  static Future<void> setProperty(
      String subject, String property, String value) {
    _ensureReady();
    return AtomicClient.setProperty(subject, property, value);
  }

  // ── Sync ────────────────────────────────────────────────────────────

  /// Connect to an always-on device (AtomicServer) over WebSocket.
  static Future<void> connectServer(String url) async {
    _ensureReady();
    await AtomicSession.setActiveServer(url);
    await AtomicClient.openWsSync(url);
  }

  static Future<void> disconnectServer() => AtomicClient.closeWsSync();

  /// Start Iroh, sync known peers + pkarr discovery.
  static Future<SyncConnectivityReport> syncNow() {
    _ensureReady();
    return AtomicClient.syncConnectivityNow();
  }

  /// Push the active workspace to [serverUrl] so browsers can read it.
  static Future<int> syncDriveToServer(String serverUrl) {
    _ensureReady();
    return AtomicClient.syncDriveToServer(serverUrl);
  }

  static Future<AgentInfo?> get activeAgent {
    _ensureReady();
    return AtomicClient.getActiveAgent();
  }

  static void _ensureReady() {
    if (!_ready) {
      throw StateError(
        'Atomic.init() has not been called. '
        'Call it from main() before using Atomic APIs.',
      );
    }
  }
}
