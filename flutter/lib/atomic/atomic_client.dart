import 'dart:convert';
import 'dart:typed_data';
import '../src/rust/api/simple.dart' as ffi;
import '../src/rust/api/simple.dart'
    show AgentInfo, CanvasListItem, VersionMetadata;

export '../src/rust/api/simple.dart'
    show AgentInfo, CanvasListItem, VersionMetadata;

/// Atomic Data SDK — local-first with optional sync.
///
/// Groups:
///   1. Database  — openDb()
///   2. Agent     — setup(), loadAgent(), getActiveAgent(), clearAgent()
///   3. Drive     — createDrive(), listDrives(), getActiveDrive(), setActiveDrive()
///   4. Resource  — getProperty(), setProperty()
///   5. Canvas    — createCanvas(), save/load/list/delete/rename
///   6. History   — warmResourceHistory(), getResourceHistory(), getResourceAtVersion()
///   7. Peer      — startPeer(), getPeerId(), peerAnnounce(), peerSync(), peerDiscoverSync()
///
/// Networking (group 7) is explicit. Nothing in groups 1-6 touches the network.
class AtomicClient {
  // ── 1. Database ──────────────────────────────────────────────────────────

  static Future<void> openDb(String path) => ffi.openDb(path: path);

  // ── 2. Agent ─────────────────────────────────────────────────────────────

  /// Create an agent + personal drive. Pure local.
  static Future<
          ({String agentSecret, String agentSubject, String driveSubject})>
      setup(String name) async {
    final r = await ffi.setup(name: name);
    return (
      agentSecret: r.agentSecret,
      agentSubject: r.agentSubject,
      driveSubject: r.driveSubject,
    );
  }

  /// Load an agent from a secret. Pure local.
  static Future<String> loadAgent(String secret) =>
      ffi.loadAgent(secret: secret);

  static Future<AgentInfo?> getActiveAgent() => ffi.getActiveAgent();

  static AgentInfo createAgent(String name) => ffi.createAgent(name: name);

  static AgentInfo agentFromSecret(String secret) =>
      ffi.agentFromSecret(secret: secret);

  // ── 3. Drive ─────────────────────────────────────────────────────────────

  static Future<String> createDrive(String name) => ffi.createDrive(name: name);

  static Future<List<String>> listDrives() => ffi.listDrives();

  static String? getActiveDrive() => ffi.getActiveDrive();

  static Future<void> setActiveDrive(String subject) async =>
      ffi.setActiveDrive(subject: subject);

  // ── 4. Resource ──────────────────────────────────────────────────────────

  static Future<String> getProperty(String subject, String property) =>
      ffi.getProperty(subject: subject, property: property);

  static Future<void> setProperty(
          String subject, String property, String value) =>
      ffi.setProperty(subject: subject, property: property, value: value);

  // ── 5. Canvas CRUD ───────────────────────────────────────────────────────

  static Future<String> createCanvas(String name) =>
      ffi.createCanvas(name: name);

  static Future<String> loadCanvasStrokes(String subject) =>
      ffi.loadCanvasStrokes(subject: subject);

  static Future<List<CanvasListItem>> listCanvases() async =>
      (await ffi.listCanvases()).toList();

  static Future<void> deleteCanvas(String subject) =>
      ffi.deleteCanvas(subject: subject);

  static Future<void> renameCanvas(String subject, String name) =>
      ffi.renameCanvas(subject: subject, name: name);

  // ── 6. History ───────────────────────────────────────────────────────────

  static Future<void> warmResourceHistory(String subject) =>
      ffi.warmResourceHistory(subject: subject);

  static Future<List<VersionMetadata>> getResourceHistory(String subject) =>
      ffi.getResourceHistory(subject: subject);

  static Future<String> getResourceAtVersion(
          String subject, List<int> versionId) =>
      ffi.getResourceAtVersion(
          subject: subject,
          versionId: versionId is Uint8List
              ? versionId
              : Uint8List.fromList(versionId));

  // ── 7. Peer / Sync (explicit, opt-in) ────────────────────────────────────

  /// Start the Iroh peer. Returns the NodeID. Call before any sync operations.
  static Future<String> startPeer() => ffi.startPeer();

  /// Get this device's NodeID, or null if peer not started.
  static Future<String?> getPeerId() => ffi.getPeerId();

  /// Announce a drive on DHT so other devices can find us.
  static Future<void> peerAnnounce(String driveSubject) =>
      ffi.peerAnnounce(driveSubject: driveSubject);

  /// Sync the active drive with a peer by NodeID.
  static Future<int> peerSync(String nodeId) => ffi.peerSync(nodeId: nodeId);

  /// Discover a peer via DHT and sync. Combines lookup + sync.
  static Future<int> peerDiscoverSync(String driveSubject) =>
      ffi.peerDiscoverSync(driveSubject: driveSubject);

  // ── 8. Known peers ──────────────────────────────────────────────────────

  static Future<String> _cmd(String cmd) =>
      ffi.connect(serverUrl: cmd, agentSecret: '');

  /// Get all known peers (persisted in DB).
  /// Returns list of {node_id: String, name: String}.
  static Future<List<Map<String, String>>> getKnownPeers() async {
    final json = await _cmd('get_known_peers');
    try {
      return (jsonDecode(json) as List)
          .map((e) => {
                'node_id': (e['node_id'] ?? '') as String,
                'name': (e['name'] ?? '') as String,
              })
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Add a peer with optional device name.
  static Future<void> addKnownPeer(String nodeId, [String name = '']) =>
      _cmd('add_known_peer:$nodeId:$name');

  /// Remove a peer by NodeID.
  static Future<void> removeKnownPeer(String nodeId) =>
      _cmd('remove_known_peer:$nodeId');

  // ── 10. Live queries ────────────────────────────────────────────────────

  /// Get persisted device name.
  static Future<String> getDeviceName() => _cmd('get_device_name');

  /// Set device name (persisted in DB).
  static Future<void> setDeviceName(String name) =>
      _cmd('set_device_name:$name');

  /// Push a single stroke to a canvas (CRDT-friendly append).
  static Future<void> pushStroke(String subject, String strokeJson) =>
      _cmd('push_stroke:$subject:$strokeJson');

  /// Replace all strokes (used after undo/scrub). Clears and re-sets the full list.
  static Future<void> setStrokes(String subject, String strokesJson) =>
      _cmd('set_strokes:$subject:$strokesJson');

  /// Get the number of currently connected live peers.
  static Future<int> livePeerCount() async {
    final result = await _cmd('live_peer_count');
    return int.tryParse(result) ?? 0;
  }

  /// Get the node IDs of currently connected live peers.
  static Future<Set<String>> livePeerIds() async {
    final json = await _cmd('live_peer_ids');
    try {
      return Set<String>.from(jsonDecode(json));
    } catch (_) {
      return {};
    }
  }

  /// Block until the next sync event arrives. Reactive — no polling.
  static Future<Map<String, dynamic>?> waitForSyncEvent() async {
    final json = await _cmd('wait_for_sync_event');
    if (json == 'null') return null;
    try {
      return Map<String, dynamic>.from(jsonDecode(json));
    } catch (_) {
      return null;
    }
  }

  /// Block until the live peer count changes from [current]. Reactive.
  static Future<int> waitForPeerCountChange(int current) async {
    final result = await _cmd('wait_for_peer_count_change:$current');
    return int.tryParse(result) ?? current;
  }

  /// Block until a specific resource changes. Returns the subject or "timeout".
  static Future<String> watchResource(String subject) =>
      _cmd('watch_resource:$subject');

  /// Block until a child of [parent] changes. Returns the changed subject.
  /// Times out after 60s and returns "timeout".
  static Future<String> watchChildren(String parent) =>
      _cmd('watch_children:$parent');

  // ── 9. Sync events ─────────────────────────────────────────────────────

  /// Poll for incoming sync events (peer connected and synced).
  /// Returns a list of {remoteNodeId, resourcesImported, timestamp}.
  static Future<List<Map<String, dynamic>>> pollSyncEvents() async {
    final json = await _cmd('poll_sync_events');
    try {
      return List<Map<String, dynamic>>.from(
        (jsonDecode(json) as List).map((e) => Map<String, dynamic>.from(e)),
      );
    } catch (_) {
      return [];
    }
  }
}
