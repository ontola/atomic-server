import 'package:calorie_tracker/services/sync_service.dart';

/// A [SyncBackend] with no Iroh node behind it.
///
/// Models the three things the service actually reasons about: how many devices
/// this account knows, what reaching them came to, and whether there is a server
/// to hold a live session with.
class FakeSyncBackend implements SyncBackend {
  /// What [deviceCount] answers. Zero is a phone nobody has paired.
  int devices = 0;

  /// What [reachDevices] answers, unless [reachError] is set.
  SyncConnectivityReport report = const SyncConnectivityReport(
    imported: 0,
    livePeers: 0,
    message: 'No other devices found',
  );

  /// Thrown by [reachDevices] — a dead network, a peer that will not answer.
  Object? reachError;

  /// The configured server, or null for device-to-device only.
  String? server;

  /// Thrown by [openServer]. A server that is switched off is an ordinary
  /// state, and the peer sync must happen anyway.
  Object? openError;

  /// Every call, in order, so a test can say what did *not* happen.
  final List<String> calls = [];

  /// Run just before [reachDevices] answers — where a test puts the meals the
  /// other device is about to hand over, since [report] only counts them.
  Future<void> Function()? onReach;

  @override
  Future<int> deviceCount() async {
    calls.add('deviceCount');
    return devices;
  }

  @override
  Future<SyncConnectivityReport> reachDevices() async {
    calls.add('reachDevices');
    if (reachError != null) throw reachError!;
    await onReach?.call();
    return report;
  }

  @override
  Future<String?> activeServer() async {
    calls.add('activeServer');
    return server;
  }

  @override
  Future<void> openServer(String url) async {
    calls.add('openServer:$url');
    if (openError != null) throw openError!;
  }
}
