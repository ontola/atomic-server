import 'dart:typed_data';

import 'package:atomic_app/atomic/bridge_peer_link_backend.dart';
import 'package:atomic_store_flutter/bridge/api/simple/webrtc_peer.dart' as ffi;
import 'package:flutter_test/flutter_test.dart';

class _FakeLink implements ffi.WebRtcLink {
  final calls = <String>[];

  @override
  Future<ffi.WebRtcLinkOutput> handle({required List<int> frame}) async {
    calls.add('handle:${frame.length}');
    return ffi.WebRtcLinkOutput(
      frames: [
        Uint8List.fromList([1])
      ],
      changed: const ['atomic:x'],
      ready: true,
    );
  }

  @override
  Future<Uint8List?> reconcileFrame() async => Uint8List.fromList([2]);

  @override
  Future<List<Uint8List>> nextLiveFrames() async => [
        Uint8List.fromList([3])
      ];

  @override
  Future<void> close() async => calls.add('close');

  @override
  void dispose() => calls.add('dispose');

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test('the backend maps the bridge types onto the peer link interfaces',
      () async {
    final fake = _FakeLink();
    String? seenDrive, seenBinding, seenPeer;
    final backend = BridgePeerLinkBackend(
      open: ({required drive, required binding, expectedPeer}) async {
        seenDrive = drive;
        seenBinding = binding;
        seenPeer = expectedPeer;
        return ffi.WebRtcLinkStart(
          link: fake,
          challenge: Uint8List.fromList([9]),
        );
      },
    );

    final opened = await backend.open(
      drive: 'atomic:d',
      binding: 'b',
      expectedPeer: 'did:ad:agent:p',
    );
    expect([seenDrive, seenBinding, seenPeer],
        ['atomic:d', 'b', 'did:ad:agent:p']);
    expect(opened.challenge, [9]);

    final out = await opened.link.handle(Uint8List.fromList([0, 0]));
    expect(out.frames.single, [1]);
    expect(out.changed, ['atomic:x']);
    expect(out.ready, isTrue);
    expect(await opened.link.reconcileFrame(), [2]);
    expect((await opened.link.nextLiveFrames()).single, [3]);

    await opened.link.close();
    expect(fake.calls, ['handle:2', 'close', 'dispose']);
  });
}
