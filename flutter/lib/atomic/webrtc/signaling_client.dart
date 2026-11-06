/// The signalling socket of a peer room: join, learn who is there, and trade
/// offers and answers. The wire format is the web's (`BrowserPeerSync`,
/// `browser/lib/src/browser-peer-sync.ts`), JSON text frames:
///
///   → `{type:'join', room, peer}`
///   ← `{type:'joined', peers:[id…], iceServers?:[…]}`
///   ← `{type:'peer', peer}`  /  `{type:'left', peer}`
///   ↔ `{type:'offer'|'answer', to, sdp}` (arrives with `from` instead of `to`)
///
/// The room secret travels in the join message, never in the URL. The service
/// introduces peers and keeps no data; it is not trusted with anything.
library;

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'peer_identity.dart';

/// Most peers a room lists, and so the most connections a node keeps: a full
/// mesh of eight.
const maxRoomPeers = 7;

/// A signalling message is a few kilobytes of SDP; the web refuses more.
const maxSignalingMessageChars = 64 * 1024;

/// One open text socket. A seam so tests drive the client without a network.
abstract interface class SignalingSocket {
  /// Incoming text frames; completes when the socket closes.
  Stream<Object?> get messages;
  void send(String text);
  Future<void> close();
}

typedef SignalingConnector = Future<SignalingSocket> Function(Uri url);

class _WebSocketSignalingSocket implements SignalingSocket {
  _WebSocketSignalingSocket(this._channel);
  final WebSocketChannel _channel;

  @override
  Stream<Object?> get messages => _channel.stream;
  @override
  void send(String text) => _channel.sink.add(text);
  @override
  Future<void> close() async => _channel.sink.close();
}

Future<SignalingSocket> connectWebSocket(Uri url) async {
  final channel = WebSocketChannel.connect(url);
  await channel.ready;
  return _WebSocketSignalingSocket(channel);
}

sealed class SignalingEvent {
  const SignalingEvent();
}

/// We are in the room; [peers] are the others already there.
class SignalingJoined extends SignalingEvent {
  const SignalingJoined(this.peers, this.iceServers);
  final List<String> peers;

  /// STUN/TURN servers the service hands out (`[{urls, username?,
  /// credential?}]`), or null when it sent none.
  final List<Map<String, dynamic>>? iceServers;
}

class SignalingPeerArrived extends SignalingEvent {
  const SignalingPeerArrived(this.peer);
  final String peer;
}

class SignalingPeerLeft extends SignalingEvent {
  const SignalingPeerLeft(this.peer);
  final String peer;
}

class SignalingOffer extends SignalingEvent {
  const SignalingOffer(this.from, this.sdp);
  final String from;
  final String sdp;
}

class SignalingAnswer extends SignalingEvent {
  const SignalingAnswer(this.from, this.sdp);
  final String from;
  final String sdp;
}

/// The socket ended, or the service sent something invalid and the client
/// dropped it. [error] is null for a plain close.
class SignalingClosed extends SignalingEvent {
  const SignalingClosed([this.error]);
  final Object? error;
}

class SignalingClient {
  SignalingClient({
    required this.url,
    required this.room,
    required this.peerId,
    SignalingConnector? connector,
  }) : _connector = connector ?? connectWebSocket {
    if (!isPeerToken(room)) throw ArgumentError.value(room, 'room');
    if (!isPeerToken(peerId)) throw ArgumentError.value(peerId, 'peerId');
  }

  final Uri url;
  final String room;
  final String peerId;
  final SignalingConnector _connector;
  final _events = StreamController<SignalingEvent>.broadcast();
  SignalingSocket? _socket;
  StreamSubscription<Object?>? _subscription;
  bool _closed = false;

  Stream<SignalingEvent> get events => _events.stream;

  /// Opens the socket and joins the room. Throws when it cannot connect.
  Future<void> connect() async {
    final socket = await _connector(url);
    if (_closed) {
      await socket.close();
      return;
    }
    _socket = socket;
    _subscription = socket.messages.listen(
      _onMessage,
      onError: (Object error) => _end(error),
      onDone: () => _end(null),
    );
    socket.send(jsonEncode({'type': 'join', 'room': room, 'peer': peerId}));
  }

  void sendOffer(String to, String sdp) =>
      _send({'type': 'offer', 'to': to, 'sdp': sdp});

  void sendAnswer(String to, String sdp) =>
      _send({'type': 'answer', 'to': to, 'sdp': sdp});

  void _send(Map<String, Object?> message) {
    final socket = _socket;
    if (socket == null || _closed) throw StateError('Discovery unavailable');
    socket.send(jsonEncode(message));
  }

  void _onMessage(Object? data) {
    if (_closed) return;
    try {
      if (data is! String || data.length > maxSignalingMessageChars) {
        throw const FormatException('Invalid signaling response');
      }
      final message = jsonDecode(data);
      if (message is! Map) {
        throw const FormatException('Invalid signaling response');
      }
      final event = _decode(message);
      if (event != null) _events.add(event);
    } catch (error) {
      // Like the web: anything malformed ends the socket, the caller redials.
      _end(error);
    }
  }

  SignalingEvent? _decode(Map<dynamic, dynamic> message) {
    switch (message['type']) {
      case 'joined':
        final peers = message['peers'];
        if (peers is! List || peers.length > maxRoomPeers) {
          throw const FormatException('Invalid peer list');
        }
        final ice = message['iceServers'];
        return SignalingJoined(
          [for (final id in peers) _peer(id)],
          ice is List
              ? [
                  for (final server in ice)
                    if (server is Map) Map<String, dynamic>.from(server),
                ]
              : null,
        );
      case 'peer':
        return SignalingPeerArrived(_peer(message['peer']));
      case 'left':
        return SignalingPeerLeft(_peer(message['peer']));
      case 'offer':
        return SignalingOffer(_peer(message['from']), _sdp(message['sdp']));
      case 'answer':
        return SignalingAnswer(_peer(message['from']), _sdp(message['sdp']));
    }
    return null;
  }

  String _peer(Object? id) {
    if (!isPeerToken(id)) throw const FormatException('Invalid peer identity');
    return id! as String;
  }

  String _sdp(Object? sdp) {
    if (sdp is! String || sdp.isEmpty) {
      throw const FormatException('Invalid SDP');
    }
    return sdp;
  }

  void _end(Object? error) {
    if (_closed) return;
    _closed = true;
    _events.add(SignalingClosed(error));
    unawaited(_teardown());
  }

  Future<void> _teardown() async {
    await _subscription?.cancel();
    try {
      await _socket?.close();
    } catch (_) {}
    await _events.close();
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _teardown();
  }
}
