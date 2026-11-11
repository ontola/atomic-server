import 'package:atomic_app/atomic/webrtc/signaling_client.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

final _room = List.filled(64, 'a').join();
final _me = List.filled(64, '1').join();
final _other = List.filled(64, '2').join();

void main() {
  late FakeSignalingSocket socket;
  late SignalingClient client;
  late List<SignalingEvent> events;

  setUp(() async {
    socket = FakeSignalingSocket();
    client = SignalingClient(
      url: Uri.parse('wss://example.com/webrtc-signal'),
      room: _room,
      peerId: _me,
      connector: (url) async => socket,
    );
    events = [];
    client.events.listen(events.add);
    await client.connect();
  });

  tearDown(() => client.close());

  test('joins the room with the message the web sends', () {
    expect(socket.sent, [
      {'type': 'join', 'room': _room, 'peer': _me}
    ]);
  });

  test('the room secret is not in the URL', () {
    expect(client.url.toString(), isNot(contains(_room)));
  });

  test('joined carries the other peers and the ICE servers', () async {
    socket.push({
      'type': 'joined',
      'peers': [_other],
      'iceServers': [
        {
          'urls': ['stun:stun.cloudflare.com:3478']
        }
      ],
    });
    await eventually(() => events.isNotEmpty);
    final joined = events.single as SignalingJoined;
    expect(joined.peers, [_other]);
    expect(
        joined.iceServers!.single['urls'], ['stun:stun.cloudflare.com:3478']);
  });

  test('joined without ICE servers leaves them to the caller', () async {
    socket.push({'type': 'joined', 'peers': <String>[]});
    await eventually(() => events.isNotEmpty);
    expect((events.single as SignalingJoined).iceServers, isNull);
  });

  test('peer, left, offer and answer', () async {
    socket.push({'type': 'peer', 'peer': _other});
    socket.push({'type': 'offer', 'from': _other, 'sdp': 'OFFER'});
    socket.push({'type': 'answer', 'from': _other, 'sdp': 'ANSWER'});
    socket.push({'type': 'left', 'peer': _other});
    await eventually(() => events.length == 4);
    expect((events[0] as SignalingPeerArrived).peer, _other);
    expect((events[1] as SignalingOffer).sdp, 'OFFER');
    expect((events[1] as SignalingOffer).from, _other);
    expect((events[2] as SignalingAnswer).sdp, 'ANSWER');
    expect((events[3] as SignalingPeerLeft).peer, _other);
  });

  test('offers and answers are sent addressed with "to"', () {
    client.sendOffer(_other, 'OFFER');
    client.sendAnswer(_other, 'ANSWER');
    expect(socket.sent.skip(1), [
      {'type': 'offer', 'to': _other, 'sdp': 'OFFER'},
      {'type': 'answer', 'to': _other, 'sdp': 'ANSWER'},
    ]);
  });

  test('an unknown message type is ignored', () async {
    socket.push({'type': 'pong'});
    socket.push({'type': 'peer', 'peer': _other});
    await eventually(() => events.isNotEmpty);
    expect(events.single, isA<SignalingPeerArrived>());
  });

  for (final entry in {
    'more than seven peers': {
      'type': 'joined',
      'peers': List.filled(8, _other)
    },
    'a peer id that is not 64 hex': {'type': 'peer', 'peer': 'nope'},
    'an offer without an SDP': {'type': 'offer', 'from': _other},
    'text that is not JSON': 'not json',
    'JSON that is not an object': '[1,2]',
  }.entries) {
    test('${entry.key} ends the socket with an error', () async {
      socket.push(entry.value);
      await eventually(() => events.isNotEmpty);
      final closed = events.single as SignalingClosed;
      expect(closed.error, isNotNull);
      await eventually(() => socket.closed);
    });
  }

  test('a message over 64 KiB is refused', () async {
    socket.push('{"type":"peer","peer":"$_other","pad":"${'x' * 70000}"}');
    await eventually(() => events.isNotEmpty);
    expect((events.single as SignalingClosed).error, isNotNull);
  });

  test('the service hanging up is a plain close', () async {
    await socket.hangUp();
    await eventually(() => events.isNotEmpty);
    expect((events.single as SignalingClosed).error, isNull);
    expect(() => client.sendOffer(_other, 'x'), throwsStateError);
  });

  test('refuses a room or peer id that is not 64 hex', () {
    expect(
        () => SignalingClient(
            url: Uri.parse('wss://x/y'), room: 'short', peerId: _me),
        throwsArgumentError);
    expect(
        () => SignalingClient(
            url: Uri.parse('wss://x/y'), room: _room, peerId: 'short'),
        throwsArgumentError);
  });
}
