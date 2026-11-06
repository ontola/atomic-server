/// [PeerLinkBackend] over the generated bridge: `WebRtcPeerLink` in Rust,
/// frames in and out as bytes (`planning/flutter-webrtc-peer.md`).
library;

import 'dart:typed_data';

import 'package:atomic_store_flutter/bridge/api/simple/webrtc_peer.dart' as ffi;

import 'webrtc/peer_link_backend.dart';

/// Opens a link in the native library. A seam so tests run without it.
typedef OpenBridgeLink = Future<ffi.WebRtcLinkStart> Function({
  required String drive,
  required String binding,
  String? expectedPeer,
});

class BridgePeerLinkBackend implements PeerLinkBackend {
  const BridgePeerLinkBackend({OpenBridgeLink open = ffi.openWebrtcLink})
      : _open = open;

  final OpenBridgeLink _open;

  @override
  Future<OpenedPeerLink> open({
    required String drive,
    required String binding,
    String? expectedPeer,
  }) async {
    final start = await _open(
      drive: drive,
      binding: binding,
      expectedPeer: expectedPeer,
    );
    return OpenedPeerLink(BridgePeerLink(start.link), start.challenge);
  }
}

class BridgePeerLink implements PeerLinkHandle {
  BridgePeerLink(this._link);

  final ffi.WebRtcLink _link;

  @override
  Future<PeerLinkOutput> handle(Uint8List frame) async {
    final out = await _link.handle(frame: frame);
    return PeerLinkOutput(
      frames: out.frames,
      changed: out.changed,
      ready: out.ready,
    );
  }

  @override
  Future<Uint8List?> reconcileFrame() => _link.reconcileFrame();

  @override
  Future<List<Uint8List>> nextLiveFrames() => _link.nextLiveFrames();

  @override
  Future<void> close() async {
    await _link.close();
    _link.dispose();
  }
}
