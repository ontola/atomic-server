/// Atomic frames over an ordered, reliable data channel: the Dart twin of
/// `browser/lib/src/webrtc-transport.ts`. A frame is a 4 byte big-endian
/// length and the frame; the channel carries it in messages of at most 16 KiB
/// (below SCTP's negotiated limit), and the receiver reassembles. Nothing here
/// authenticates anyone: an open channel is never evidence of drive access.
library;

import 'dart:async';
import 'dart:typed_data';

/// Largest frame, and so largest snapshot or blob that crosses a link.
const maxFrameBytes = 16 * 1024 * 1024;

/// Largest message handed to the channel.
const maxChannelMessage = 16 * 1024;

/// Above this many unsent bytes a writer waits for the channel to drain.
const sendHighWater = 128 * 1024;

/// The channel as the transport needs it. The real one wraps the WebRTC data
/// channel; a test supplies a pair of memory pipes.
abstract interface class DataPipe {
  /// Incoming messages, in order; completes when the channel closes.
  Stream<Uint8List> get messages;
  Future<void> send(Uint8List message);

  /// Bytes accepted by [send] and not yet on the wire.
  int get bufferedAmount;

  /// Completes once [bufferedAmount] is low again (or the channel closed).
  Future<void> drained();
  Future<void> close();
}

class FramedTransport {
  FramedTransport(this._pipe) {
    _subscription = _pipe.messages.listen(
      _onMessage,
      onError: (Object error) => _finish(
        error is Exception ? error : Exception('$error'),
      ),
      onDone: () => _finish(
        _partial == null ? null : Exception('Truncated Atomic frame'),
      ),
    );
  }

  final DataPipe _pipe;
  late final StreamSubscription<Uint8List> _subscription;
  final _pending = <Uint8List>[];
  final _readers = <Completer<Uint8List?>>[];
  int _queuedBytes = 0;
  int _sendingBytes = 0;
  Uint8List? _partial;
  int _offset = 0;
  bool _ended = false;
  Exception? _failure;
  Future<void> _sending = Future.value();

  bool get ended => _ended;

  /// Queues [frame] behind earlier ones and resolves when it is on the channel.
  /// A failure leaves the stream corrupt (a half-written frame), so it ends
  /// the transport.
  Future<void> send(Uint8List frame) {
    if (frame.isEmpty || frame.length > maxFrameBytes) {
      return Future.error(Exception('Invalid Atomic frame size'));
    }
    if (_ended) {
      return Future.error(_failure ?? Exception('WebRTC transport closed'));
    }
    if (_sendingBytes + frame.length > maxFrameBytes) {
      return Future.error(Exception('Atomic send queue full'));
    }
    _sendingBytes += frame.length;
    // Callers may reuse their buffer.
    final copy = Uint8List.fromList(frame);
    final operation = _sending.then((_) => _write(copy)).whenComplete(() {
      _sendingBytes -= copy.length;
    });
    _sending = operation.then((_) {}, onError: (Object _) {});
    return operation;
  }

  Future<void> _write(Uint8List frame) async {
    final wire = Uint8List(frame.length + 4);
    ByteData.sublistView(wire).setUint32(0, frame.length);
    wire.setRange(4, wire.length, frame);
    try {
      for (var offset = 0; offset < wire.length; offset += maxChannelMessage) {
        if (_ended) throw _failure ?? Exception('WebRTC transport closed');
        if (_pipe.bufferedAmount > sendHighWater) await _pipe.drained();
        final end = offset + maxChannelMessage < wire.length
            ? offset + maxChannelMessage
            : wire.length;
        await _pipe.send(Uint8List.sublistView(wire, offset, end));
      }
    } catch (error) {
      _finish(error is Exception ? error : Exception('$error'));
      rethrow;
    }
  }

  /// The next whole frame, or null once the channel closed cleanly. Throws
  /// when it failed.
  Future<Uint8List?> recv() {
    if (_pending.isNotEmpty) {
      final frame = _pending.removeAt(0);
      _queuedBytes -= frame.length;
      return Future.value(frame);
    }
    if (_failure != null) return Future.error(_failure!);
    if (_ended) return Future.value(null);
    final reader = Completer<Uint8List?>();
    _readers.add(reader);
    return reader.future;
  }

  void _onMessage(Uint8List bytes) {
    if (_ended) return;
    try {
      var start = 0;
      var partial = _partial;
      if (partial == null) {
        if (bytes.length < 4) throw Exception('Missing Atomic frame length');
        final length = ByteData.sublistView(bytes).getUint32(0);
        if (length == 0 || length > maxFrameBytes) {
          throw Exception('Invalid Atomic frame size');
        }
        if (length + _queuedBytes > maxFrameBytes) {
          throw Exception('Atomic receive queue full');
        }
        partial = _partial = Uint8List(length);
        _offset = 0;
        start = 4;
      }
      if (bytes.length - start > partial.length - _offset) {
        throw Exception('Atomic frame overflow');
      }
      partial.setRange(_offset, _offset + bytes.length - start, bytes, start);
      _offset += bytes.length - start;
      if (_offset == partial.length) {
        _partial = null;
        if (_readers.isNotEmpty) {
          _readers.removeAt(0).complete(partial);
        } else {
          _pending.add(partial);
          _queuedBytes += partial.length;
        }
      }
    } on Exception catch (error) {
      _finish(error);
    }
  }

  void _finish([Exception? error]) {
    if (_ended) return;
    _ended = true;
    _failure = error;
    _partial = null;
    for (final reader in _readers) {
      if (error != null) {
        reader.completeError(error);
      } else {
        reader.complete(null);
      }
    }
    _readers.clear();
    if (error != null) {
      _pending.clear();
      _queuedBytes = 0;
    }
    unawaited(_subscription.cancel());
    unawaited(_pipe.close());
  }

  Future<void> close() async => _finish();
}
