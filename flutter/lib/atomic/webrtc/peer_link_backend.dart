/// The Rust half of a peer link, as the Dart side sees it. The real
/// implementation binds `atomic_lib::sync::webrtc_link::WebRtcPeerLink` through
/// the bridge (see `planning/flutter-webrtc-peer.md`); everything in this
/// folder is written against these interfaces so it runs, and is tested,
/// without the native library.
library;

import 'dart:typed_data';

class PeerLinkOutput {
  const PeerLinkOutput({
    this.frames = const [],
    this.changed = const [],
    this.ready = false,
  });

  /// Frames to send back over the channel, in order.
  final List<Uint8List> frames;

  /// Subjects the frame changed locally.
  final List<String> changed;

  /// Both directions are authenticated: reconcile and live frames may flow.
  final bool ready;
}

abstract interface class PeerLinkHandle {
  /// An error ends the link; close the channel and redial.
  Future<PeerLinkOutput> handle(Uint8List frame);

  /// The `SYNC` frame to send about every two seconds once ready (null before).
  Future<Uint8List?> reconcileFrame();

  /// Waits for a local write the peer may read; throws once closed.
  Future<List<Uint8List>> nextLiveFrames();
  Future<void> close();
}

class OpenedPeerLink {
  const OpenedPeerLink(this.link, this.challenge);
  final PeerLinkHandle link;

  /// The first frame to send.
  final Uint8List challenge;
}

abstract interface class PeerLinkBackend {
  Future<OpenedPeerLink> open({
    required String drive,
    required String binding,
    String? expectedPeer,
  });
}
