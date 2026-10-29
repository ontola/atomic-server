import 'dart:convert';
import 'dart:math' as math;

import 'package:atomic_store/atomic_store.dart';

import 'geometry.dart';
import 'repository.dart';
import 'room_align.dart';

/// A room scan as the native RoomPlan plugin returns it (JSON contract).
///
/// ```
/// {
///   "name": "Living room",          // optional
///   "storeyHeight": 2.6,            // optional, metres
///   "sessionId": "UUID",            // optional: the native capture session
///   "worldShared": true,            // optional: same ARKit world as the
///                                   // previous scan of that session
///   "surfaces": [{
///     "category": "wall",           // wall|door|window|opening|floor|ceiling
///     "id": "UUID",
///     "transform": [16 floats],     // column-major simd_float4x4, ARKit world
///     "dimensions": [w, h, d],      // metres, in the surface's local axes
///     "confidence": "high",         // low|medium|high
///     "parentId": "UUID"            // optional: the wall that hosts it
///   }],
///   "objects": [{ "category": "table", "id": "UUID", "transform": [...],
///                 "dimensions": [w, h, d], "confidence": "medium" }]
/// }
/// ```
///
/// ARKit world space is Y up, right-handed, metres. A transform's translation
/// (elements 12..14) is the item's centre; its local X axis is elements 0..2.
/// Walls run along local X for `w`; `h` is up (local Y); `d` is thickness.
class ScannedRoom {
  const ScannedRoom({
    this.name,
    this.storeyHeight,
    this.surfaces = const [],
    this.objects = const [],
    this.worldShared = false,
    this.sessionId,
  });

  factory ScannedRoom.fromJson(Map json) => ScannedRoom(
        name: json['name'] as String?,
        storeyHeight: (json['storeyHeight'] as num?)?.toDouble(),
        worldShared: json['worldShared'] == true,
        sessionId: json['sessionId'] as String?,
        surfaces: [
          for (final s in (json['surfaces'] as List? ?? const []))
            ScannedItem.fromJson(s as Map, surface: true),
        ],
        objects: [
          for (final o in (json['objects'] as List? ?? const []))
            ScannedItem.fromJson(o as Map),
        ],
      );

  /// Parses the JSON string the plugin returns. Throws [FormatException].
  factory ScannedRoom.parse(String source) {
    try {
      return ScannedRoom.fromJson(jsonDecode(source) as Map);
    } on TypeError catch (e) {
      throw FormatException('Not a room scan: $e');
    }
  }

  final String? name;
  final double? storeyHeight;
  final List<ScannedItem> surfaces;
  final List<ScannedItem> objects;

  /// True when the plugin kept one ARKit world since the previous scan of
  /// [sessionId]: this room's transforms are then in the same frame as that
  /// scan's and need no door matching.
  final bool worldShared;
  final String? sessionId;
}

/// A surface or an object of a [ScannedRoom].
class ScannedItem {
  const ScannedItem({
    required this.category,
    required this.id,
    required this.transform,
    required this.dimensions,
    this.confidence = 'low',
    this.parentId,
  });

  static const surfaceCategories = [
    'wall',
    'door',
    'window',
    'opening',
    'floor',
    'ceiling'
  ];

  factory ScannedItem.fromJson(Map json, {bool surface = false}) {
    final category = json['category'] as String;
    if (surface && !surfaceCategories.contains(category)) {
      throw FormatException('Unknown surface category "$category"');
    }
    final t = [
      for (final n in json['transform'] as List) (n as num).toDouble()
    ];
    final d = [
      for (final n in json['dimensions'] as List) (n as num).toDouble()
    ];
    if (t.length != 16) {
      throw const FormatException('transform needs 16 floats');
    }
    if (d.length != 3) throw const FormatException('dimensions needs 3 floats');
    return ScannedItem(
      category: category,
      id: json['id'] as String,
      transform: t,
      dimensions: d,
      confidence: json['confidence'] as String? ?? 'low',
      parentId: json['parentId'] as String?,
    );
  }

  final String category, id, confidence;
  final String? parentId;
  final List<double> transform, dimensions;

  /// The centre on the plan: ARKit (x, y up, z) becomes (x, -z).
  Pt get centre => Pt(transform[12], -transform[14]);

  /// Height of the centre above the ARKit origin.
  double get centreY => transform[13];

  /// The local X axis on the plan, unit length (ARKit (x, z) becomes (x, -z)).
  Pt get axisX {
    final (x, y) = (transform[0], -transform[2]);
    final n = math.sqrt(x * x + y * y);
    return n < 1e-9 ? const Pt(1, 0) : Pt(x / n, y / n);
  }

  double get confidenceValue =>
      const {'low': 0.3, 'medium': 0.6, 'high': 0.9}[confidence] ?? 0.3;
}

extension on Pt {
  Pt operator +(Pt o) => Pt(x + o.x, y + o.y);
  Pt operator -(Pt o) => Pt(x - o.x, y - o.y);
  Pt operator *(double k) => Pt(x * k, y * k);
  double dot(Pt o) => x * o.x + y * o.y;
}

/// The area of a polygon (shoelace), always positive.
double polygonArea(List<Pt> p) {
  var a = 0.0;
  for (var i = 0; i < p.length; i++) {
    final (q, r) = (p[i], p[(i + 1) % p.length]);
    a += q.x * r.y - r.x * q.y;
  }
  return a.abs() / 2;
}

/// The outline of [walls]: their end points, nearby ones merged (scans leave
/// gaps at corners), ordered by angle around the centroid. Right for convex
/// and most rectilinear rooms; an L-shaped room is approximated.
List<Pt> footprint(List<WallAxis> walls, {double merge = 0.25}) {
  final pts = <Pt>[];
  for (final w in walls) {
    for (final p in [w.start, w.end]) {
      final i = pts.indexWhere((q) => q.distanceTo(p) < merge);
      if (i < 0) {
        pts.add(p);
      } else {
        pts[i] = Pt((pts[i].x + p.x) / 2, (pts[i].y + p.y) / 2);
      }
    }
  }
  if (pts.length < 3) return const [];
  final c = Pt(pts.map((p) => p.x).reduce((a, b) => a + b) / pts.length,
      pts.map((p) => p.y).reduce((a, b) => a + b) / pts.length);
  double angle(Pt p) => math.atan2(p.y - c.y, p.x - c.x);
  return pts..sort((a, b) => angle(a).compareTo(angle(b)));
}

const _ifc = {
  'wall': 'IfcWall',
  'door': 'IfcDoor',
  'window': 'IfcWindow',
  'opening': 'IfcBuildingElementProxy',
};

String _label(String category) =>
    category[0].toUpperCase() + category.substring(1);

/// What [importScannedRoomChecked] did.
class ScanImport {
  const ScanImport(this.created,
      {this.alignment, this.needsDecision = false, this.reason});

  /// The proposed Spaces and Elements; empty when [needsDecision].
  final List<Resource> created;

  /// The transform applied, or null when the room went in as scanned.
  final Alignment? alignment;

  /// Nothing was imported: the room could not be placed with confidence. Ask
  /// the person, then call again with `alignment:` (the best guess, one of its
  /// `alternatives`, or [Alignment.identity] to keep the scan's own frame) or
  /// with `align: false`.
  final bool needsDecision;

  /// Why, when [needsDecision]: no matching opening, or an ambiguous best.
  final String? reason;

  /// The best guess when [needsDecision] (null when nothing matched).
  Alignment? get proposal => alignment;
}

/// Placements applied per storey and scan session, so a later scan of the same
/// session with `worldShared` reuses the first one's. Lives for the process.
final _sessionPlacements = <String, Alignment>{};

/// Like [importScannedRoom] but reports instead of guessing. When [align] and
/// the storey already holds scanned rooms the new room is moved against them
/// ([alignScannedRoom]); when that is not confident and [askIfUnsure], nothing
/// is imported and the result has `needsDecision`. A given [alignment] is used
/// as is. Scans of one native session with `worldShared` skip matching and
/// reuse the transform of the session's first scan.
Future<ScanImport> importScannedRoomChecked(
  BuildingRepository repo,
  Resource storey,
  ScannedRoom room, {
  String? sourceFileSubject,
  bool align = true,
  Alignment? alignment,
  bool askIfUnsure = true,
}) async {
  final key =
      room.sessionId == null ? null : '${storey.subject}|${room.sessionId}';
  var use = alignment;
  if (use == null && align) {
    final shared =
        room.worldShared && key != null ? _sessionPlacements[key] : null;
    if (shared != null) {
      use = shared;
    } else {
      final existing = await loadPlacedRooms(repo, storey);
      if (existing.isNotEmpty) {
        final found = alignScannedRoom(existing, room);
        if (found != null && found.isConfident) {
          use = found;
        } else if (askIfUnsure) {
          return ScanImport(const [],
              alignment: found,
              needsDecision: true,
              reason: found == null
                  ? 'No door or opening of this room matches one on the plan'
                  : 'Several placements fit about equally well');
        }
      }
    }
  }
  final placed = use == null ? room : applyAlignment(room, use);
  final created = await _import(repo, storey, placed, sourceFileSubject);
  if (key != null) _sessionPlacements[key] = use ?? Alignment.identity;
  return ScanImport(created, alignment: use);
}

/// Writes [room] into [storey] as proposals: a Source (`scan`), a completed
/// AnalysisRun (`RoomPlan`), one Space, a wall Element per wall, openings
/// hosted by the nearest wall and objects as furnishing footprints, each with
/// Evidence on the Source. Returns the proposed Spaces and Elements.
///
/// Every scan has its own ARKit origin, so with [align] (the default) and
/// scanned rooms already in the storey, the room is first moved to fit
/// against them through a shared door ([alignScannedRoom]); an explicit
/// [alignment] overrides that. This variant never asks: when no confident
/// placement exists the room goes in as scanned. To let the person decide use
/// [importScannedRoomChecked].
Future<List<Resource>> importScannedRoom(
  BuildingRepository repo,
  Resource storey,
  ScannedRoom room, {
  String? sourceFileSubject,
  bool align = true,
  Alignment? alignment,
}) async =>
    (await importScannedRoomChecked(repo, storey, room,
            sourceFileSubject: sourceFileSubject,
            align: align,
            alignment: alignment,
            askIfUnsure: false))
        .created;

Future<List<Resource>> _import(
  BuildingRepository repo,
  Resource storey,
  ScannedRoom room,
  String? sourceFileSubject,
) async {
  final home = await repo.store.getResource(storey.parent!);
  final name = room.name ?? 'Scanned room';
  final source = await repo.addSource(home, name, MediaKind.scan,
      file: sourceFileSubject, status: 'processed');
  final run = await repo.addAnalysisRun(
      home, 'RoomPlan scan: $name', 'RoomPlan',
      inputs: [source]);
  final created = <Resource>[];

  Future<Resource> track(Resource r, double confidence) async {
    await repo.addEvidence(home, source, r, confidence: confidence, run: run);
    created.add(r);
    return r;
  }

  const origin = Origin.import;
  final walls = room.surfaces.where((s) => s.category == 'wall').toList();
  // The floor of the scan: its lowest wall edge, so sills are above the floor.
  final floorY = walls.isEmpty
      ? 0.0
      : walls.map((w) => w.centreY - w.dimensions[1] / 2).reduce(math.min);

  final placed = <(ScannedItem, Resource, WallAxis)>[];
  for (final w in walls) {
    final half = w.axisX * (w.dimensions[0] / 2);
    final axis = WallAxis(
      start: w.centre - half,
      end: w.centre + half,
      height: w.dimensions[1],
      thickness: w.dimensions[2] > 0.01 ? w.dimensions[2] : 0.1,
    );
    final r = await repo.createElement(
        storey, 'Wall ${placed.length + 1}', _ifc['wall']!, axis,
        origin: origin, confidence: w.confidenceValue, run: run);
    placed.add((w, await track(r, w.confidenceValue), axis));
  }

  if (placed.isNotEmpty) {
    final outline = chainOutline([for (final (_, _, a) in placed) a]);
    if (outline.length >= 3) {
      final height =
          room.storeyHeight ?? placed.map((p) => p.$3.height).reduce(math.max);
      const c = 0.6;
      await track(
          await repo.createSpace(storey, name, 'other', outline,
              origin: origin, confidence: c, height: height, run: run),
          c);
    }
  }

  final counts = <String, int>{};
  for (final s in room.surfaces) {
    if (!const ['door', 'window', 'opening'].contains(s.category)) continue;
    final host = _hostOf(s, placed);
    if (host == null) continue; // nothing to hang it on
    final (_, hostRes, axis) = host;
    final u = (axis.end - axis.start) * (1 / axis.length);
    final along = (s.centre - axis.start).dot(u);
    final w = s.dimensions[0], h = s.dimensions[1];
    final opening = Opening(
      offset: math.max(0, math.min(along - w / 2, axis.length - w)),
      width: w,
      height: h,
      sill:
          s.category == 'window' ? math.max(0, s.centreY - h / 2 - floorY) : 0,
    );
    final n = counts.update(s.category, (n) => n + 1, ifAbsent: () => 1);
    await track(
        await repo.createElement(
            storey, '${_label(s.category)} $n', _ifc[s.category]!, opening,
            hostedBy: hostRes,
            origin: origin,
            confidence: s.confidenceValue,
            run: run),
        s.confidenceValue);
  }

  for (final o in room.objects) {
    final (x, z) = (o.axisX, Pt(-o.axisX.y, o.axisX.x));
    final (hw, hd) = (o.dimensions[0] / 2, o.dimensions[2] / 2);
    final c = o.centre;
    final n = counts.update(o.category, (n) => n + 1, ifAbsent: () => 1);
    await track(
        await repo.createElement(
            storey,
            '${_label(o.category)} $n',
            'IfcFurnishingElement',
            Extrusion(polygon: [
              c - x * hw - z * hd,
              c + x * hw - z * hd,
              c + x * hw + z * hd,
              c - x * hw + z * hd,
            ], depth: math.max(o.dimensions[1], 0.01)),
            origin: origin,
            confidence: o.confidenceValue,
            run: run),
        o.confidenceValue);
  }
  return created;
}

/// The wall named by `parentId`, else the wall whose axis is nearest.
(ScannedItem, Resource, WallAxis)? _hostOf(
  ScannedItem s,
  List<(ScannedItem, Resource, WallAxis)> walls,
) {
  final named = walls.where((w) => w.$1.id == s.parentId).firstOrNull;
  if (named != null) return named;
  (ScannedItem, Resource, WallAxis)? best;
  var bestD = double.infinity;
  for (final w in walls) {
    final a = w.$3;
    final ab = a.end - a.start;
    final t = ((s.centre - a.start).dot(ab) / ab.dot(ab)).clamp(0.0, 1.0);
    final d = s.centre.distanceTo(a.start + ab * t);
    if (d < bestD) (best, bestD) = (w, d);
  }
  return best;
}
