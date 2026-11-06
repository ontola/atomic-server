/// A drive's peer room, from this device's side: the Dart twin of the web's
/// `BrowserPeerSync` (`browser/lib/src/browser-peer-sync.ts`).
///
/// It joins the room every member of the drive meets in, and keeps one
/// authenticated connection to each other member (a full mesh of up to eight).
/// Connections are made with a deterministic initiator, the peer with the
/// smaller id, so two members never send offers at each other at once. What
/// crosses a connection is decided by the Rust link ([PeerLinkBackend]): this
/// class moves bytes and keeps the connections alive.
///
/// A failed connection retries only that peer, with a doubling delay. Frames
/// received are never rebroadcast; the periodic reconcile carries stored state
/// to anyone who missed a live frame.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'framed_transport.dart';
import 'peer_connection.dart';
import 'peer_identity.dart';
import 'peer_link_backend.dart';
import 'signaling_client.dart';

class WebRtcPeerMesh {
  WebRtcPeerMesh({
    required this.drive,
    required this.signalingUrl,
    required this.backend,
    required this.connect,
    this.signaling,
    this.iceServers,
    this.expectedPeer,
    this.onStatus,
    this.onChanged,
    String? peerId,
    String? room,
    this.reconnectDelay = const Duration(seconds: 3),
    this.reconcileEvery = const Duration(seconds: 2),
    this.authTimeout = const Duration(seconds: 15),
    this.stableAfter = const Duration(seconds: 30),
    this.firstRetry = const Duration(seconds: 3),
    this.maxRetry = const Duration(seconds: 60),
  })  : peerId = peerId ?? randomPeerToken(),
        room = room ?? automaticPeerRoom(drive);

  final String drive;
  final String room;
  final Uri signalingUrl;
  final PeerLinkBackend backend;
  final PeerConnectionFactory connect;
  final SignalingConnector? signaling;

  /// Overrides the servers the signalling service hands out.
  final List<Map<String, dynamic>>? iceServers;

  /// The agent a drive must come from when this device does not hold it yet.
  final String? expectedPeer;
  final void Function(String status)? onStatus;

  /// Called with the subjects a peer's frame changed on this device, so what
  /// shows them can read the store again.
  final void Function(List<String> subjects)? onChanged;
  final String peerId;
  final Duration reconnectDelay;
  final Duration reconcileEvery;
  final Duration authTimeout;
  final Duration stableAfter;
  final Duration firstRetry;
  final Duration maxRetry;

  final _connections = <String, _Peer>{};
  final _members = <String>{};
  final _retries = <String, Timer>{};
  final _retryDelays = <String, Duration>{};
  final _readyAt = <String, DateTime>{};
  SignalingClient? _client;
  StreamSubscription<SignalingEvent>? _events;
  Timer? _reconnect;
  bool _stopped = false;
  bool _started = false;
  String _lastError = '';
  List<Map<String, dynamic>> _ice = const [];

  /// Peers with an authenticated connection right now.
  int get connectedPeers => _connections.values.where((c) => c.ready).length;

  void start() {
    if (_started) return;
    _started = true;
    unawaited(_connect());
  }

  Future<void> close() async {
    _stopped = true;
    _reconnect?.cancel();
    for (final timer in _retries.values) {
      timer.cancel();
    }
    _retries.clear();
    _retryDelays.clear();
    _readyAt.clear();
    final peers = _connections.values.toList();
    if (peers.isNotEmpty) {
      debugPrint('[webrtc] room closed by this device, closing '
          '${peers.length} peer(s)');
    }
    _connections.clear();
    for (final peer in peers) {
      await peer.close();
    }
    await _events?.cancel();
    await _client?.close();
    onStatus?.call('Disconnected');
  }

  void _status() {
    final connected = connectedPeers;
    onStatus?.call(connected > 0
        ? 'Connected to $connected ${connected == 1 ? 'peer' : 'peers'}'
        : _lastError.isNotEmpty
            ? 'Waiting for a peer (last attempt failed: '
                '${_lastError.length > 120 ? _lastError.substring(0, 120) : _lastError})'
            : 'Waiting for a peer');
  }

  Future<void> _connect() async {
    if (_stopped) return;
    _status();
    final client = SignalingClient(
      url: signalingUrl,
      room: room,
      peerId: peerId,
      connector: signaling,
    );
    _client = client;
    await _events?.cancel();
    _events = client.events.listen((event) => _onEvent(client, event));
    try {
      await client.connect();
    } catch (_) {
      if (_stopped || _client != client) return;
      onStatus?.call('Discovery unavailable; retrying');
      _scheduleReconnect(client);
    }
  }

  void _scheduleReconnect(SignalingClient client) {
    if (_stopped || _client != client) return;
    _reconnect?.cancel();
    _reconnect = Timer(reconnectDelay, () => unawaited(_connect()));
  }

  void _onEvent(SignalingClient client, SignalingEvent event) {
    if (_stopped || _client != client) return;
    try {
      switch (event) {
        case SignalingJoined():
          _ice = iceServers ?? event.iceServers ?? const [];
          _members.clear();
          for (final id in event.peers) {
            _addMember(id);
          }
        case SignalingPeerArrived():
          _addMember(event.peer);
        case SignalingPeerLeft():
          _members.remove(event.peer);
          _retries.remove(event.peer)?.cancel();
          _retryDelays.remove(event.peer);
          // A live data channel can outlast its signalling socket.
          final peer = _connections[event.peer];
          if (peer != null && !peer.ready) {
            _remove(event.peer, peer, 'peer left the room before it was ready');
          }
        case SignalingOffer():
          if (!_members.contains(event.from) ||
              event.from.compareTo(peerId) >= 0) {
            return;
          }
          final existing = _connections[event.from];
          if (existing != null) {
            _remove(event.from, existing, 'replaced by a new offer');
          }
          final peer = _createConnection(event.from);
          unawaited(peer.acceptOffer(event.sdp).then((answer) {
            if (_connections[event.from] == peer) {
              client.sendAnswer(event.from, answer);
            }
          }).catchError((Object error) {
            _failed(event.from, peer, error);
          }));
        case SignalingAnswer():
          final peer = _connections[event.from];
          if (peer != null && event.from.compareTo(peerId) > 0) {
            unawaited(peer.acceptAnswer(event.sdp).catchError(
                (Object error) => _failed(event.from, peer, error)));
          }
        case SignalingClosed():
          if (event.error != null) onStatus?.call('${event.error}');
          _scheduleReconnect(client);
      }
    } catch (error) {
      onStatus?.call('$error');
      unawaited(client.close().then((_) => _scheduleReconnect(client)));
    }
  }

  void _addMember(String id) {
    if (id == peerId) throw const FormatException('Invalid peer identity');
    if (!_members.contains(id) && _members.length >= maxRoomPeers) {
      throw const FormatException('Peer room is full');
    }
    _members.add(id);
    _dial(id);
  }

  void _dial(String id) {
    // The smaller id offers, so two members never offer at each other.
    if (_stopped ||
        id.compareTo(peerId) < 0 ||
        _connections.containsKey(id) ||
        _retries.containsKey(id) ||
        !_members.contains(id)) {
      return;
    }
    final client = _client;
    if (client == null) return;
    final peer = _createConnection(id);
    unawaited(peer.createOffer().then((sdp) {
      if (_connections[id] == peer) client.sendOffer(id, sdp);
    }).catchError((Object error) {
      _failed(id, peer, error);
    }));
  }

  _Peer _createConnection(String id) {
    if (_connections.length >= maxRoomPeers) {
      final stale = _connections.entries
          .where((e) => !_members.contains(e.key))
          .firstOrNull;
      if (stale == null) throw StateError('Peer connection limit reached');
      _remove(
          stale.key, stale.value, 'evicted: not in the room, limit reached');
    }
    final peer = _Peer(
      mesh: this,
      id: id,
      onReady: () {
        _readyAt[id] = DateTime.now();
        _lastError = '';
        _status();
      },
      onFailure: (error) => _failed(id, _connections[id], error),
    );
    _connections[id] = peer;
    peer.begin(_ice);
    return peer;
  }

  void _remove(String id, _Peer peer, [String why = 'removed']) {
    if (_connections[id] != peer) return;
    debugPrint('[webrtc] peer ${id.substring(0, 8)} closed: $why');
    _connections.remove(id);
    // Only a connection that stayed up resets the backoff; one that
    // authenticates and dies within seconds keeps backing off.
    final since = _readyAt.remove(id);
    if (since != null && DateTime.now().difference(since) >= stableAfter) {
      _retryDelays.remove(id);
    }
    unawaited(peer.close());
    _status();
  }

  void _failed(String id, _Peer? peer, Object error) {
    if (_stopped || peer == null || _connections[id] != peer) return;
    _lastError = '$error';
    _remove(id, peer, 'failed: $error');
    onStatus?.call(_lastError);
    if (_members.contains(id) &&
        id.compareTo(peerId) > 0 &&
        !_retries.containsKey(id)) {
      final delay = _retryDelays[id] ?? firstRetry;
      final doubled = delay * 2;
      _retryDelays[id] = doubled > maxRetry ? maxRetry : doubled;
      _retries[id] = Timer(delay, () {
        _retries.remove(id);
        _dial(id);
      });
    }
  }
}

/// One connection to one other member.
class _Peer {
  _Peer({
    required this.mesh,
    required this.id,
    required this.onReady,
    required this.onFailure,
  });

  final WebRtcPeerMesh mesh;
  final String id;
  final void Function() onReady;
  final void Function(Object error) onFailure;

  bool ready = false;
  ConnectionPath path = ConnectionPath.unknown;
  bool _stopped = false;
  bool _started = false;
  late final Future<PeerConnectionHandle> _handle;
  FramedTransport? _transport;
  PeerLinkHandle? _link;
  Timer? _reconcileTimer;
  Timer? _authTimer;
  bool _reconciling = false;

  void begin(List<Map<String, dynamic>> iceServers) {
    _handle = mesh.connect(iceServers);
    unawaited(_handle
        .then((handle) => handle.pipe)
        .then(_run)
        .catchError((Object error) => _fail(error)));
  }

  Future<String> createOffer() async => (await _handle).createOffer();
  Future<String> acceptOffer(String sdp) async =>
      (await _handle).acceptOffer(sdp);
  Future<void> acceptAnswer(String sdp) async =>
      (await _handle).acceptAnswer(sdp);

  void _fail(Object error) {
    if (!_stopped) onFailure(error);
  }

  Future<void> _run(DataPipe pipe) async {
    final handle = await _handle;
    final transport = _transport = FramedTransport(pipe);
    final local = handle.localSdp;
    final remote = handle.remoteSdp;
    if (local == null || remote == null) {
      throw StateError('Missing WebRTC description');
    }
    final opened = await mesh.backend.open(
      drive: mesh.drive,
      binding: channelBinding(local, remote),
      expectedPeer: mesh.expectedPeer,
    );
    final link = _link = opened.link;
    if (_stopped) {
      await link.close();
      return;
    }
    _authTimer = Timer(mesh.authTimeout, () {
      if (!_started) _fail(TimeoutException('Peer authentication timed out'));
    });
    try {
      await transport.send(opened.challenge);
      while (!_stopped) {
        final frame = await transport.recv();
        if (frame == null || _stopped) break;
        final output = await link.handle(frame);
        for (final reply in output.frames) {
          await transport.send(reply);
        }
        if (output.changed.isNotEmpty) mesh.onChanged?.call(output.changed);
        if (output.ready && !_started) {
          _started = true;
          _authTimer?.cancel();
          await _start(handle, transport, link);
        }
      }
    } finally {
      _authTimer?.cancel();
    }
    _fail(Exception('Peer disconnected; reconnecting'));
  }

  Future<void> _start(PeerConnectionHandle handle, FramedTransport transport,
      PeerLinkHandle link) async {
    try {
      path = await handle.path();
    } catch (_) {
      path = ConnectionPath.unknown;
    }
    if (_stopped) return;
    ready = true;
    onReady();

    Future<void> reconcile() async {
      if (_stopped || _reconciling) return;
      _reconciling = true;
      try {
        final frame = await link.reconcileFrame();
        if (frame != null && !_stopped) await transport.send(frame);
      } finally {
        _reconciling = false;
      }
    }

    _reconcileTimer = Timer.periodic(mesh.reconcileEvery, (_) {
      reconcile().catchError(_fail);
    });
    unawaited(reconcile().catchError(_fail));
    unawaited(_liveLoop(transport, link));
  }

  Future<void> _liveLoop(FramedTransport transport, PeerLinkHandle link) async {
    try {
      while (!_stopped) {
        final frames = await link.nextLiveFrames();
        for (final Uint8List frame in frames) {
          if (_stopped) return;
          await transport.send(frame);
        }
      }
    } catch (error) {
      _fail(error);
    }
  }

  Future<void> close() async {
    _stopped = true;
    ready = false;
    _reconcileTimer?.cancel();
    _authTimer?.cancel();
    try {
      await _link?.close();
    } catch (_) {}
    await _transport?.close();
    try {
      await (await _handle).close();
    } catch (_) {}
  }
}
