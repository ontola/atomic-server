import 'package:atomic_buildings/src/geometry.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every kind round-trips through JSON', () {
    final shapes = <Geometry>[
      const WallAxis(
          start: Pt(0, 0), end: Pt(4, 0), height: 2.6, thickness: 0.2),
      const Extrusion(polygon: [Pt(0, 0), Pt(4, 0), Pt(4, 3)], depth: 0.25),
      const Opening(offset: 1, width: 0.9, height: 2.1, sill: 0),
      const Mesh(file: 'did:ad:file1'),
    ];
    for (final g in shapes) {
      final back = Geometry.fromJson(g.kind, g.toJson());
      expect(back.kind, g.kind);
      expect(back.toJson(), g.toJson());
    }
  });

  test('an opening defaults its sill to 0', () {
    final o =
        Geometry.fromJson('opening', {'offset': 1, 'width': 1, 'height': 2});
    expect((o as Opening).sill, 0);
  });

  test('bad geometry says which field', () {
    void bad(String kind, Object? json, String field) => expect(
          () => Geometry.fromJson(kind, json),
          throwsA(isA<GeometryException>()
              .having((e) => e.message, 'message', contains(field))),
        );
    bad(
        'wallAxis',
        {
          'start': [0, 0],
          'end': [0, 0],
          'height': 2,
          'thickness': 0.1
        },
        'equals');
    bad(
        'wallAxis',
        {
          'start': [0],
          'end': [1, 0],
          'height': 2,
          'thickness': 0.1
        },
        'start');
    bad(
        'wallAxis',
        {
          'start': [0, 0],
          'end': [1, 0],
          'height': 0,
          'thickness': 0.1
        },
        'height');
    bad(
        'extrusion',
        {
          'polygon': [
            [0, 0],
            [1, 1]
          ],
          'depth': 1
        },
        'polygon');
    bad('opening', {'offset': -1, 'width': 1, 'height': 1}, 'offset');
    bad('mesh', {'file': ''}, 'file');
    bad('wallAxis', 'nope', 'object');
    bad('sphere', {}, 'unknown');
  });
}
