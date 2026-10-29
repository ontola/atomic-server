import 'dart:typed_data';

import 'package:atomic_app/atomic/webrtc/framed_transport.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

Uint8List bytes(int n, [int seed = 0]) =>
    Uint8List.fromList(List.generate(n, (i) => (i + seed) % 251));

void main() {
  late MemoryPipe local;
  late MemoryPipe remote;
  late FramedTransport a;
  late FramedTransport b;

  setUp(() {
    final (x, y) = MemoryPipe.pair();
    local = x;
    remote = y;
    a = FramedTransport(local);
    b = FramedTransport(remote);
  });

  tearDown(() async {
    await a.close();
    await b.close();
  });

  test('a frame goes out with a big-endian length prefix', () async {
    await a.send(Uint8List.fromList([7, 8, 9]));
    expect(local.sentMessages.single, [0, 0, 0, 3, 7, 8, 9]);
  });

  test('a frame crosses and arrives whole', () async {
    final frame = bytes(100);
    await a.send(frame);
    expect(await b.recv(), frame);
  });

  test('a large frame is cut into messages of at most 16 KiB', () async {
    final frame = bytes(100000);
    await a.send(frame);
    expect(local.sentMessages.length, greaterThan(1));
    expect(
        local.sentMessages.every((m) => m.length <= maxChannelMessage), isTrue);
    expect(await b.recv(), frame);
  });

  test('frames keep their order', () async {
    final frames = [bytes(5, 1), bytes(40000, 2), bytes(1, 3)];
    for (final frame in frames) {
      await a.send(frame);
    }
    for (final frame in frames) {
      expect(await b.recv(), frame);
    }
  });

  test('a reader waiting before the frame arrives gets it', () async {
    final waiting = b.recv();
    await a.send(bytes(10));
    expect(await waiting, bytes(10));
  });

  test('the sender may reuse its buffer', () async {
    final frame = bytes(10);
    final sent = a.send(frame);
    frame.fillRange(0, frame.length, 0);
    await sent;
    expect(await b.recv(), bytes(10));
  });

  test('refuses an empty frame and one over 16 MiB', () async {
    await expectLater(a.send(Uint8List(0)), throwsException);
    await expectLater(a.send(Uint8List(maxFrameBytes + 1)), throwsException);
  });

  test('refuses a length prefix over 16 MiB from the peer', () async {
    final hostile = Uint8List(4);
    ByteData.sublistView(hostile).setUint32(0, maxFrameBytes + 1);
    await remote.send(hostile);
    await expectLater(a.recv(), throwsException);
    expect(a.ended, isTrue);
  });

  test('refuses a zero length frame from the peer', () async {
    await remote.send(Uint8List(4));
    await expectLater(a.recv(), throwsException);
  });

  test('refuses more bytes than the frame announced', () async {
    final hostile = Uint8List.fromList([0, 0, 0, 2, 1, 2, 3]);
    await remote.send(hostile);
    await expectLater(a.recv(), throwsException);
  });

  test('a clean close ends the stream with null', () async {
    await remote.close();
    expect(await a.recv(), isNull);
  });

  test('a close in the middle of a frame is an error', () async {
    await remote.send(Uint8List.fromList([0, 0, 0, 9, 1]));
    await remote.close();
    await expectLater(a.recv(), throwsException);
  });

  test('sending after close fails', () async {
    await a.close();
    await expectLater(a.send(bytes(3)), throwsException);
  });

  test('waits for the channel to drain above the high-water mark', () async {
    local.buffered = sendHighWater + 1;
    await a.send(bytes(100000));
    // drained() ran at least once and let the writer continue.
    expect(local.buffered, 0);
  });
}
