/// Starts WebRTC peer sync for the app's drives and ties it to the app's
/// life: rooms open when the app is in front and signed in, and close when it
/// goes to the background (the OS ends the sockets there anyway) or signs out.
///
/// The Rust half is `atomic_lib::sync::webrtc_link`; until the bridge binds it
/// ([PeerSyncHost.backend] is set, see `planning/flutter-webrtc-peer.md`) this
/// does nothing, and nothing is contacted.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'atomic_client.dart';
import 'webrtc/peer_link_backend.dart';
import 'webrtc/peer_sync_service.dart';

/// The `signalingUrl` property of a drive.
const driveSignalingUrlProperty =
    'https://atomicdata.dev/properties/signaling-url';

class PeerSyncHost {
  PeerSyncHost._();
  static final instance = PeerSyncHost._();

  /// Binds the Rust link. Set once at startup by the bridge adapter.
  PeerLinkBackend? backend;

  /// The portal serving `/webrtc-signal` for drives that name no service.
  String portalUrl = 'https://atomic.place';

  WebRtcPeerSyncService? _service;
  Timer? _rescan;

  bool get running => _service != null;

  /// The latest status of each drive's room, for a status line.
  Map<String, String> get statuses => _service?.statuses ?? const {};

  /// Start and stop run one at a time, in call order. The app asks for both
  /// from several places at once (resume, login, sign-out); unordered, a stop
  /// closed the links a concurrent start had just opened.
  Future<void> _queue = Future.value();

  Future<void> _enqueue(Future<void> Function() task) {
    final next = _queue.then((_) => task());
    _queue = next.catchError((Object error) {
      debugPrint('[webrtc] peer sync: $error');
    });
    return next;
  }

  Future<void> start() => _enqueue(_start);

  Future<void> stop() => _enqueue(_stop);

  Future<void> _start() async {
    final backend = this.backend;
    if (backend == null) return;
    final service = _service ??= WebRtcPeerSyncService(
      backend: backend,
      listDrives: AtomicClient.listDrives,
      driveSignalingUrl: _driveSignalingUrl,
      // Every drive joins its room, also one this app syncs through a Cloud
      // Server: the web joins it whenever its own server does not carry the
      // drive (a private drive in the browser), and the two must meet.
      usesCloudServer: (_) async => false,
      portalUrl: portalUrl,
      onStatus: (drive, status) => debugPrint('Peer sync $drive: $status'),
      // A favorite or message from the browser shows at once, not at the next
      // periodic re-read.
      onChanged: AtomicClient.notifyResourcesChanged,
    );
    // Drives created or joined while the app runs.
    _rescan ??= Timer.periodic(const Duration(minutes: 2), (_) {
      unawaited(_service?.start());
    });
    await service.start();
  }

  Future<void> _stop() async {
    _rescan?.cancel();
    _rescan = null;
    final service = _service;
    _service = null;
    await service?.stop();
  }

  Future<String?> _driveSignalingUrl(String drive) async {
    try {
      final value =
          await AtomicClient.getProperty(drive, driveSignalingUrlProperty);
      return value.isEmpty ? null : value;
    } catch (_) {
      return null;
    }
  }
}
