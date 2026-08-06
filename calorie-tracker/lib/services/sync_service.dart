import 'package:flutter/foundation.dart';

import '../atomic/atomic_client.dart';
import '../atomic/session.dart';

export '../atomic/atomic_client.dart' show SyncConnectivityReport;

/// Everything syncing needs from the layer below.
///
/// A seam for the same reason [AtomicBackend] is one: the test VM has no Rust
/// library and no Iroh node, and the policy here — when to reach out, what to
/// do with what comes back, what to say when nothing does — is exactly what
/// wants covering by fast tests. [FfiSyncBackend] is the real one.
abstract class SyncBackend {
  /// How many other devices this account knows: paired phones, plus any
  /// always-on server that has been added by address.
  Future<int> deviceCount();

  /// Start the peer if it isn't running, reach whatever is reachable, and pull
  /// what it has.
  Future<SyncConnectivityReport> reachDevices();

  /// The server this device syncs through, or null when it syncs only with
  /// other devices — which is the default and a perfectly good place to stay.
  Future<String?> activeServer();

  /// Open the live session with [url], so commits made from now on are pushed
  /// as they happen rather than at the next sync.
  Future<void> openServer(String url);
}

class FfiSyncBackend implements SyncBackend {
  const FfiSyncBackend();

  @override
  Future<int> deviceCount() async {
    final peers = await AtomicClient.getKnownPeers();
    final servers = await AtomicSession.knownServers();
    return peers.length + servers.length;
  }

  @override
  Future<SyncConnectivityReport> reachDevices() =>
      AtomicClient.syncConnectivityNow();

  @override
  Future<String?> activeServer() => AtomicSession.activeServer();

  @override
  Future<void> openServer(String url) => AtomicClient.openWsSync(url);
}

/// Keeping this device's meals and another device's meals the same meals.
///
/// The plan (§2) has sync optional and explicit, and it stays that way: a fresh
/// install pairs with nothing, reaches for no network, and works exactly as it
/// did before this existed. Pairing a device is the opt-in — and once it has
/// happened, [autoSync] runs on launch and on every return to the foreground,
/// because a sync somebody has to remember to press is a sync that doesn't
/// happen.
///
/// What it does *not* do is move photos. Those are device-local (plan §10), so
/// a meal that arrives from another phone arrives with its calories and without
/// its picture — which is why the estimator leaves such a meal alone rather
/// than failing it (see `EstimationQueue`).
class SyncService extends ChangeNotifier {
  SyncService({
    SyncBackend backend = const FfiSyncBackend(),
    Future<void> Function()? onImported,
  })  : _backend = backend,
        _onImported = onImported;

  final SyncBackend _backend;

  /// Called after a sync brought something in, so whoever is holding the meals
  /// can re-read them. Nothing else here knows what a meal is.
  final Future<void> Function()? _onImported;

  bool _busy = false;
  int _devices = 0;
  String? _lastMessage;
  DateTime? _lastSyncedAt;

  /// A sync is in flight. One at a time: they take seconds, and two at once
  /// would race each other over the same store for no gain.
  bool get busy => _busy;

  /// How many devices this account knows of. Zero means nothing has been paired
  /// and there is nothing to sync *with* — not that sync is broken.
  int get devices => _devices;

  bool get hasDevices => _devices > 0;

  /// What the last attempt came to, in the words the layer below used. Shown on
  /// the sync screen; never as an error anywhere else, because an unreachable
  /// device is an ordinary state for a phone to be in.
  String? get lastMessage => _lastMessage;

  DateTime? get lastSyncedAt => _lastSyncedAt;

  /// Whether anything came in on the last sync. What decides if the day on
  /// screen has to be re-read.
  bool _imported = false;

  bool get importedSomething => _imported;

  /// Count the devices again. What pairing one, or removing one, changes.
  Future<void> refresh() async {
    try {
      _devices = await _backend.deviceCount();
    } catch (e) {
      // No Iroh node yet, no bridge in a widget test: not knowing how many
      // devices there are is not worth a message anywhere.
      debugPrint('Could not count devices: $e');
      return;
    }
    notifyListeners();
  }

  /// The launch-and-resume path: sync, but only with devices this account has
  /// actually been paired with.
  ///
  /// The check is the point. [reachDevices] starts an Iroh node and asks the
  /// network where this account's other devices are; doing that on a phone that
  /// has never been paired spends battery looking for something that does not
  /// exist. So an unpaired device stays entirely local until somebody pairs it,
  /// and a paired one syncs without being asked again.
  Future<void> autoSync() async {
    await refresh();
    if (!hasDevices) return;
    await syncNow();
  }

  /// Reach the other devices now, whatever the pairing state — the button on
  /// the sync screen, which is somebody asking.
  Future<void> syncNow() async {
    if (_busy) return;
    _busy = true;
    _imported = false;
    notifyListeners();

    try {
      // Best effort, and first: with a live session open, every commit from
      // here on is pushed as it is made rather than waiting for the next sync.
      // A server that is not reachable is not a reason to skip the peers.
      await _openActiveServer();

      final report = await _backend.reachDevices();
      _lastMessage = report.message;
      _lastSyncedAt = DateTime.now();
      _imported = report.imported > 0;

      if (_imported) await _onImported?.call();
    } catch (e) {
      _lastMessage = _messageFor(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Open the live session with the configured server, if there is one.
  ///
  /// Separate from the peer sync and swallowed on failure: a server is the
  /// optional half of an optional feature, and a laptop that is switched off is
  /// not something to tell anybody about while they are looking at a viewfinder.
  Future<void> _openActiveServer() async {
    try {
      final url = await _backend.activeServer();
      if (url == null || url.isEmpty) return;
      await _backend.openServer(url);
    } catch (e) {
      debugPrint('No live session with the server: $e');
    }
  }

  /// Bridge errors arrive as `Exception: <what Rust said>`; the prefix is noise
  /// on a screen and the rest is the only clue there is.
  static String _messageFor(Object e) {
    final text = e.toString();
    return text.startsWith('Exception: ') ? text.substring(11) : text;
  }
}
