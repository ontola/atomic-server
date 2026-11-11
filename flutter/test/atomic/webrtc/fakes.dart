import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_app/atomic/webrtc/framed_transport.dart';
import 'package:atomic_app/atomic/webrtc/peer_connection.dart';
import 'package:atomic_app/atomic/webrtc/peer_link_backend.dart';
import 'package:atomic_app/atomic/webrtc/signaling_client.dart';

/// A signalling socket the test speaks for: [push] is the service talking,
/// [sent] is what the client wrote, decoded.
class FakeSignalingSocket implements SignalingSocket {
  final _incoming = StreamController<Object?>();
  final sent = <Map<String, dynamic>>[];
  bool closed = false;

  @override
  Stream<Object?> get messages => _incoming.stream;

  @override
  void send(String text) => sent.add(jsonDecode(text) as Map<String, dynamic>);

  void push(Object? message) =>
      _incoming.add(message is String ? message : jsonEncode(message));

  Future<void> hangUp() => _incoming.close();

  @override
  Future<void> close() async {
    closed = true;
    if (!_incoming.isClosed) await _incoming.close();
  }
}

/// One end of an in-memory data channel pair.
class MemoryPipe implements DataPipe {
  MemoryPipe._(this._out, this._in);
  final StreamController<Uint8List> _out;
  final StreamController<Uint8List> _in;
  final sentMessages = <Uint8List>[];
  int buffered = 0;

  static (MemoryPipe, MemoryPipe) pair() {
    final a = StreamController<Uint8List>();
    final b = StreamController<Uint8List>();
    return (MemoryPipe._(a, b), MemoryPipe._(b, a));
  }

  @override
  Stream<Uint8List> get messages => _in.stream;

  @override
  Future<void> send(Uint8List message) async {
    sentMessages.add(Uint8List.fromList(message));
    _out.add(Uint8List.fromList(message));
  }

  @override
  int get bufferedAmount => buffered;

  @override
  Future<void> drained() async {
    buffered = 0;
  }

  @override
  Future<void> close() async {
    if (!_out.isClosed) await _out.close();
  }
}

String fingerprintSdp(String name, String fingerprint) =>
    'v=0\r\no=$name\r\na=fingerprint:sha-256 $fingerprint\r\nm=application\r\n';

/// A WebRTC connection that does no networking: the test opens its channel.
class FakeConnection implements PeerConnectionHandle {
  FakeConnection(this.iceServers);
  final List<Map<String, dynamic>> iceServers;
  final _pipe = Completer<DataPipe>();
  final calls = <String>[];
  bool closed = false;
  String? _local;
  String? _remote;

  @override
  String? get localSdp => _local;
  @override
  String? get remoteSdp => _remote;
  @override
  Future<DataPipe> get pipe => _pipe.future;

  /// The channel opens: [local] is this device's end.
  void open(DataPipe local) => _pipe.complete(local);
  void failToOpen(Object error) => _pipe.completeError(error);

  @override
  Future<String> createOffer() async {
    calls.add('createOffer');
    return _local = fingerprintSdp('offer', 'AA:11');
  }

  @override
  Future<String> acceptOffer(String sdp) async {
    calls.add('acceptOffer:$sdp');
    _remote = sdp;
    return _local = fingerprintSdp('answer', 'BB:22');
  }

  @override
  Future<void> acceptAnswer(String sdp) async {
    calls.add('acceptAnswer:$sdp');
    _remote = sdp;
  }

  @override
  Future<ConnectionPath> path() async => ConnectionPath.direct;

  @override
  Future<void> close() async {
    closed = true;
  }
}

/// The Rust link, played by the test.
class FakeLink implements PeerLinkHandle {
  FakeLink(this.onFrame);
  final Future<PeerLinkOutput> Function(Uint8List frame) onFrame;
  final handled = <Uint8List>[];
  final _live = <Completer<List<Uint8List>>>[];
  Uint8List? reconcile;
  int reconcileCalls = 0;
  bool closed = false;

  @override
  Future<PeerLinkOutput> handle(Uint8List frame) {
    handled.add(frame);
    return onFrame(frame);
  }

  @override
  Future<Uint8List?> reconcileFrame() async {
    reconcileCalls++;
    return reconcile;
  }

  @override
  Future<List<Uint8List>> nextLiveFrames() {
    if (closed) return Future.error(StateError('Peer link closed'));
    final next = Completer<List<Uint8List>>();
    _live.add(next);
    return next.future;
  }

  void live(List<Uint8List> frames) {
    if (_live.isNotEmpty) _live.removeAt(0).complete(frames);
  }

  @override
  Future<void> close() async {
    closed = true;
    for (final waiting in _live) {
      waiting.completeError(StateError('Peer link closed'));
    }
    _live.clear();
  }
}

class FakeBackend implements PeerLinkBackend {
  FakeBackend(this.makeLink);
  final FakeLink Function() makeLink;
  final opened = <({String drive, String binding, String? expectedPeer})>[];
  final links = <FakeLink>[];
  static final challenge = Uint8List.fromList([0x42, 1, 2, 3]);

  @override
  Future<OpenedPeerLink> open({
    required String drive,
    required String binding,
    String? expectedPeer,
  }) async {
    opened.add((drive: drive, binding: binding, expectedPeer: expectedPeer));
    final link = makeLink();
    links.add(link);
    return OpenedPeerLink(link, challenge);
  }
}

/// Waits (polling) until [test] holds, failing after [timeout].
Future<void> eventually(bool Function() test,
    {Duration timeout = const Duration(seconds: 3), String? reason}) async {
  final end = DateTime.now().add(timeout);
  while (!test()) {
    if (DateTime.now().isAfter(end)) {
      throw StateError('Timed out waiting for ${reason ?? 'a condition'}');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}
