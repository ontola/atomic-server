/// [PeerConnectionHandle] on the platform's WebRTC stack (`flutter_webrtc`).
/// The Dart twin of `browser/lib/src/webrtc-peer.ts`: explicit, non-trickle
/// offer/answer (the SDP carries every ICE candidate), one ordered, reliable
/// data channel labelled `atomic-sync` with the protocol the web checks.
///
/// This establishes transport, not authority: the Atomic handshake over the
/// channel decides who may read or write what.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'framed_transport.dart';
import 'peer_connection.dart';

/// How long pairing may take before the route is called missing.
const _pairingTimeout = Duration(seconds: 60);

/// A device behind a strict NAT may never finish gathering; go with what there is.
const _gatheringTimeout = Duration(seconds: 10);

const _noRoute =
    'Could not open a direct connection (no route between the two devices)';

class FlutterWebRtcConnection implements PeerConnectionHandle {
  FlutterWebRtcConnection._(this._connection, Duration timeout) {
    _timer = Timer(timeout, () => _fail(Exception(_noRoute)));
    _pipe.future.ignore();
    _connection.onDataChannel = _attach;
    _connection.onIceGatheringState = (state) {
      if (state == RTCIceGatheringState.RTCIceGatheringStateComplete &&
          !_gathered.isCompleted) {
        _gathered.complete();
      }
    };
    _connection.onConnectionState = (state) {
      if (_closed) return;
      debugPrint('[webrtc] connection state $state');
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _fail(Exception(_noRoute));
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _fail(Exception('WebRTC connection closed'));
      }
    };
  }

  /// [iceServers] as the signalling service sends them: `[{urls, username?,
  /// credential?}]`.
  static Future<FlutterWebRtcConnection> create(
    List<Map<String, dynamic>> iceServers, {
    Duration timeout = _pairingTimeout,
  }) async {
    final connection = await createPeerConnection({
      'iceServers': iceServers,
      'sdpSemantics': 'unified-plan',
    });
    return FlutterWebRtcConnection._(connection, timeout);
  }

  final RTCPeerConnection _connection;
  final _pipe = Completer<DataPipe>();
  final _gathered = Completer<void>();

  /// Completes when this connection closes, to cut short a wait for ICE
  /// gathering (the web's `cancelGathering`).
  final _closing = Completer<void>();
  late final Timer _timer;
  RTCDataChannel? _channel;
  _DataChannelPipe? _wrapped;
  bool _closed = false;
  bool _logged = false;
  String? _local;
  String? _remote;

  @override
  String? get localSdp => _local;
  @override
  String? get remoteSdp => _remote;
  @override
  Future<DataPipe> get pipe => _pipe.future;

  @override
  Future<String> createOffer() async {
    _ensureOpen();
    final channel = await _connection.createDataChannel(
      dataChannelLabel,
      RTCDataChannelInit()
        ..ordered = true
        ..protocol = dataChannelProtocol
        ..binaryType = 'binary',
    );
    _attach(channel);
    return _describe(await _connection.createOffer());
  }

  @override
  Future<String> acceptOffer(String sdp) async {
    _ensureOpen();
    await _connection.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
    _remote = sdp;
    return _describe(await _connection.createAnswer());
  }

  @override
  Future<void> acceptAnswer(String sdp) async {
    _ensureOpen();
    await _connection
        .setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
    _remote = sdp;
  }

  /// Nothing may touch the native connection once it is closed: the plugin
  /// logs `peerConnection is null` for every such call.
  void _ensureOpen() {
    if (_closed) throw StateError('WebRTC pairing closed');
  }

  Future<String> _describe(RTCSessionDescription description) async {
    _ensureOpen();
    await _connection.setLocalDescription(description);
    _ensureOpen();
    final state = await _connection.getIceGatheringState();
    if (state == RTCIceGatheringState.RTCIceGatheringStateComplete &&
        !_gathered.isCompleted) {
      _gathered.complete();
    }
    await Future.any([_gathered.future, _closing.future])
        .timeout(_gatheringTimeout, onTimeout: () {});
    _ensureOpen();
    final local = await _connection.getLocalDescription();
    final sdp = local?.sdp;
    if (sdp == null || sdp.isEmpty) {
      throw StateError('Missing WebRTC local description');
    }
    return _local = sdp;
  }

  void _attach(RTCDataChannel channel) {
    // The web refuses a second channel or one it did not label.
    if (_channel != null || _closed || channel.label != dataChannelLabel) {
      unawaited(channel.close());
      _fail(Exception('Unexpected WebRTC data channel'));
      return;
    }
    _channel = channel;
    final wrapped = _wrapped = _DataChannelPipe(channel);
    void opened() {
      if (_closed || _pipe.isCompleted) return;
      _timer.cancel();
      _pipe.complete(wrapped);
    }

    wrapped.onState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        opened();
      } else if (state == RTCDataChannelState.RTCDataChannelClosed) {
        _fail(Exception('WebRTC data channel closed'));
      }
    };
    if (channel.state == RTCDataChannelState.RTCDataChannelOpen) opened();
  }

  void _fail(Exception error) {
    if (_closed) return;
    debugPrint('[webrtc] link closing: $error');
    _logged = true;
    if (!_pipe.isCompleted) _pipe.completeError(error);
    // An open channel that dies ends through its message stream.
    unawaited(close());
  }

  @override
  Future<ConnectionPath> path() async {
    if (_closed) return ConnectionPath.unknown;
    try {
      final reports = await _connection.getStats();
      final byId = {for (final r in reports) r.id: r};
      for (final report in reports) {
        if (report.type != 'candidate-pair') continue;
        final values = report.values;
        if (values['state'] != 'succeeded' || values['nominated'] != true) {
          continue;
        }
        final local = byId['${values['localCandidateId']}']?.values;
        final remote = byId['${values['remoteCandidateId']}']?.values;
        return local?['candidateType'] == 'relay' ||
                remote?['candidateType'] == 'relay'
            ? ConnectionPath.relayed
            : ConnectionPath.direct;
      }
    } catch (_) {}
    return ConnectionPath.unknown;
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    if (!_logged) debugPrint('[webrtc] link closed by this device');
    if (!_closing.isCompleted) _closing.complete();
    _timer.cancel();
    if (!_pipe.isCompleted) {
      _pipe.completeError(Exception('WebRTC peer closed'));
    }
    await _wrapped?.close();
    try {
      await _connection.close();
      await _connection.dispose();
    } catch (_) {}
  }
}

class _DataChannelPipe implements DataPipe {
  _DataChannelPipe(this._channel) {
    _channel.bufferedAmountLowThreshold = sendHighWater ~/ 2;
    _channel.onMessage = (message) {
      // The framing is binary only; a text message is a protocol violation
      // the transport reports as a truncated or invalid frame.
      if (message.isBinary && !_messages.isClosed) {
        _messages.add(message.binary);
      } else if (!_messages.isClosed) {
        _messages.addError(Exception('Expected binary Atomic frame'));
      }
    };
    _channel.onBufferedAmountChange = (current, _) {
      _buffered = current;
    };
    _channel.onBufferedAmountLow = (current) {
      _buffered = current;
      _lowWater?.complete();
    };
    _channel.onDataChannelState = (state) {
      onState?.call(state);
      if (state == RTCDataChannelState.RTCDataChannelClosed) _shutdown();
    };
  }

  final RTCDataChannel _channel;
  final _messages = StreamController<Uint8List>();
  Completer<void>? _lowWater;
  int _buffered = 0;
  void Function(RTCDataChannelState state)? onState;

  @override
  Stream<Uint8List> get messages => _messages.stream;

  @override
  int get bufferedAmount => _buffered;

  @override
  Future<void> send(Uint8List message) =>
      _channel.send(RTCDataChannelMessage.fromBinary(message));

  @override
  Future<void> drained() async {
    final low = _lowWater = Completer<void>();
    // The callback can be missed on a platform that does not raise it; look again.
    await low.future
        .timeout(const Duration(milliseconds: 250), onTimeout: () {});
    _lowWater = null;
    try {
      _buffered = await _channel.getBufferedAmount();
    } catch (_) {}
  }

  void _shutdown() {
    if (!_messages.isClosed) unawaited(_messages.close());
    _lowWater?.complete();
  }

  @override
  Future<void> close() async {
    _shutdown();
    try {
      await _channel.close();
    } catch (_) {}
  }
}
