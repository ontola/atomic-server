import 'package:atomic_app/atomic/webrtc/framed_transport.dart';
import 'package:atomic_app/atomic/webrtc/peer_identity.dart';
import 'package:atomic_app/atomic/webrtc/peer_link_backend.dart';
import 'package:atomic_app/atomic/webrtc/peer_mesh.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

// Ids order the roles: the smaller id offers.
final _low = List.filled(64, '1').join();
final _mine = List.filled(64, '5').join();
final _high = List.filled(64, 'f').join();
const _drive = 'atomic:abc123';

/// A mesh wired to fakes, with the test as the signalling service and as the
/// remote end of each data channel.
class Rig {
  Rig({
    FakeLink Function()? link,
    this.expectedPeer,
    this.ice,
  }) {
    backend = FakeBackend(
        link ?? () => FakeLink((frame) async => const PeerLinkOutput()));
  }

  final String? expectedPeer;
  final List<Map<String, dynamic>>? ice;
  late final FakeBackend backend;
  final sockets = <FakeSignalingSocket>[];
  final connections = <FakeConnection>[];
  final statuses = <String>[];
  late final WebRtcPeerMesh mesh;

  FakeSignalingSocket get socket => sockets.last;

  void build() {
    mesh = WebRtcPeerMesh(
      drive: _drive,
      signalingUrl: Uri.parse('wss://example.com/webrtc-signal'),
      backend: backend,
      peerId: _mine,
      expectedPeer: expectedPeer,
      iceServers: ice,
      connect: (servers) async {
        final connection = FakeConnection(servers);
        connections.add(connection);
        return connection;
      },
      signaling: (url) async {
        final socket = FakeSignalingSocket();
        sockets.add(socket);
        return socket;
      },
      onStatus: statuses.add,
      reconnectDelay: const Duration(milliseconds: 20),
      reconcileEvery: const Duration(milliseconds: 20),
      authTimeout: const Duration(milliseconds: 200),
      firstRetry: const Duration(milliseconds: 30),
    );
  }

  Future<void> start() async {
    build();
    mesh.start();
    await eventually(() => sockets.isNotEmpty && socket.sent.isNotEmpty,
        reason: 'the join');
  }

  List<Map<String, dynamic>> sent(String type) => [
        for (final m in socket.sent)
          if (m['type'] == type) m
      ];
}

void main() {
  test('joins the drive room with its own peer id', () async {
    final rig = Rig();
    await rig.start();
    expect(rig.socket.sent.single, {
      'type': 'join',
      'room': automaticPeerRoom(_drive),
      'peer': _mine,
    });
    await rig.mesh.close();
  });

  test('offers to a peer with a larger id, not to a smaller one', () async {
    final rig = Rig();
    await rig.start();
    rig.socket.push({
      'type': 'joined',
      'peers': [_low, _high]
    });
    await eventually(() => rig.sent('offer').isNotEmpty, reason: 'an offer');
    final offer = rig.sent('offer').single;
    expect(offer['to'], _high);
    expect(offer['sdp'], contains('a=fingerprint'));
    expect(rig.connections, hasLength(1));
    await rig.mesh.close();
  });

  test('answers an offer from a smaller id, ignores one from a larger',
      () async {
    final rig = Rig();
    await rig.start();
    rig.socket.push({
      'type': 'joined',
      'peers': [_low, _high]
    });
    await eventually(() => rig.connections.isNotEmpty);
    rig.socket.push({'type': 'offer', 'from': _low, 'sdp': 'OFFER-LOW'});
    await eventually(() => rig.sent('answer').isNotEmpty, reason: 'an answer');
    expect(rig.sent('answer').single['to'], _low);
    expect(rig.connections.last.calls, ['acceptOffer:OFFER-LOW']);
    // A larger id never sends offers: it is the one that is dialled.
    rig.socket.push({'type': 'offer', 'from': _high, 'sdp': 'OFFER-HIGH'});
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(rig.sent('answer'), hasLength(1));
    await rig.mesh.close();
  });

  test('an offer from someone not in the room is ignored', () async {
    final rig = Rig();
    await rig.start();
    rig.socket.push({'type': 'joined', 'peers': <String>[]});
    rig.socket.push({'type': 'offer', 'from': _low, 'sdp': 'OFFER'});
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(rig.connections, isEmpty);
    await rig.mesh.close();
  });

  test('hands the ICE servers of the service to each connection', () async {
    final rig = Rig();
    await rig.start();
    rig.socket.push({
      'type': 'joined',
      'peers': [_high],
      'iceServers': [
        {
          'urls': ['stun:stun.example:3478']
        }
      ],
    });
    await eventually(() => rig.connections.isNotEmpty);
    expect(rig.connections.single.iceServers.single['urls'],
        ['stun:stun.example:3478']);
    await rig.mesh.close();
  });

  test('configured ICE servers win over the service', () async {
    final rig = Rig(ice: [
      {'urls': 'turn:turn.example'}
    ]);
    await rig.start();
    rig.socket.push({
      'type': 'joined',
      'peers': [_high],
      'iceServers': [
        {'urls': 'stun:ignored'}
      ],
    });
    await eventually(() => rig.connections.isNotEmpty);
    expect(
        rig.connections.single.iceServers.single['urls'], 'turn:turn.example');
    await rig.mesh.close();
  });

  test('a ninth member is refused: the signalling socket is dropped', () async {
    final rig = Rig();
    await rig.start();
    rig.socket.push({'type': 'joined', 'peers': List.filled(8, _high)});
    await eventually(() => rig.socket.closed, reason: 'the socket to close');
    expect(rig.connections, isEmpty);
    await rig.mesh.close();
  });

  test('redials the signalling service after it hangs up', () async {
    final rig = Rig();
    await rig.start();
    await rig.socket.hangUp();
    await eventually(() => rig.sockets.length == 2, reason: 'a second socket');
    await eventually(() => rig.sockets.last.sent.isNotEmpty);
    expect(rig.sockets.last.sent.single['type'], 'join');
    await rig.mesh.close();
  });

  group('over an open channel', () {
    late Rig rig;
    late FakeLink link;
    late MemoryPipe remotePipe;
    late FramedTransport remote;

    /// The link becomes ready once the peer's frame 0x02 arrives; it then
    /// answers with a frame of its own.
    Future<void> connect({PeerLinkOutput? Function(Uint8List)? onFrame}) async {
      link = FakeLink((frame) async {
        final custom = onFrame?.call(frame);
        if (custom != null) return custom;
        return frame.first == 0x02
            ? PeerLinkOutput(frames: [
                Uint8List.fromList([0x10])
              ], ready: true)
            : const PeerLinkOutput();
      })
        ..reconcile = Uint8List.fromList([0x30, 9]);
      rig = Rig(link: () => link, expectedPeer: 'atomic:agent:x');
      await rig.start();
      rig.socket.push({
        'type': 'joined',
        'peers': [_high]
      });
      await eventually(() => rig.sent('offer').isNotEmpty);
      final answer = fingerprintSdp('answer', 'BB:22');
      rig.socket.push({'type': 'answer', 'from': _high, 'sdp': answer});
      await eventually(
          () => rig.connections.single.calls.contains('acceptAnswer:$answer'));
      final (local, other) = MemoryPipe.pair();
      remotePipe = other;
      remote = FramedTransport(remotePipe);
      rig.connections.single.open(local);
      await eventually(() => rig.backend.opened.isNotEmpty, reason: 'the link');
    }

    tearDown(() async {
      await remote.close();
      await rig.mesh.close();
    });

    test(
        'opens the Rust link bound to both certificates and sends the '
        'challenge first', () async {
      await connect();
      final opened = rig.backend.opened.single;
      expect(opened.drive, _drive);
      expect(opened.expectedPeer, 'atomic:agent:x');
      expect(opened.binding, hasLength(64));
      expect(await remote.recv(), FakeBackend.challenge);
    });

    test('feeds every received frame to the link and sends its replies',
        () async {
      await connect();
      await remote.recv();
      await remote.send(Uint8List.fromList([0x01, 5]));
      await remote.send(Uint8List.fromList([0x02]));
      expect(await remote.recv(), [0x10]);
      expect(link.handled.map((f) => f.first), [0x01, 0x02]);
    });

    test('once ready it reconciles on a timer and says it is connected',
        () async {
      await connect();
      await remote.recv();
      await remote.send(Uint8List.fromList([0x02]));
      expect(await remote.recv(), [0x10]);
      // At least two reconcile frames: the first at once, then the timer.
      expect(await remote.recv(), [0x30, 9]);
      expect(await remote.recv(), [0x30, 9]);
      await eventually(() => rig.statuses.contains('Connected to 1 peer'));
      expect(rig.mesh.connectedPeers, 1);
    });

    test('a live frame from the link goes straight to the peer', () async {
      await connect();
      await remote.recv();
      await remote.send(Uint8List.fromList([0x02]));
      await eventually(() => rig.mesh.connectedPeers == 1);
      link.live([
        Uint8List.fromList([0x20, 1, 2, 3])
      ]);
      Uint8List? frame;
      while ((frame = await remote.recv()) != null) {
        if (frame!.first == 0x20) break;
      }
      expect(frame, [0x20, 1, 2, 3]);
    });

    test('a frame the link rejects drops the connection and redials that peer',
        () async {
      await connect(onFrame: (f) => f.first == 0x66 ? throw 'bad frame' : null);
      await remote.recv();
      await remote.send(Uint8List.fromList([0x66]));
      await eventually(() => link.closed || rig.connections.first.closed,
          reason: 'the connection to close');
      expect(rig.statuses.any((s) => s.contains('bad frame')), isTrue);
      // Backoff, then a fresh offer to the same peer.
      await eventually(() => rig.sent('offer').length == 2,
          reason: 'a second offer');
      expect(rig.connections, hasLength(2));
    });

    test('a closed link logs why and stops polling', () async {
      final logs = <String>[];
      final original = debugPrint;
      debugPrint = (message, {wrapWidth}) => logs.add(message ?? '');
      addTearDown(() => debugPrint = original);
      await connect();
      await remote.recv();
      await remote.send(Uint8List.fromList([0x02]));
      await eventually(() => rig.mesh.connectedPeers == 1);
      await eventually(() => link.reconcileCalls >= 2, reason: 'the timer');
      await remote.close();
      await eventually(() => rig.mesh.connectedPeers == 0);
      expect(
          logs.any((l) =>
              l.startsWith('[webrtc] peer ${_high.substring(0, 8)} closed: ') &&
              l.contains('Peer disconnected')),
          isTrue,
          reason: logs.join('\n'));
      // No timer or loop touches the dead link: the count settles.
      await Future<void>.delayed(const Duration(milliseconds: 60));
      final settled = link.reconcileCalls;
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(link.reconcileCalls, settled);
    });

    test('a peer that never authenticates is dropped after the timeout',
        () async {
      await connect();
      await remote.recv();
      await eventually(() => rig.statuses.any((s) => s.contains('timed out')),
          reason: 'the timeout');
    });

    test('the peer closing the channel ends the connection', () async {
      await connect();
      await remote.recv();
      await remote.send(Uint8List.fromList([0x02]));
      await eventually(() => rig.mesh.connectedPeers == 1);
      await remote.close();
      await eventually(() => rig.mesh.connectedPeers == 0);
      expect(rig.statuses.any((s) => s.contains('Peer disconnected')), isTrue);
    });

    test('closing the mesh closes the link, the connection and the socket',
        () async {
      await connect();
      await remote.recv();
      await remote.send(Uint8List.fromList([0x02]));
      await eventually(() => rig.mesh.connectedPeers == 1);
      await rig.mesh.close();
      expect(link.closed, isTrue);
      expect(rig.connections.single.closed, isTrue);
      expect(rig.socket.closed, isTrue);
      expect(rig.statuses.last, 'Disconnected');
    });
  });
}
