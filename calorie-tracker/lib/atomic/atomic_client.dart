import 'dart:convert';

import 'package:flutter/foundation.dart';
import '../src/rust/api/simple.dart' as ffi;
import '../src/rust/api/simple/types.dart' show AgentInfo, VersionMetadata;

export '../src/rust/api/simple/types.dart' show AgentInfo, VersionMetadata;

/// Atomic Data SDK — local-first with optional sync.
///
/// Groups:
///   1. Database  — openDb()
///   2. Agent     — setup(), loadAgent(), getActiveAgent(), clearAgent()
///   3. Drive     — createDrive(), listDrives(), getActiveDrive(), setActiveDrive()
///   4. Resource  — createResource(), getProperty(), setProperty(), renameResource(),
///                  deleteResource()
///   5. History   — warmResourceHistory(), getResourceHistory(), getPropertyAtVersion()
///   6. Sync      — openWsSync(), syncDriveToServer(), resumeSession(), peers
///
/// Networking (group 6) is explicit. Nothing in groups 1-5 reaches the network
/// beyond the best-effort push a save makes when a session is already open.
///
/// This mirrors `flutter/lib/atomic/atomic_client.dart` in the Atomic Canvas
/// app, minus that app's canvas methods. Keep the shared parts in step with it:
/// the two are meant to become one package.
class AtomicClient {
  // ── 1. Database ──────────────────────────────────────────────────────────

  static Future<void> openDb(String path) => ffi.openDb(path: path);

  // ── 2. Agent ─────────────────────────────────────────────────────────────

  /// Create an agent + personal drive. Pure local.
  static Future<
      ({
        String agentSecret,
        String agentSubject,
        String driveSubject
      })> setup(String name) async {
    final r = await ffi.setup(name: name);
    return (
      agentSecret: r.agentSecret,
      agentSubject: r.agentSubject,
      driveSubject: r.driveSubject,
    );
  }

  /// Load an agent from a secret. Pure local.
  /// Returns the agent subject, or `needs_sync` when the drive isn't here yet.
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

  /// A plain container resource — what a `meals` folder under the drive is.
  static const folderClass = 'https://atomicdata.dev/classes/Folder';

  /// Create a named child of [parent]. [isA] is validated on write, so it has
  /// to be a class whose required properties this call actually sets.
  static Future<String> createResource(
    String parent,
    String name, {
    String isA = folderClass,
  }) =>
      ffi.createResource(parentSubject: parent, name: name, class_: isA);

  static Future<String> getProperty(String subject, String property) =>
      ffi.getProperty(subject: subject, property: property);

  static Future<void> setProperty(
          String subject, String property, String value) =>
      ffi.setProperty(subject: subject, property: property, value: value);

  static Future<void> renameResource(String subject, String name) =>
      ffi.renameResource(subject: subject, name: name);

  static Future<void> deleteResource(String subject) =>
      ffi.deleteResource(subject: subject);

  // ── 5. History ───────────────────────────────────────────────────────────

  static Future<void> warmResourceHistory(String subject) =>
      ffi.warmResourceHistory(subject: subject);

  static Future<List<VersionMetadata>> getResourceHistory(String subject) =>
      ffi.getResourceHistory(subject: subject);

  /// Read one property as it stood at [versionId].
  static Future<String> getPropertyAtVersion(
          String subject, List<int> versionId, String property) =>
      ffi.getPropertyAtVersion(
        subject: subject,
        versionId: versionId,
        property: property,
      );

  // ── 6. Peer / Sync (explicit, opt-in) ────────────────────────────────────

  /// Start the Iroh peer. Returns the NodeID. Call before any sync operations.
  static Future<String> startPeer() => ffi.startPeer();

  /// Get this device's NodeID, or null if peer not started.
  static Future<String?> getPeerId() async => ffi.getPeerId();

  /// Announce a drive on DHT so other devices can find us.
  static Future<void> peerAnnounce(String driveSubject) =>
      ffi.peerAnnounce(driveSubject: driveSubject);

  /// Sync the active drive with a peer by NodeID.
  static Future<PeerSyncResult> peerSync(String nodeId) async =>
      PeerSyncResult.fromJson(
        jsonDecode(await ffi.peerSync(nodeId: nodeId)) as Map<String, dynamic>,
      );

  /// Discover a peer via DHT and sync. Combines lookup + sync.
  static Future<int> peerDiscoverSync(String driveSubject) =>
      ffi.peerDiscoverSync(driveSubject: driveSubject);

  /// Start Iroh, sync known peers + pkarr. Use on app open and Settings → Retry.
  static Future<SyncConnectivityReport> syncConnectivityNow() async {
    final json = await ffi.syncConnectivityNow();
    final m = jsonDecode(json) as Map<String, dynamic>;
    return SyncConnectivityReport(
      imported: (m['imported'] as num?)?.toInt() ?? 0,
      livePeers: (m['live_peers'] as num?)?.toInt() ?? 0,
      message: m['message'] as String? ?? '',
    );
  }

  // ── 7. Known peers ──────────────────────────────────────────────────────

  /// Get all known peers (persisted in DB).
  /// Returns list of {node_id: String, name: String, last_synced: String}.
  /// `last_synced` is unix millis as a string, or '' if never synced.
  static Future<List<Map<String, String>>> getKnownPeers() async {
    final json = ffi.getKnownPeersJson();
    try {
      return (jsonDecode(json) as List)
          .map((e) => {
                'node_id': (e['node_id'] ?? '') as String,
                'name': (e['name'] ?? '') as String,
                'last_synced':
                    e['last_synced'] == null ? '' : '${e['last_synced']}',
              })
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Add a peer with optional device name.
  static Future<void> addKnownPeer(String nodeId, [String name = '']) async =>
      ffi.addKnownPeer(nodeId: nodeId, name: name);

  /// Remove a peer by NodeID.
  static Future<void> removeKnownPeer(String nodeId) async =>
      ffi.removeKnownPeer(nodeId: nodeId);

  // ── 8. WebSocket sync (server-backed) ────────────────────────────────────

  /// Optional LAN hub (e.g. `http://192.168.x.x:9883`). Empty = device-to-device only.
  static const defaultServerUrl = '';

  /// Connect to Atomic Server over WebSocket; SUB active drive; apply remote updates.
  static Future<void> openWsSync(String serverUrl) =>
      ffi.openWsSync(serverUrl: serverUrl);

  static Future<void> closeWsSync() => ffi.closeWsSync();

  /// Push the active drive to `serverUrl`, so it is hosted there too.
  /// Returns the number of resources pushed.
  ///
  /// [openWsSync] fetches a drive this device lacks and pushes commits made
  /// from now on; a drive made here before any server was connected has never
  /// been offered to one. This offers it — and it is the only way a workspace
  /// made here reaches a browser, which is not a peer and cannot be paired
  /// with.
  static Future<int> syncDriveToServer(String serverUrl) =>
      ffi.syncDriveToServer(serverUrl: serverUrl);

  /// Boot / auto-login: load agent, WS sync, fetch drive.
  /// Returns `ok` or `needs_sync`.
  static Future<String> resumeSession({
    required String serverUrl,
    required String secret,
    String? drive,
  }) {
    return ffi.resumeAppSession(
      serverUrl: serverUrl,
      secret: secret,
      driveHint: drive,
    );
  }

  /// Subscribe to live updates for one resource over the open WS session.
  static Future<void> wsSubscribeResource(String subject) =>
      ffi.wsSubscribeResource(subject: subject);

  // ── 9. Events and watchers ──────────────────────────────────────────────

  /// Block until a DB event (changed / destroyed / query membership). Null on timeout.
  static Future<Map<String, dynamic>?> pollDbEvent(
      {int timeoutMs = 60000}) async {
    final json = await ffi.pollDbEvent(timeoutMs: timeoutMs);
    if (json == null || json == 'null') return null;
    try {
      return Map<String, dynamic>.from(jsonDecode(json));
    } catch (_) {
      return null;
    }
  }

  /// Get persisted device name.
  static Future<String> getDeviceName() async => ffi.getDeviceName();

  /// Set device name (persisted in DB).
  static Future<void> setDeviceName(String name) async =>
      ffi.setDeviceName(name: name);

  /// Get the number of currently connected live peers.
  static Future<int> livePeerCount() async => ffi.livePeerCount();

  /// Get the node IDs of currently connected live peers.
  static Set<String> livePeerIds() => ffi.livePeerIds().toSet();

  /// Fired when Iroh live-peer count changes (`connected` / `disconnected` events).
  static final ValueNotifier<int> livePeersRevision = ValueNotifier(0);

  static void notifyLivePeersChanged() {
    livePeersRevision.value++;
  }

  /// Canonical 64-char hex NodeID (matches Rust `normalize_node_id`).
  static String normalizeNodeId(String id) {
    var s = id.trim();
    const prefix = 'did:ad:node:';
    if (s.startsWith(prefix)) {
      s = s.substring(prefix.length);
      if (s.length > 64 && s[64] == ':') {
        s = s.substring(0, 64);
      }
    }
    if (s.startsWith('iroh:')) s = s.substring(5);
    return s.toLowerCase();
  }

  static bool isLivePeer(String knownNodeId, Set<String> liveIds) {
    final n = normalizeNodeId(knownNodeId);
    return liveIds.any((l) => normalizeNodeId(l) == n);
  }

  /// Block until the next sync event arrives. Reactive — no polling.
  static Future<Map<String, dynamic>?> waitForSyncEvent() async {
    final json = await ffi.waitForSyncEvent();
    if (json == 'null') return null;
    try {
      return Map<String, dynamic>.from(jsonDecode(json));
    } catch (_) {
      return null;
    }
  }

  /// Block until the live peer count changes from [current]. Reactive.
  static Future<int> waitForPeerCountChange(int current) =>
      ffi.waitForPeerCountChange(current: current);

  /// Block until a specific resource changes. Returns the subject or "timeout".
  static Future<String> watchResource(String subject) =>
      ffi.watchResource(subject: subject);

  /// Block until a child of [parent] changes. Returns the changed subject.
  /// Times out after 60s and returns "timeout".
  static Future<String> watchChildren(String parent) =>
      ffi.watchChildren(parent: parent);

  /// Poll for incoming sync events (peer connected and synced).
  /// Returns a list of {remoteNodeId, resourcesImported, timestamp}.
  static Future<List<Map<String, dynamic>>> pollSyncEvents() async {
    final json = await ffi.pollSyncEvents();
    try {
      return List<Map<String, dynamic>>.from(
        (jsonDecode(json) as List).map((e) => Map<String, dynamic>.from(e)),
      );
    } catch (_) {
      return [];
    }
  }
}

/// Result of [`AtomicClient.syncConnectivityNow`].
class SyncConnectivityReport {
  final int imported;
  final int livePeers;
  final String message;

  const SyncConnectivityReport({
    required this.imported,
    required this.livePeers,
    required this.message,
  });
}

/// What a sync did, in both directions.
///
/// A count of imports alone says "0" for the two things that most often
/// happen — sending a workspace somewhere that has none, and both sides
/// already holding the same thing — and "0" reads as failure.
class PeerSyncResult {
  const PeerSyncResult({
    required this.imported,
    required this.pushed,
    required this.inSync,
    this.peerName,
  });

  /// Resources taken from the other device.
  final int imported;

  /// Resources handed to it.
  final int pushed;

  /// Both sides already held the same thing. Nothing moved, nothing needed to.
  final bool inSync;

  /// What the other device calls itself, if it said.
  final String? peerName;

  factory PeerSyncResult.fromJson(Map<String, dynamic> json) => PeerSyncResult(
        imported: (json['imported'] as num?)?.toInt() ?? 0,
        pushed: (json['pushed'] as num?)?.toInt() ?? 0,
        inSync: json['in_sync'] == true,
        peerName: json['peer_name'] as String?,
      );

  /// What happened, as a person would say it.
  String describe([String? fallbackName]) {
    final name = peerName?.isNotEmpty == true ? peerName : fallbackName;
    final withWhom = name == null ? '' : ' with $name';

    if (imported > 0 && pushed > 0) {
      return 'Synced$withWhom — sent $pushed, received $imported';
    }

    if (pushed > 0) {
      return 'Sent $pushed ${pushed == 1 ? 'resource' : 'resources'}$withWhom';
    }

    if (imported > 0) {
      return 'Received $imported ${imported == 1 ? 'resource' : 'resources'}$withWhom';
    }

    if (inSync) {
      return 'Already in sync$withWhom';
    }

    return 'Nothing to sync$withWhom';
  }
}
