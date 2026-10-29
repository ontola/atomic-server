import 'dart:math' as math;

import 'package:atomic_buildings/src/geometry.dart';
import 'package:atomic_buildings/src/repository.dart';
import 'package:atomic_buildings/src/room_align.dart';
import 'package:atomic_buildings/src/room_scanner.dart';
import 'package:atomic_buildings/src/roomplan.dart';
import 'package:atomic_buildings/src/terms.g.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:flutter_test/flutter_test.dart';

/// A rigid change of frame: scan = rotate(world, phi) + (dx, dy).
class Frame {
  const Frame(this.phi, this.dx, this.dy);
  static const none = Frame(0, 0, 0);
  final double phi, dx, dy;
  Pt pt(Pt p) => Pt(math.cos(phi) * p.x - math.sin(phi) * p.y + dx,
      math.sin(phi) * p.x + math.cos(phi) * p.y + dy);
  Pt dir(Pt p) => Pt(math.cos(phi) * p.x - math.sin(phi) * p.y,
      math.sin(phi) * p.x + math.cos(phi) * p.y);
}

List<double> tf(Pt c, double y, Pt d) =>
    [d.x, 0, -d.y, 0, 0, 1, 0, 0, d.y, 0, d.x, 0, c.x, y, -c.y, 1];

/// A closed loop of [corners] as walls (walls 0..n-1, end to start), with
/// doors given as (wall, distance along, width), all in world coordinates and
/// scanned in [frame].
ScannedRoom scan(List<Pt> corners, List<(int, double, double)> doors,
    {Frame frame = Frame.none, String? session, bool shared = false}) {
  Map<String, Object?> item(
          String cat, String id, Pt c, Pt d, List<double> dims,
          [String? parent]) =>
      {
        'category': cat,
        'id': id,
        'transform': tf(frame.pt(c), 1.3, frame.dir(d)),
        'dimensions': dims,
        'confidence': 'high',
        if (parent != null) 'parentId': parent,
      };
  final surfaces = <Map<String, Object?>>[];
  for (var i = 0; i < corners.length; i++) {
    final (a, b) = (corners[i], corners[(i + 1) % corners.length]);
    final l = a.distanceTo(b);
    final d = Pt((b.x - a.x) / l, (b.y - a.y) / l);
    surfaces.add(item(
        'wall', 'w$i', Pt((a.x + b.x) / 2, (a.y + b.y) / 2), d, [l, 2.6, 0.1]));
  }
  for (final (i, (wall, at, width)) in doors.indexed) {
    final (a, b) = (corners[wall], corners[(wall + 1) % corners.length]);
    final l = a.distanceTo(b);
    final d = Pt((b.x - a.x) / l, (b.y - a.y) / l);
    surfaces.add(item('door', 'd$i', Pt(a.x + d.x * at, a.y + d.y * at), d,
        [width, 2.1, 0.1], 'w$wall'));
  }
  return ScannedRoom.fromJson({
    'surfaces': surfaces,
    'objects': <Object>[],
    'worldShared': shared,
    if (session != null) 'sessionId': session,
  });
}

List<Pt> rect(double x0, double y0, double x1, double y1) =>
    [Pt(x0, y0), Pt(x1, y0), Pt(x1, y1), Pt(x0, y1)];

PlanRoom plan(ScannedRoom r) => PlanRoom.fromScanned(r);

void expectPt(Pt a, Pt b, [double tol = 0.02]) {
  expect(a.distanceTo(b), lessThan(tol), reason: '$a vs $b');
}

void main() {
  // Room A: 4 x 3 at the origin with a door at x = 1 in its south wall.
  final a = scan(rect(0, 0, 4, 3), [(0, 1, 0.9)]);
  // Room B: 4 x 3 south of A; its north wall is A's south wall, same door.
  final bCorners = [
    const Pt(0, -3),
    const Pt(4, -3),
    const Pt(4, 0),
    const Pt(0, 0)
  ];
  // Its door at x = 1 on the north wall (wall 2 runs (4,0) -> (0,0)).
  final bDoors = [(2, 3.0, 0.9)];

  for (final phi in [0.0, 37 * math.pi / 180, 1.7, -2.1, math.pi]) {
    test(
        'a rotated, shifted second room lands adjacent (${phi.toStringAsFixed(2)} rad)',
        () {
      final b = scan(bCorners, bDoors, frame: Frame(phi, 5.2, -2.1));
      final found = alignScannedRoom([plan(a)], b)!;
      expect(found.isConfident, isTrue, reason: '$found');
      expect(found.alternatives, isEmpty);

      final placed = plan(applyAlignment(b, found));
      final world = plan(scan(bCorners, bDoors));
      for (var i = 0; i < 4; i++) {
        expectPt(placed.walls[i].start, world.walls[i].start);
        expectPt(placed.walls[i].end, world.walls[i].end);
      }
      expectPt(placed.openings.single.centre, plan(a).openings.single.centre);
      expect(overlapArea(placed.outline, plan(a).outline), lessThan(0.05));
      expect(polygonArea(placed.outline), closeTo(12, 0.01));
    });
  }

  test('applyAlignment keeps ARKit transforms valid and does not scale', () {
    final b = scan(bCorners, bDoors, frame: const Frame(0.9, 1, 2));
    final moved =
        applyAlignment(b, const Alignment(rotation: 0.6, tx: 3, ty: -1.5));
    for (var i = 0; i < b.surfaces.length; i++) {
      final (o, n) = (b.surfaces[i], moved.surfaces[i]);
      expect(n.dimensions, o.dimensions);
      expect(n.centreY, o.centreY);
      final m = n.transform;
      // Orthonormal columns, Y stays up, bottom row (0 0 0 1).
      expect(m[1], 0);
      expect(m[5], 1);
      expect(m[7], 0);
      expect(m[15], 1);
      expect(m[0] * m[0] + m[2] * m[2], closeTo(1, 1e-9));
      expect(m[0] * m[8] + m[2] * m[10], closeTo(0, 1e-9));
      expect(
          n.centre.distanceTo(
              const Alignment(rotation: 0.6, tx: 3, ty: -1.5).apply(o.centre)),
          lessThan(1e-9));
    }
  });

  test('L-shaped corridor: a room is attached at the end of an arm', () {
    // 1 m wide corridor: east along y 0..1, then north along x 0..1.
    final l = [
      const Pt(0, 0),
      const Pt(5, 0),
      const Pt(5, 1),
      const Pt(1, 1),
      const Pt(1, 4),
      const Pt(0, 4),
    ];
    // Walls: 0 south, 1 east end, 2 inner, 3 inner, 4 north end (1,4)->(0,4), 5 west.
    final corridor = scan(l, [(4, 0.5, 0.9)]);
    final roomCorners = [
      const Pt(-1.5, 4),
      const Pt(2.5, 4),
      const Pt(2.5, 7),
      const Pt(-1.5, 7)
    ];
    // Door in the room's south wall at x = 0.5, 2 m along.
    final room =
        scan(roomCorners, [(0, 2.0, 0.9)], frame: const Frame(0.64, -4, 7));
    final found = alignScannedRoom([plan(corridor)], room)!;
    expect(found.isConfident, isTrue, reason: '$found');
    final placed = plan(applyAlignment(room, found));
    expectPt(placed.openings.single.centre, const Pt(0.5, 4));
    expect(overlapArea(placed.outline, plan(corridor).outline), lessThan(0.05));
    expect(placed.outline.map((p) => p.y).reduce(math.max), closeTo(7, 0.02));
  });

  test('L-shaped corridor as the new room, rotated, against a 4 x 3 room', () {
    final room = scan(rect(0, 0, 4, 3), [(1, 1.5, 0.9)]); // east wall, y = 1.5
    // The corridor's west wall 5 runs (4,5) -> (4,1); its door is 3.5 m along,
    // at (4, 1.5) like the room's door.
    final l = [
      const Pt(4, 1),
      const Pt(9, 1),
      const Pt(9, 2),
      const Pt(5, 2),
      const Pt(5, 5),
      const Pt(4, 5)
    ];
    final fixed = scan(l, [(5, 3.5, 0.9)], frame: const Frame(-1.1, 3, 9));
    final found = alignScannedRoom([plan(room)], fixed)!;
    final placed = plan(applyAlignment(fixed, found));
    expectPt(placed.openings.single.centre, const Pt(4, 1.5));
    expect(overlapArea(placed.outline, plan(room).outline), lessThan(0.05));
  });

  test('two identical doors make the placement ambiguous (low confidence)', () {
    final wide = scan(rect(0, 0, 8, 3), [(0, 2, 0.9), (0, 6, 0.9)]);
    final b = scan([
      const Pt(0, -3),
      const Pt(3, -3),
      const Pt(3, 0),
      const Pt(0, 0)
    ], [
      (2, 1.5, 0.9)
    ], frame: const Frame(0.64, 2, 2));
    final found = alignScannedRoom([plan(wide)], b)!;
    expect(found.ambiguous, isTrue);
    expect(found.isConfident, isFalse);
    expect(found.confidence, lessThan(Alignment.confidentThreshold));
    expect(found.alternatives, hasLength(1));
    expect(found.alternatives.first.tx, isNot(closeTo(found.tx, 0.5)));
  });

  test('no shared opening returns null', () {
    final noDoor = scan(rect(0, 0, 3, 3), []);
    expect(alignScannedRoom([plan(a)], noDoor), isNull);
    final wideDoor = scan(rect(0, -3, 4, 0), [(2, 1, 2.0)]);
    expect(alignScannedRoom([plan(a)], wideDoor), isNull); // 2.0 vs 0.9
    expect(alignScannedRoom([plan(noDoor)], scan(bCorners, bDoors)), isNull);
    expect(alignScannedRoom(const [], scan(bCorners, bDoors)), isNull);
  });

  group('import', () {
    late InMemoryBackend backend;
    late BuildingRepository repo;
    setUp(() {
      backend = InMemoryBackend({
        'did:ad:drive': {Props.name: const StringValue('Drive')},
      });
      repo = BuildingRepository(Store(backend: backend, drive: 'did:ad:drive'));
    });
    tearDown(() => backend.dispose());

    Future<List<List<Pt>>> spaces(Resource home) async => [
          for (final r in await home.children())
            if (r.isA(BuildingClass.space)) r.boundary!
        ];

    test('the second room is aligned against the first', () async {
      final home = await repo.createHome('Villa');
      final storey = await repo.createStorey(home, 'Ground');
      await importScannedRoom(repo, storey, a);
      final b = scan(bCorners, bDoors, frame: const Frame(0.65, 5.2, -2.1));
      final r = await importScannedRoomChecked(repo, storey, b);
      expect(r.needsDecision, isFalse);
      expect(r.alignment, isNotNull);
      final s = await spaces(home);
      expect(s, hasLength(2));
      expect(overlapArea(s[0], s[1]), lessThan(0.05));
      expect(polygonArea(s[0]) + polygonArea(s[1]), closeTo(24, 0.05));
    });

    test('an unsure placement imports nothing and asks', () async {
      final home = await repo.createHome('Villa');
      final storey = await repo.createStorey(home, 'Ground');
      await importScannedRoom(
          repo, storey, scan(rect(0, 0, 8, 3), [(0, 2, 0.9), (0, 6, 0.9)]));
      final b = scan([
        const Pt(0, -3),
        const Pt(3, -3),
        const Pt(3, 0),
        const Pt(0, 0)
      ], [
        (2, 1.5, 0.9)
      ], frame: const Frame(0.64, 2, 2));
      final r = await importScannedRoomChecked(repo, storey, b);
      expect(r.needsDecision, isTrue);
      expect(r.created, isEmpty);
      expect(r.proposal!.alternatives, isNotEmpty);
      expect(await spaces(home), hasLength(1));
      // The person picks an alternative.
      final ok = await importScannedRoomChecked(repo, storey, b,
          alignment: r.proposal!.alternatives.first);
      expect(ok.created, isNotEmpty);
      expect(await spaces(home), hasLength(2));
      // The legacy entry point places it as scanned instead of asking.
      expect(await importScannedRoom(repo, storey, scan(rect(0, 0, 2, 2), [])),
          isNotEmpty);
    });

    test('scans of one shared ARKit session are trusted without matching',
        () async {
      final home = await repo.createHome('Villa');
      final storey = await repo.createStorey(home, 'Ground');
      // Same world frame: the first scan is placed as is, the second has no
      // door at all and still lands where its own transforms say.
      await importScannedRoomChecked(
          repo, storey, scan(rect(0, 0, 4, 3), [], session: 's1'));
      final r = await importScannedRoomChecked(repo, storey,
          scan(rect(0, -3, 4, 0), [], session: 's1', shared: true));
      expect(r.needsDecision, isFalse);
      final s = await spaces(home);
      expect(overlapArea(s[0], s[1]), lessThan(0.05));
      expect(s.map(polygonArea), everyElement(closeTo(12, 0.01)));
      // Without the shared flag the same room has nothing to match on.
      final asked = await importScannedRoomChecked(
          repo, storey, scan(rect(0, -3, 4, 0), [], session: 's2'));
      expect(asked.needsDecision, isTrue);
    });
  });

  test('merged rooms parse', () {
    const json = '{"rooms":[{"sessionId":"s","worldShared":true,"surfaces":[],'
        '"objects":[]}]}';
    final rooms = parseMergedRooms(json);
    expect(rooms.single.worldShared, isTrue);
    expect(rooms.single.sessionId, 's');
  });
}
