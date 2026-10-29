import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:atomic_buildings/src/geometry.dart';
import 'package:atomic_buildings/src/gltf_export.dart';
import 'package:atomic_buildings/src/repository.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:flutter_test/flutter_test.dart';

const drive = 'did:ad:drive';

/// Splits a GLB into its JSON and BIN chunks, checking the container.
(Map<String, dynamic>, Uint8List) parseGlb(Uint8List glb) {
  final d = ByteData.sublistView(glb);
  expect(utf8.decode(glb.sublist(0, 4)), 'glTF');
  expect(d.getUint32(4, Endian.little), 2);
  expect(d.getUint32(8, Endian.little), glb.length);
  expect(glb.length % 4, 0);
  final jsonLen = d.getUint32(12, Endian.little);
  expect(utf8.decode(glb.sublist(16, 20)), 'JSON');
  expect(jsonLen % 4, 0);
  final json = jsonDecode(utf8.decode(glb.sublist(20, 20 + jsonLen)))
      as Map<String, dynamic>;
  final binAt = 20 + jsonLen;
  final binLen = d.getUint32(binAt, Endian.little);
  expect(utf8.decode(glb.sublist(binAt + 4, binAt + 8)), 'BIN\u0000');
  expect(binAt + 8 + binLen, glb.length);
  return (json, glb.sublist(binAt + 8));
}

void main() {
  late BuildingRepository repo;
  late Resource home, wall, window;

  setUp(() async {
    final backend = InMemoryBackend({
      drive: {Props.name: const StringValue('Drive')},
    });
    addTearDown(backend.dispose);
    repo = BuildingRepository(Store(backend: backend, drive: drive));
    home = await repo.createHome('Villa');
    final storey = await repo.createStorey(home, 'Ground', elevation: 0);
    await repo.createStorey(home, 'First', elevation: 2.8, level: 1);
    const corners = [Pt(0, 0), Pt(4, 0), Pt(4, -3), Pt(0, -3)];
    // The room spans y 0..-3 so that the glTF z (= -y) is 0..3.
    for (var i = 0; i < 4; i++) {
      final w = await repo.createElement(
        storey,
        'Wall $i',
        'IfcWall',
        WallAxis(
            start: corners[i],
            end: corners[(i + 1) % 4],
            height: 2.6,
            thickness: 0.2),
      );
      if (i == 0) wall = w;
    }
    await repo.createElement(storey, 'Door', 'IfcDoor',
        const Opening(offset: 0.5, width: 0.9, height: 2.1),
        hostedBy: wall);
    window = await repo.createElement(storey, 'Window', 'IfcWindow',
        const Opening(offset: 2, width: 1.2, height: 1.2, sill: 0.9),
        hostedBy: wall, origin: Origin.ai);
    await repo.createElement(storey, 'Slab', 'IfcSlab',
        const Extrusion(polygon: corners, depth: 0.2));
    await repo.createElement(
        storey,
        'Sofa',
        'IfcFurnishingElement',
        const Extrusion(
            polygon: [Pt(1, -1), Pt(2, -1), Pt(2, -1.5), Pt(1, -1.5)],
            depth: 0.8));
    await repo.createElement(
        storey, 'Scan', 'IfcWall', const Mesh(file: 'did:ad:file'));
    final gone = await repo.createElement(
        storey,
        'Rejected',
        'IfcWall',
        const WallAxis(
            start: Pt(0, 0), end: Pt(9, 9), height: 9, thickness: 1));
    await repo.reject(gone);
    await repo.createSpace(storey, 'Living', 'living', corners);
  });

  test('exports a valid GLB of a room', () async {
    final glb = await exportHomeGlb(repo, home.subject);
    final (json, bin) = parseGlb(glb);
    expect(json['asset']['version'], '2.0');

    // Buffer, views and accessors agree.
    expect(json['buffers'][0]['byteLength'], bin.length);
    for (final v in json['bufferViews']) {
      expect(v['byteOffset'] + v['byteLength'] <= bin.length, isTrue);
      expect(v['byteOffset'] % 4, 0);
    }
    for (final a in json['accessors']) {
      final view = json['bufferViews'][a['bufferView']];
      final size = a['componentType'] == 5125 ? 4 : 12;
      expect(a['count'] * size, view['byteLength']);
    }

    final nodes = (json['nodes'] as List).cast<Map<String, dynamic>>();
    Map<String, dynamic> byName(String n) =>
        nodes.firstWhere((x) => x['name'] == n);
    expect(nodes.where((n) => n['name'] == 'Rejected'), isEmpty);
    expect(nodes.where((n) => n['name'] == 'Scan'), isEmpty);
    expect(json['asset']['extras']['skipped'], hasLength(1));
    expect(byName('First')['translation'], [0, 2.8, 0]);

    // Bounding box of everything but the slab (which hangs below zero).
    final lo = [9.0, 9.0, 9.0], hi = [-9.0, -9.0, -9.0];
    for (final n in nodes) {
      final m = n['mesh'];
      final cls = n['extras']['ifcClass'];
      if (m == null || cls == 'IfcSlab' || cls == 'IfcSpace') continue;
      for (final p in json['meshes'][m]['primitives']) {
        final a = json['accessors'][p['attributes']['POSITION']];
        for (var i = 0; i < 3; i++) {
          lo[i] = [lo[i], a['min'][i] as num]
              .reduce((x, y) => x < y ? x : y)
              .toDouble();
          hi[i] = [hi[i], a['max'][i] as num]
              .reduce((x, y) => x > y ? x : y)
              .toDouble();
        }
      }
    }
    expect(lo, [closeTo(-0.1, 1e-5), 0, closeTo(-0.1, 1e-5)]); // wall thickness
    expect(hi, [closeTo(4.1, 1e-5), closeTo(2.6, 1e-5), closeTo(3.1, 1e-5)]);
    final slab = json['accessors'][json['meshes'][byName('Slab')['mesh']]
        ['primitives'][0]['attributes']['POSITION']];
    expect(slab['min'][1], closeTo(-0.2, 1e-6));
    expect(slab['max'][1], 0);

    // Wall 0 has a door and a window: left, door-head, between, window below,
    // window above, right = 6 pieces; the other walls are one box (6 faces).
    List prims(String n) => json['meshes'][byName(n)['mesh']]['primitives'];
    expect(prims('Wall 0'), hasLength(6));
    expect(prims('Wall 1'), hasLength(1));
    expect(
        json['accessors'][prims('Wall 1')[0]['attributes']['POSITION']]
            ['count'],
        36);

    // Window: frame + translucent glass.
    final winMaterials = [
      for (final p in prims('Window')) json['materials'][p['material']]
    ];
    final glass = winMaterials.singleWhere((m) => m['name'] == 'glass');
    expect(glass['alphaMode'], 'BLEND');

    // Extras map a node back to its resource.
    expect(byName('Window')['extras'], {
      'subject': window.subject,
      'ifcClass': 'IfcWindow',
      'reviewState': 'proposed',
    });
    expect(byName('Wall 0')['extras']['subject'], wall.subject);
    expect(byName('Wall 0')['extras']['reviewState'], 'confirmed');

    // Normals are unit length and indices are in range.
    final n0 = json['meshes'][byName('Wall 1')['mesh']]['primitives'][0];
    final nor = json['bufferViews']
        [json['accessors'][n0['attributes']['NORMAL']]['bufferView']];
    final f = ByteData.sublistView(
        bin, nor['byteOffset'], nor['byteOffset'] + nor['byteLength']);
    for (var i = 0; i < f.lengthInBytes ~/ 12; i++) {
      final x = f.getFloat32(i * 12, Endian.little),
          y = f.getFloat32(i * 12 + 4, Endian.little),
          z = f.getFloat32(i * 12 + 8, Endian.little);
      expect(x * x + y * y + z * z, closeTo(1, 1e-5));
    }

    final out = Platform.environment['GLB_OUT'];
    if (out != null) File(out).writeAsBytesSync(glb);
  });

  test('ear clipping handles a concave L-shape', () async {
    final s = (await home.children()).firstWhere((r) => r.name == 'Ground');
    final l = await repo.createElement(
        s,
        'L',
        'IfcSlab',
        const Extrusion(polygon: [
          Pt(0, 0),
          Pt(4, 0),
          Pt(4, 1),
          Pt(1, 1),
          Pt(1, 3),
          Pt(0, 3)
        ], depth: 0.1));
    final (json, _) = parseGlb(exportGlb([
      StoreyExport(s, const [], [l])
    ]));
    final p = json['meshes'][0]['primitives'][0];
    // 6 vertices = 4 triangles on top and bottom, plus 6 side quads (2 each).
    expect(json['accessors'][p['attributes']['POSITION']]['count'],
        (4 + 4 + 12) * 3);
  });
}
