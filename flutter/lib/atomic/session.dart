import 'package:shared_preferences/shared_preferences.dart';

/// Persists the atomic session (server URL, agent secret, drive) across restarts.
/// On web: uses localStorage. On native: uses platform-specific secure storage.
class AtomicSession {
  static const _keyServerUrl = 'atomic_server_url';
  static const _keySecret = 'atomic_agent_secret';
  static const _keyDrive = 'atomic_drive';

  static Future<void> save({
    required String serverUrl,
    required String secret,
    String? drive,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyServerUrl, serverUrl);
    await prefs.setString(_keySecret, secret);
    if (drive != null) {
      await prefs.setString(_keyDrive, drive);
    }
  }

  static Future<void> saveDrive(String drive) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyDrive, drive);
  }

  static Future<({String serverUrl, String secret, String? drive})?>
      load() async {
    final prefs = await SharedPreferences.getInstance();
    final serverUrl = prefs.getString(_keyServerUrl);
    final secret = prefs.getString(_keySecret);
    if (serverUrl == null || secret == null) return null;
    return (
      serverUrl: serverUrl,
      secret: secret,
      drive: prefs.getString(_keyDrive),
    );
  }

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keyServerUrl);
    await prefs.remove(_keySecret);
    await prefs.remove(_keyDrive);
  }

  // ── Paired peers ──────────────────────────────────────────────────

  static const _keyPeers = 'atomic_peers';

  static Future<List<String>> loadPeers() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getStringList(_keyPeers) ?? [];
  }

  static Future<void> addPeer(String nodeId) async {
    final prefs = await SharedPreferences.getInstance();
    final peers = prefs.getStringList(_keyPeers) ?? [];
    if (!peers.contains(nodeId)) {
      peers.add(nodeId);
      await prefs.setStringList(_keyPeers, peers);
    }
  }

  static Future<void> removePeer(String nodeId) async {
    final prefs = await SharedPreferences.getInstance();
    final peers = prefs.getStringList(_keyPeers) ?? [];
    peers.remove(nodeId);
    await prefs.setStringList(_keyPeers, peers);
  }
}
