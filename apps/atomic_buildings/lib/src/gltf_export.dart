import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:atomic_store/atomic_store.dart';

import 'geometry.dart';
import 'repository.dart';
import 'terms.g.dart';

// glTF 2.0 (.glb) export of the twin.
//
// Coordinates: our plan is Z-up (x right, y forward, z up, metres, local to a
// storey). glTF is Y-up, right-handed, so a plan point (x, y, z) becomes
// glTF (x, z, -y): plan x -> x, plan y -> -z, up -> +y. That is a rotation,
// so triangle winding is kept. Each storey is a node translated by
// (0, elevation, 0). Geometry is built in plan space and converted last.
//
// Rejected items are skipped; proposed and confirmed are included. `mesh`
// geometry and items without valid geometry are skipped and listed in
// `notes` (and in `asset.extras.skipped`). Slabs hang below the storey
// elevation (top flush with it); other extrusions rise from it.

/// One storey with the Spaces and Elements that sit on it.
class StoreyExport {
  const StoreyExport(this.storey, this.spaces, this.elements);
  final Resource storey;
  final List<Resource> spaces, elements;
}

/// Gathers the storeys of [home] (a Home subject) and exports them.
Future<Uint8List> exportHomeGlb(BuildingRepository repo, String home) async {
  final all = await (await repo.store.getResource(home)).children();
  List<Resource> on(Resource s, String cls) => [
        for (final r in all)
          if (r.isA(cls) && r.getLink(Bldg.storey) == s.subject) r
      ];
  return exportGlb([
    for (final s in all.where((r) => r.isA(BuildingClass.storey)))
      StoreyExport(s, on(s, BuildingClass.space), on(s, BuildingClass.element)),
  ]);
}

typedef _V = (double, double, double);

_V _sub(_V a, _V b) => (a.$1 - b.$1, a.$2 - b.$2, a.$3 - b.$3);
double _dot(_V a, _V b) => a.$1 * b.$1 + a.$2 * b.$2 + a.$3 * b.$3;
_V _cross(_V a, _V b) => (
      a.$2 * b.$3 - a.$3 * b.$2,
      a.$3 * b.$1 - a.$1 * b.$3,
      a.$1 * b.$2 - a.$2 * b.$1
    );

/// Triangles with flat normals for one material, in plan space.
class _Prim {
  _Prim(this.material);
  final String material;
  final pos = <double>[], nor = <double>[];

  void _vertex(_V p, _V n) {
    pos.addAll([p.$1, p.$3, -p.$2]);
    nor.addAll([n.$1, n.$3, -n.$2]);
  }

  /// A planar convex polygon; with [inside] the normal is made to face away.
  void face(List<_V> v, {_V? inside}) {
    var n = (0.0, 0.0, 0.0);
    for (var i = 0; i < v.length; i++) {
      final c = _cross(v[i], v[(i + 1) % v.length]); // Newell
      n = (n.$1 + c.$1, n.$2 + c.$2, n.$3 + c.$3);
    }
    final len = math.sqrt(_dot(n, n));
    if (len == 0) return;
    n = (n.$1 / len, n.$2 / len, n.$3 / len);
    if (inside != null && _dot(n, _sub(v[0], inside)) < 0) {
      v = v.reversed.toList();
      n = (-n.$1, -n.$2, -n.$3);
    }
    for (var i = 1; i < v.length - 1; i++) {
      for (final p in [v[0], v[i], v[i + 1]]) {
        _vertex(p, n);
      }
    }
  }

  /// A box along the plan segment [a]-[b] from [t0] to [t1], [z0] to [z1].
  void box(Pt a, Pt b, double t0, double t1, double z0, double z1, double th) {
    final l = a.distanceTo(b);
    final d = ((b.x - a.x) / l, (b.y - a.y) / l);
    final n = (-d.$2 * th / 2, d.$1 * th / 2);
    _V c(double t, int side, double z) =>
        (a.x + d.$1 * t + n.$1 * side, a.y + d.$2 * t + n.$2 * side, z);
    final k = [
      for (final t in [t0, t1])
        for (final s in [-1, 1])
          for (final z in [z0, z1]) c(t, s, z),
    ]; // index = t*4 + side*2 + z
    final mid = c((t0 + t1) / 2, 0, (z0 + z1) / 2);
    for (final f in const [
      [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], // t0, t1, side -1
      [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3], // side +1, bottom, top
    ]) {
      face([for (final i in f) k[i]], inside: mid);
    }
  }

  /// A prism over [poly] from [z0] to [z1]; [sides] false gives a flat top.
  void prism(List<Pt> poly, double z0, double z1, {bool sides = true}) {
    final p = _ccw(poly);
    for (final t in _earClip(p)) {
      face([for (final i in t) (p[i].x, p[i].y, z1)]);
      if (sides) face([for (final i in t.reversed) (p[i].x, p[i].y, z0)]);
    }
    if (!sides) return;
    for (var i = 0; i < p.length; i++) {
      final (a, b) = (p[i], p[(i + 1) % p.length]);
      face([(a.x, a.y, z0), (b.x, b.y, z0), (b.x, b.y, z1), (a.x, a.y, z1)]);
    }
  }
}

double _area(List<Pt> p) {
  var s = 0.0;
  for (var i = 0; i < p.length; i++) {
    final (a, b) = (p[i], p[(i + 1) % p.length]);
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

List<Pt> _ccw(List<Pt> p) => _area(p) < 0 ? p.reversed.toList() : p;

/// Ear clipping of a counter-clockwise simple polygon (concave is fine);
/// returns triangles as index triples. Degenerate vertices are dropped.
List<List<int>> _earClip(List<Pt> p) {
  double cross(Pt a, Pt b, Pt c) =>
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  bool inside(Pt q, Pt a, Pt b, Pt c) =>
      cross(a, b, q) >= 0 && cross(b, c, q) >= 0 && cross(c, a, q) >= 0;
  final idx = [for (var i = 0; i < p.length; i++) i];
  final out = <List<int>>[];
  while (idx.length > 3) {
    var clipped = false;
    for (var i = 0; i < idx.length; i++) {
      final ia = idx[(i + idx.length - 1) % idx.length];
      final ib = idx[i], ic = idx[(i + 1) % idx.length];
      final (a, b, c) = (p[ia], p[ib], p[ic]);
      if (cross(a, b, c) <= 1e-12) continue; // reflex or flat
      if (idx
          .any((j) => j != ia && j != ib && j != ic && inside(p[j], a, b, c))) {
        continue;
      }
      out.add([ia, ib, ic]);
      idx.removeAt(i);
      clipped = true;
      break;
    }
    if (!clipped) idx.removeAt(0); // degenerate input: drop a vertex
  }
  if (idx.length == 3 && cross(p[idx[0]], p[idx[1]], p[idx[2]]) > 1e-12) {
    out.add(idx);
  }
  return out;
}

const _materials = <String, (List<double>, double, bool)>{
  // name: (baseColor rgba, roughness, translucent)
  'wall': ([0.93, 0.92, 0.9, 1], 0.95, false),
  'floor': ([0.58, 0.4, 0.24, 1], 0.7, false),
  'slab': ([0.62, 0.62, 0.6, 1], 0.9, false),
  'glass': ([0.6, 0.8, 0.9, 0.3], 0.05, true),
  'frame': ([0.25, 0.25, 0.27, 1], 0.5, false),
  'furniture': ([0.7, 0.66, 0.6, 1], 0.8, false),
  'default': ([0.7, 0.7, 0.7, 1], 0.9, false),
};

String _materialFor(String ifcClass) => switch (ifcClass) {
      'IfcWall' || 'IfcWallStandardCase' => 'wall',
      'IfcSlab' => 'slab',
      'IfcFurnishingElement' || 'IfcFurniture' => 'furniture',
      _ => 'default',
    };

double _number(Resource r, String prop) => switch (r.get(prop)) {
      FloatValue v => v.value,
      IntegerValue v => v.value.toDouble(),
      _ => 0,
    };

/// Builds a binary glTF from [storeys]. Skipped items are added to [notes].
Uint8List exportGlb(List<StoreyExport> storeys, {List<String>? notes}) {
  final skipped = notes ?? <String>[];
  final bin = BytesBuilder();
  final views = <Object>[], accessors = <Object>[], meshes = <Object>[];
  final used = <String, int>{};
  final nodes = <Map<String, Object?>>[];

  int accessor(
      TypedData data, int type, int count, Map<String, Object?> extra) {
    views.add({
      'buffer': 0,
      'byteOffset': bin.length,
      'byteLength': data.lengthInBytes,
      'target': type == 5125 ? 34963 : 34962,
    });
    bin.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
    accessors.add({
      'bufferView': views.length - 1,
      'componentType': type,
      'count': count,
      ...extra,
    });
    return accessors.length - 1;
  }

  int? mesh(List<_Prim> prims) {
    final primitives = <Object>[];
    for (final p in prims.where((p) => p.pos.isNotEmpty)) {
      final pos = Float32List.fromList(p.pos);
      final n = pos.length ~/ 3;
      final lo = [double.infinity, double.infinity, double.infinity];
      final hi = [-double.infinity, -double.infinity, -double.infinity];
      for (var i = 0; i < pos.length; i++) {
        lo[i % 3] = math.min(lo[i % 3], pos[i]);
        hi[i % 3] = math.max(hi[i % 3], pos[i]);
      }
      primitives.add({
        'attributes': {
          'POSITION':
              accessor(pos, 5126, n, {'type': 'VEC3', 'min': lo, 'max': hi}),
          'NORMAL':
              accessor(Float32List.fromList(p.nor), 5126, n, {'type': 'VEC3'}),
        },
        'indices': accessor(
            Uint32List.fromList([for (var i = 0; i < n; i++) i]),
            5125,
            n,
            {'type': 'SCALAR'}),
        'material': used.putIfAbsent(p.material, () => used.length),
        'mode': 4,
      });
    }
    if (primitives.isEmpty) return null;
    meshes.add({'primitives': primitives});
    return meshes.length - 1;
  }

  Map<String, Object?> node(Resource r, String ifcClass, List<_Prim> prims) => {
        'name': r.name ?? ifcClass,
        if (mesh(prims) case final m?) 'mesh': m,
        'extras': {
          'subject': r.subject,
          'ifcClass': ifcClass,
          'reviewState': r.reviewState,
        },
      };

  bool visible(Resource r) => !r.isRejected;

  final roots = <int>[];
  for (final s in storeys) {
    final children = <int>[];
    void add(Map<String, Object?> n) {
      nodes.add(n);
      children.add(nodes.length - 1);
    }

    for (final sp in s.spaces.where(visible)) {
      final outline = sp.boundary;
      if (outline == null) {
        skipped.add('${sp.subject}: space without a valid boundary');
        continue;
      }
      add(node(sp, 'IfcSpace',
          [_Prim('floor')..prism(outline, 0, 0.001, sides: false)]));
    }

    final elements = s.elements.where(visible).toList();
    final walls = {
      for (final e in elements)
        if (e.geometry is WallAxis) e.subject: e.geometry! as WallAxis
    };
    for (final e in elements) {
      final cls = e.getString(Bldg.ifcClass) ?? 'IfcBuildingElementProxy';
      final g = e.geometry;
      switch (g) {
        case WallAxis w:
          final cuts = [
            for (final o in elements)
              if (o.getLink(Bldg.hostedBy) == e.subject &&
                  o.geometry is Opening)
                o.geometry! as Opening
          ]..sort((a, b) => a.offset.compareTo(b.offset));
          final pieces = <_Prim>[]; // one primitive per wall segment
          void seg(double t0, double t1, double z0, double z1) {
            if (t1 - t0 > 1e-6 && z1 - z0 > 1e-6) {
              pieces.add(_Prim(_materialFor(cls))
                ..box(w.start, w.end, t0, t1, z0, z1, w.thickness));
            }
          }

          var t = 0.0;
          for (final o in cuts) {
            final a = o.offset.clamp(0.0, w.length),
                b = (o.offset + o.width).clamp(0.0, w.length);
            seg(t, a, 0, w.height);
            seg(a, b, 0, o.sill.clamp(0.0, w.height));
            seg(a, b, (o.sill + o.height).clamp(0.0, w.height), w.height);
            t = math.max(t, b);
          }
          seg(t, w.length, 0, w.height);
          add(node(e, cls, pieces));
        case Extrusion x:
          final z = cls == 'IfcSlab' ? (-x.depth, 0.0) : (0.0, x.depth);
          add(node(e, cls,
              [_Prim(_materialFor(cls))..prism(x.polygon, z.$1, z.$2)]));
        case Opening o:
          final w = walls[e.getLink(Bldg.hostedBy)];
          if (w == null) {
            skipped.add('${e.subject}: opening without a host wall');
            break;
          }
          final (t0, t1) = (o.offset, o.offset + o.width);
          final (z0, z1) = (o.sill, o.sill + o.height);
          const bar = 0.05;
          final th = w.thickness * 0.6;
          final frame = _Prim('frame')
            ..box(w.start, w.end, t0, t0 + bar, z0, z1, th)
            ..box(w.start, w.end, t1 - bar, t1, z0, z1, th)
            ..box(w.start, w.end, t0 + bar, t1 - bar, z1 - bar, z1, th);
          final glass = _Prim('glass');
          if (cls == 'IfcWindow') {
            frame.box(w.start, w.end, t0 + bar, t1 - bar, z0, z0 + bar, th);
            glass.box(
                w.start, w.end, t0 + bar, t1 - bar, z0 + bar, z1 - bar, 0.02);
          }
          add(node(e, cls, [frame, glass]));
        case Mesh():
          skipped.add('${e.subject}: mesh geometry is not exported');
        case null:
          skipped.add('${e.subject}: no valid geometry');
      }
    }
    nodes.add({
      'name': s.storey.name ?? 'Storey',
      'translation': [0.0, _number(s.storey, Bldg.elevation), 0.0],
      if (children.isNotEmpty) 'children': children,
      'extras': {
        'subject': s.storey.subject,
        'ifcClass': 'IfcBuildingStorey',
        'reviewState': null,
      },
    });
    roots.add(nodes.length - 1);
  }

  final names = used.keys.toList()
    ..sort((a, b) => used[a]!.compareTo(used[b]!));
  final json = jsonEncode({
    'asset': {
      'version': '2.0',
      'generator': 'atomic_buildings',
      'extras': {'skipped': skipped},
    },
    'scene': 0,
    'scenes': [
      {'nodes': roots}
    ],
    'nodes': nodes,
    'meshes': meshes,
    'materials': [
      for (final n in names)
        {
          'name': n,
          'pbrMetallicRoughness': {
            'baseColorFactor': _materials[n]!.$1,
            'metallicFactor': 0,
            'roughnessFactor': _materials[n]!.$2,
          },
          'doubleSided': _materials[n]!.$3,
          if (_materials[n]!.$3) 'alphaMode': 'BLEND',
        }
    ],
    if (accessors.isNotEmpty) ...{
      'accessors': accessors,
      'bufferViews': views,
      'buffers': [
        {'byteLength': bin.length}
      ],
    },
  });

  List<int> padded(List<int> b, int fill) =>
      [...b, ...List.filled((4 - b.length % 4) % 4, fill)];
  final jsonBytes = padded(utf8.encode(json), 0x20);
  final binBytes = padded(bin.toBytes(), 0);
  final hasBin = binBytes.isNotEmpty;
  final total = 12 + 8 + jsonBytes.length + (hasBin ? 8 + binBytes.length : 0);
  final out = BytesBuilder();
  Uint8List u32(List<int> v) => Uint32List.fromList(v).buffer.asUint8List();
  out.add(u32([0x46546C67, 2, total, jsonBytes.length, 0x4E4F534A]));
  out.add(jsonBytes);
  if (hasBin) {
    out.add(u32([binBytes.length, 0x004E4942]));
    out.add(binBytes);
  }
  return out.toBytes();
}
