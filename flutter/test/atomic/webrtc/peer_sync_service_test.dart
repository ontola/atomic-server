import 'package:atomic_app/atomic/webrtc/peer_identity.dart';
import 'package:atomic_app/atomic/webrtc/peer_link_backend.dart';
import 'package:atomic_app/atomic/webrtc/peer_sync_service.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

void main() {
  late List<String> drives;
  late Map<String, String?> named;
  late Set<String> cloud;
  late List<FakeSignalingSocket> sockets;
  late List<Uri> dialled;
  late WebRtcPeerSyncService service;

  WebRtcPeerSyncService build({String? portal = 'https://atomic.place'}) =>
      WebRtcPeerSyncService(
        backend: FakeBackend(
            () => FakeLink((frame) async => const PeerLinkOutput())),
        listDrives: () async => drives,
        driveSignalingUrl: (drive) async => named[drive],
        usesCloudServer: (drive) async => cloud.contains(drive),
        portalUrl: portal,
        connect: (servers) async => FakeConnection(servers),
        signaling: (url) async {
          dialled.add(url);
          final socket = FakeSignalingSocket();
          sockets.add(socket);
          return socket;
        },
      );

  setUp(() {
    drives = [];
    named = {};
    cloud = {};
    sockets = [];
    dialled = [];
    service = build();
  });

  tearDown(() => service.stop());

  test('a local-only private drive gets a room at the portal', () async {
    drives = ['atomic:private1'];
    await service.start();
    await eventually(
        () => sockets.isNotEmpty && sockets.single.sent.isNotEmpty);
    expect(dialled.single, Uri.parse('wss://atomic.place/webrtc-signal'));
    expect(sockets.single.sent.single['room'],
        automaticPeerRoom('atomic:private1'));
  });

  test('only atomic drives get a room, not server drives', () async {
    drives = [
      'https://atomicdata.dev/drive/wd22yxmxw4j',
      'http://localhost:9883/drive/x',
      'atomic:private1',
    ];
    await service.start();
    await eventually(
        () => sockets.isNotEmpty && sockets.single.sent.isNotEmpty);
    expect(service.drives.toList(), ['atomic:private1']);
    expect(sockets, hasLength(1));
  });

  test('the room is the same for either spelling of the drive', () async {
    drives = ['did:ad:private1'];
    await service.start();
    await eventually(
        () => sockets.isNotEmpty && sockets.single.sent.isNotEmpty);
    expect(sockets.single.sent.single['room'],
        automaticPeerRoom('atomic:private1'));
    expect(service.drives, ['atomic:private1']);
  });

  test('a drive that names its own service uses it', () async {
    drives = ['atomic:a'];
    named['atomic:a'] = 'wss://rendezvous.example/signal';
    await service.start();
    await eventually(() => dialled.isNotEmpty);
    expect(dialled.single, Uri.parse('wss://rendezvous.example/signal'));
  });

  test('a drive on a Cloud Server gets no room', () async {
    drives = ['atomic:cloud', 'atomic:local'];
    cloud = {'atomic:cloud'};
    await service.start();
    await eventually(() => service.drives.isNotEmpty);
    expect(service.drives, ['atomic:local']);
  });

  test('without a portal or a named service nothing is contacted', () async {
    service = build(portal: null);
    drives = ['atomic:a', 'atomic:b'];
    named['atomic:b'] = 'ws://insecure.example/s';
    await service.start();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(dialled, isEmpty);
    expect(service.drives, isEmpty);
  });

  test('starting again picks up new drives and drops removed ones', () async {
    drives = ['atomic:a'];
    await service.start();
    expect(service.drives, ['atomic:a']);
    drives = ['atomic:b'];
    await service.start();
    expect(service.drives, ['atomic:b']);
  });

  test('starting twice does not open a second room for one drive', () async {
    drives = ['atomic:a'];
    await service.start();
    await service.start();
    await eventually(() => sockets.isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(sockets, hasLength(1));
  });

  test('stop leaves every room', () async {
    drives = ['atomic:a'];
    await service.start();
    await eventually(() => sockets.isNotEmpty);
    await service.stop();
    expect(service.drives, isEmpty);
    expect(sockets.single.closed, isTrue);
  });

  test('a failure reading the drives is retried at the next start', () async {
    var fail = true;
    service = WebRtcPeerSyncService(
      backend:
          FakeBackend(() => FakeLink((frame) async => const PeerLinkOutput())),
      listDrives: () async {
        if (fail) throw StateError('store busy');
        return ['atomic:a'];
      },
      driveSignalingUrl: (drive) async => null,
      usesCloudServer: (drive) async => false,
      portalUrl: 'https://atomic.place',
      connect: (servers) async => FakeConnection(servers),
      signaling: (url) async => FakeSignalingSocket(),
    );
    await service.start();
    expect(service.drives, isEmpty);
    fail = false;
    await service.start();
    expect(service.drives, ['atomic:a']);
  });
}
