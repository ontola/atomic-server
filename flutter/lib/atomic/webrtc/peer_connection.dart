/// One WebRTC connection to one peer, as the mesh needs it. The mesh and its
/// tests see only this interface; `flutter_webrtc_connection.dart` is the real
/// one, on the platform's WebRTC stack.
library;

import 'framed_transport.dart';

/// What the selected network path is, for the status line.
enum ConnectionPath { direct, relayed, unknown }

/// The data channel's label and protocol, which the web checks on arrival.
const dataChannelLabel = 'atomic-sync';
const dataChannelProtocol = 'atomic-sync-v2-framed-v1';

abstract interface class PeerConnectionHandle {
  /// Opens the channel and returns the offer once ICE gathering is complete
  /// (non-trickle: the SDP carries every candidate).
  Future<String> createOffer();

  /// Takes the remote offer and returns the answer, gathering complete.
  Future<String> acceptOffer(String sdp);
  Future<void> acceptAnswer(String sdp);

  /// Both descriptions, once set; the channel binding is computed from them.
  String? get localSdp;
  String? get remoteSdp;

  /// The open channel. Completes when it opens; fails if the connection fails
  /// or no route is found in time.
  Future<DataPipe> get pipe;

  Future<ConnectionPath> path();
  Future<void> close();
}

/// Makes a connection with the given ICE servers (`[{urls, username?,
/// credential?}]`).
typedef PeerConnectionFactory = Future<PeerConnectionHandle> Function(
    List<Map<String, dynamic>> iceServers);
