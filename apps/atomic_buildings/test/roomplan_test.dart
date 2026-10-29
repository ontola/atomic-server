import 'dart:convert';

import 'package:atomic_buildings/src/geometry.dart';
import 'package:atomic_buildings/src/repository.dart';
import 'package:atomic_buildings/src/room_scanner.dart';
import 'package:atomic_buildings/src/roomplan.dart';
import 'package:atomic_buildings/src/terms.g.dart';
import 'package:atomic_buildings/ui/home_page.dart';
import 'chat_helpers.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// ARKit column-major transform for a plan position (px, py) at height [y],
/// whose local X axis points along the plan direction (dx, dy): plan (x, y)
/// is ARKit (x, z = -y).
List<double> tf(double px, double py, double y,
        [double dx = 1, double dy = 0]) =>
    [dx, 0, -dy, 0, 0, 1, 0, 0, dy, 0, dx, 0, px, y, -py, 1];

Map<String, Object?> item(
        String category, String id, List<double> t, List<double> dims,
        {String confidence = 'high', String? parentId}) =>
    {
      'category': category,
      'id': id,
      'transform': t,
      'dimensions': dims,
      'confidence': confidence,
      if (parentId != null) 'parentId': parentId,
    };

/// A 4 x 3 m room; the ARKit origin is 1.3 m above the floor.
String roomJson() => jsonEncode({
      'name': 'Kitchen',
      'surfaces': [
        item('wall', 'S', tf(2, 0, 1.3), [4, 2.6, 0]),
        item('wall', 'E', tf(4, 1.5, 1.3, 0, 1), [3, 2.6, 0.15],
            confidence: 'medium'),
        item('wall', 'N', tf(2, 3, 1.3, -1, 0), [4, 2.6, 0]),
        item('wall', 'W', tf(0, 1.5, 1.3, 0, -1), [3, 2.6, 0]),
        item('door', 'D', tf(1, 0.02, 1.05), [0.9, 2.1, 0]),
        item('window', 'Win', tf(3, 3, 1.5, -1, 0), [1.2, 1.2, 0],
            confidence: 'low'),
        item('floor', 'F', tf(2, 1.5, 0), [4, 3, 0]),
      ],
      'objects': [
        item('table', 'T', tf(2, 1.5, 0.4), [1, 0.8, 0.5]),
      ],
    });

class FakeScanner implements RoomScanner {
  FakeScanner(this.room, {this.supported = true});
  final ScannedRoom? room;
  final bool supported;
  @override
  Future<bool> isSupported() async => supported;
  @override
  Future<ScannedRoom?> scan() async => room;
}

void main() {
  late InMemoryBackend backend;
  late BuildingRepository repo;
  setUp(() {
    backend = InMemoryBackend({
      'did:ad:drive': {Props.name: const StringValue('Drive')},
    });
    repo = BuildingRepository(Store(backend: backend, drive: 'did:ad:drive'));
  });
  tearDown(() => backend.dispose());

  test('a 4 x 3 m scan becomes walls, hosted openings, a room and a table',
      () async {
    final home = await repo.createHome('Villa');
    final storey = await repo.createStorey(home, 'Ground');
    final created = await importScannedRoom(
        repo, storey, ScannedRoom.parse(roomJson()),
        sourceFileSubject: 'did:ad:file');
    expect(created, hasLength(8)); // space + 4 walls + door + window + table

    final all = await home.children();
    Resource named(String n) => all.firstWhere((r) => r.name == n);
    WallAxis axis(String n) => named(n).geometry! as WallAxis;
    Opening opening(String n) => named(n).geometry! as Opening;

    // Axes: along the local X axis, with the plan's y = -ARKit z.
    expect(axis('Wall 1').start, const Pt(0, 0));
    expect(axis('Wall 1').end, const Pt(4, 0));
    expect(axis('Wall 1').thickness, 0.1); // default when the scan has none
    expect(axis('Wall 2').start, const Pt(4, 0));
    expect(axis('Wall 2').end, const Pt(4, 3));
    expect(axis('Wall 2').thickness, 0.15);
    expect(axis('Wall 3').start, const Pt(4, 3)); // faces the other way
    expect(axis('Wall 3').end, const Pt(0, 3));
    expect(axis('Wall 1').height, 2.6);

    // The door is centred at x = 1 on the south wall: 0.55 from its start.
    expect(named('Door 1').getLink(Bldg.hostedBy), named('Wall 1').subject);
    expect(opening('Door 1').offset, closeTo(0.55, 1e-9));
    expect(opening('Door 1').sill, 0);
    // The window is at x = 3 on the north wall, which starts at x = 4.
    expect(named('Window 1').getLink(Bldg.hostedBy), named('Wall 3').subject);
    expect(opening('Window 1').offset, closeTo(0.4, 1e-9));
    expect(opening('Window 1').sill, closeTo(0.9, 1e-9));
    expect(named('Window 1').getString(Bldg.ifcClass), 'IfcWindow');

    final space = all.firstWhere((r) => r.isA(BuildingClass.space));
    expect(space.name, 'Kitchen');
    expect(space.getString(Bldg.usage), 'other');
    expect(polygonArea(space.boundary!), closeTo(12, 1e-9));

    final table = named('Table 1');
    expect(table.getString(Bldg.ifcClass), 'IfcFurnishingElement');
    expect(polygonArea((table.geometry! as Extrusion).polygon),
        closeTo(0.5, 1e-9));

    // Review metadata, run and evidence.
    final run = all.firstWhere((r) => r.isA(BuildingClass.analysisRun));
    final source = all.firstWhere((r) => r.isA(BuildingClass.source));
    expect(source.getString(Bldg.mediaKind), 'scan');
    expect(source.getLink(Bldg.sourceFile), 'did:ad:file');
    expect(run.getString(Bldg.model), 'RoomPlan');
    expect(run.getString(Bldg.runStatus), 'completed');
    for (final r in created) {
      expect(r.getString(Bldg.origin), 'import');
      expect(r.reviewState, 'proposed');
      expect(r.getLink(Bldg.createdByRun), run.subject);
    }
    expect((named('Wall 1').get(Bldg.confidence) as FloatValue).value, 0.9);
    expect((named('Wall 2').get(Bldg.confidence) as FloatValue).value, 0.6);
    expect((named('Window 1').get(Bldg.confidence) as FloatValue).value, 0.3);
    for (final r in created) {
      final e = await repo.evidenceFor(r);
      expect(e.map((x) => x.source.subject), [source.subject]);
    }
  });

  test('a second room goes into the same storey with its own name', () async {
    final home = await repo.createHome('Villa');
    final storey = await repo.createStorey(home, 'Ground');
    await importScannedRoom(repo, storey, ScannedRoom.parse(roomJson()));
    await importScannedRoom(repo, storey,
        ScannedRoom.parse(roomJson().replaceFirst('Kitchen', 'Hall')));
    final spaces = (await home.children())
        .where((r) => r.isA(BuildingClass.space))
        .map((r) => r.name);
    expect(spaces, unorderedEquals(['Kitchen', 'Hall']));
  });

  test('the contract rejects what it cannot map', () {
    expect(() => ScannedRoom.parse('{"surfaces":[{"category":"roof"}]}'),
        throwsFormatException);
    expect(ScannedRoom.parse('{}').surfaces, isEmpty);
  });

  testWidgets('Scan room imports the result and says what was proposed',
      (tester) async {
    late Resource home;
    await tester.runAsync(() async {
      home = await repo.createHome('Villa');
      await repo.createStorey(home, 'Ground');
    });
    final room = ScannedRoom.parse(roomJson());
    Future<void> settle() async {
      for (var i = 0; i < 4; i++) {
        await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump();
      }
    }

    await tester.pumpWidget(chatApp(
        HomePage(repo, home, chat: noAccountChat, scanner: FakeScanner(room))));
    await settle();
    await openScreen(tester, 'Plan');
    await tester.tap(find.text('Scan room'));
    await settle();
    expect(
        find.text('8 items proposed, review them on the plan'), findsOneWidget);
    final n = await tester.runAsync(() async => (await home.children())
        .where((r) => r.isA(BuildingClass.element))
        .length);
    expect(n, 7);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(chatApp(HomePage(repo, home,
        chat: noAccountChat,
        key: UniqueKey(),
        scanner: FakeScanner(null, supported: false))));
    await settle();
    await openScreen(tester, 'Plan');
    expect(find.text('Scan room'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    backend.dispose();
    await tester.pump();
  });
}
