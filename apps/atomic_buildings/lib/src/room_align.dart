import 'dart:math' as math;

import 'package:atomic_store/atomic_store.dart';

import 'geometry.dart';
import 'repository.dart';
import 'roomplan.dart';
import 'terms.g.dart';

/// A door or opening of a [PlanRoom], on the plan.
class PlanOpening {
  const PlanOpening(this.centre, this.width, this.wall,
      {this.category = 'door'});

  /// The centre on the host wall's axis.
  final Pt centre;
  final double width;

  /// Index into [PlanRoom.walls].
  final int wall;
  final String category;
}

/// A room as the aligner sees it: wall axes, its doors/openings and an outline,
/// all in plan coordinates (the storey's for placed rooms, the scan's own for a
/// new one).
class PlanRoom {
  PlanRoom(this.walls, this.openings, [List<Pt>? outline])
      : outline = outline ?? chainOutline(walls);

  /// A scan in its own coordinates, the way [importScannedRoom] reads it.
  factory PlanRoom.fromScanned(ScannedRoom room) {
    final items = room.surfaces
        .where((s) => s.category == 'wall')
        .toList(growable: false);
    final walls = [for (final w in items) wallAxisOf(w)];
    final openings = <PlanOpening>[];
    for (final s in room.surfaces) {
      if (s.category != 'door' && s.category != 'opening') continue;
      var host = items.indexWhere((w) => w.id == s.parentId);
      if (host < 0) host = nearestWall(walls, s.centre);
      if (host < 0) continue;
      openings.add(PlanOpening(
          projectOnWall(walls[host], s.centre), s.dimensions[0], host,
          category: s.category));
    }
    return PlanRoom(walls, openings);
  }

  final List<WallAxis> walls;
  final List<PlanOpening> openings;
  final List<Pt> outline;

  PlanRoom transformed(Alignment a) => PlanRoom([
        for (final w in walls)
          WallAxis(
              start: a.apply(w.start),
              end: a.apply(w.end),
              height: w.height,
              thickness: w.thickness)
      ], [
        for (final o in openings)
          PlanOpening(a.apply(o.centre), o.width, o.wall, category: o.category)
      ], [
        for (final p in outline) a.apply(p)
      ]);
}

/// A rigid 2D transform (rotation about the plan origin, then translation) that
/// places a scanned room against the plan. Never scales.
class Alignment {
  const Alignment({
    required this.rotation,
    required this.tx,
    required this.ty,
    this.score = 1,
    this.confidence = 1,
    this.ambiguous = false,
    this.alternatives = const [],
    this.matchedRoom,
    this.matchedAt,
  });

  static const identity = Alignment(rotation: 0, tx: 0, ty: 0);

  /// Radians, counter-clockwise on the plan (y up).
  final double rotation;
  final double tx, ty;

  /// 0..1: overlap, collinearity and width fit of this candidate alone.
  final double score;

  /// 0..1: [score], lowered when another placement scores almost as well.
  final double confidence;

  /// The runner-up scored within 15 % of the best (e.g. two identical doors).
  final bool ambiguous;

  /// The other distinct candidates, best first (empty for an alternative).
  final List<Alignment> alternatives;

  /// Index in the `existing` list of the room whose opening was matched, and
  /// where that opening is on the plan.
  final int? matchedRoom;
  final Pt? matchedAt;

  /// Trusted without asking: no near tie and a good score.
  bool get isConfident => !ambiguous && confidence >= confidentThreshold;

  static const confidentThreshold = 0.6;

  Pt apply(Pt p) {
    final (c, s) = (math.cos(rotation), math.sin(rotation));
    return Pt(c * p.x - s * p.y + tx, s * p.x + c * p.y + ty);
  }

  Alignment _with(
          {double? confidence,
          bool? ambiguous,
          List<Alignment>? alternatives}) =>
      Alignment(
          rotation: rotation,
          tx: tx,
          ty: ty,
          score: score,
          confidence: confidence ?? this.confidence,
          ambiguous: ambiguous ?? this.ambiguous,
          alternatives: alternatives ?? this.alternatives,
          matchedRoom: matchedRoom,
          matchedAt: matchedAt);

  @override
  String toString() =>
      'Alignment(${(rotation * 180 / math.pi).toStringAsFixed(1)} deg, '
      '($tx, $ty), score ${score.toStringAsFixed(2)}, '
      'confidence ${confidence.toStringAsFixed(2)})';
}

/// The axis of a scanned wall on the plan.
WallAxis wallAxisOf(ScannedItem w) {
  final half = w.axisX;
  final l = w.dimensions[0] / 2;
  return WallAxis(
    start: Pt(w.centre.x - half.x * l, w.centre.y - half.y * l),
    end: Pt(w.centre.x + half.x * l, w.centre.y + half.y * l),
    height: w.dimensions[1],
    thickness: w.dimensions[2] > 0.01 ? w.dimensions[2] : 0.1,
  );
}

/// The point of [a]'s axis nearest [p].
Pt projectOnWall(WallAxis a, Pt p) {
  final (dx, dy) = (a.end.x - a.start.x, a.end.y - a.start.y);
  final t =
      (((p.x - a.start.x) * dx + (p.y - a.start.y) * dy) / (dx * dx + dy * dy))
          .clamp(0.0, 1.0);
  return Pt(a.start.x + dx * t, a.start.y + dy * t);
}

/// Index of the wall nearest [p], or -1.
int nearestWall(List<WallAxis> walls, Pt p) {
  var best = -1;
  var bestD = double.infinity;
  for (var i = 0; i < walls.length; i++) {
    final d = projectOnWall(walls[i], p).distanceTo(p);
    if (d < bestD) (best, bestD) = (i, d);
  }
  return best;
}

/// The outline of [walls] by chaining them end to end (corner gaps up to
/// [gap] are bridged). Handles L-shaped rooms and corridors; falls back to
/// [footprint] when the walls do not form one closed loop.
List<Pt> chainOutline(List<WallAxis> walls, {double gap = 0.4}) {
  if (walls.length < 3) return const [];
  final left = [...walls];
  final first = left.removeAt(0);
  final pts = [first.start];
  var cur = first.end;
  while (left.isNotEmpty) {
    var bi = -1, bFlip = false;
    var bd = gap;
    for (var i = 0; i < left.length; i++) {
      final ds = left[i].start.distanceTo(cur),
          de = left[i].end.distanceTo(cur);
      if (ds < bd) (bi, bFlip, bd) = (i, false, ds);
      if (de < bd) (bi, bFlip, bd) = (i, true, de);
    }
    if (bi < 0) break;
    final w = left.removeAt(bi);
    pts.add(bFlip ? w.end : w.start);
    cur = bFlip ? w.start : w.end;
  }
  if (left.isEmpty && cur.distanceTo(pts.first) < gap && pts.length >= 3) {
    return pts;
  }
  return footprint(walls);
}

bool _inside(List<Pt> poly, double x, double y) {
  var c = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    final (a, b) = (poly[i], poly[j]);
    if ((a.y > y) != (b.y > y) &&
        x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) {
      c = !c;
    }
  }
  return c;
}

(double, double, double, double) _bbox(List<Pt> p) => (
      p.map((q) => q.x).reduce(math.min),
      p.map((q) => q.y).reduce(math.min),
      p.map((q) => q.x).reduce(math.max),
      p.map((q) => q.y).reduce(math.max),
    );

/// The area where two (possibly concave) polygons overlap, by sampling a grid.
double overlapArea(List<Pt> a, List<Pt> b, {double step = 0.1}) {
  if (a.length < 3 || b.length < 3) return 0;
  final (ax0, ay0, ax1, ay1) = _bbox(a);
  final (bx0, by0, bx1, by1) = _bbox(b);
  final (x0, y0) = (math.max(ax0, bx0), math.max(ay0, by0));
  final (x1, y1) = (math.min(ax1, bx1), math.min(ay1, by1));
  if (x0 >= x1 || y0 >= y1) return 0;
  var n = 0;
  for (var x = x0 + step / 2; x < x1; x += step) {
    for (var y = y0 + step / 2; y < y1; y += step) {
      if (_inside(a, x, y) && _inside(b, x, y)) n++;
    }
  }
  return n * step * step;
}

/// Which side of the line through [p] along [u] most of [poly] lies on: +1
/// (left of u), -1 (right), area-weighted by distance.
int _sideOf(List<Pt> poly, Pt p, Pt u) {
  final (x0, y0, x1, y1) = _bbox(poly);
  var sum = 0.0;
  const step = 0.15;
  for (var x = x0 + step / 2; x < x1; x += step) {
    for (var y = y0 + step / 2; y < y1; y += step) {
      if (_inside(poly, x, y)) sum += u.x * (y - p.y) - u.y * (x - p.x);
    }
  }
  return sum >= 0 ? 1 : -1;
}

Pt _unit(WallAxis w) {
  final l = w.length;
  return Pt((w.end.x - w.start.x) / l, (w.end.y - w.start.y) / l);
}

/// Total length over which [a]'s walls lie on the same line as a wall of [b].
double _collinearLength(List<WallAxis> a, List<WallAxis> b) {
  var total = 0.0;
  for (final w in a) {
    final u = _unit(w);
    for (final v in b) {
      final t = _unit(v);
      if ((u.x * t.y - u.y * t.x).abs() > 0.07) continue; // not parallel
      final mid = Pt((w.start.x + w.end.x) / 2, (w.start.y + w.end.y) / 2);
      final off = (mid.x - v.start.x) * t.y - (mid.y - v.start.y) * t.x;
      if (off.abs() > 0.08) continue;
      double along(Pt p) => (p.x - v.start.x) * t.x + (p.y - v.start.y) * t.y;
      final (a0, a1) = (along(w.start), along(w.end));
      final lo = math.max(math.min(a0, a1), 0.0);
      final hi = math.min(math.max(a0, a1), v.length);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

double _area(List<Pt> p) => polygonArea(p);

/// Places [incoming] (in its own scan coordinates) against [existing] (already
/// on the plan) by making one of its doors/openings coincide with one of
/// theirs.
///
/// Candidates are all door/opening pairs of similar width (within 15 cm). For
/// each, the rotation makes the two host walls collinear and the translation
/// makes the openings coincide, with the new room on the opposite side of the
/// wall. A candidate is rejected when the room footprints overlap by more than
/// 20 % of the new room, else scored on overlap, width fit and how much of the
/// new walls lie on existing wall lines. Returns the best, carrying a
/// confidence and the other distinct candidates; null when nothing matches
/// (no openings, no similar width, or only overlapping placements).
Alignment? alignScannedRoom(List<PlanRoom> existing, ScannedRoom incoming) {
  final inc = PlanRoom.fromScanned(incoming);
  if (inc.outline.length < 3 || inc.openings.isEmpty) return null;
  final incArea = _area(inc.outline);
  if (incArea < 1e-6) return null;
  final allExisting = [for (final e in existing) ...e.walls];

  final found = <Alignment>[];
  for (var ei = 0; ei < existing.length; ei++) {
    final e = existing[ei];
    if (e.outline.length < 3) continue;
    for (final oe in e.openings) {
      final we = e.walls[oe.wall];
      final ue = _unit(we);
      final se = _sideOf(e.outline, we.start, ue);
      for (final oi in inc.openings) {
        final dw = (oe.width - oi.width).abs();
        if (dw > 0.15) continue;
        final wi = inc.walls[oi.wall];
        final ui = _unit(wi);
        final si = _sideOf(inc.outline, wi.start, ui);
        // The rooms must end up on opposite sides of the shared wall.
        final u = si == -se ? ue : Pt(-ue.x, -ue.y);
        final theta = math.atan2(u.y, u.x) - math.atan2(ui.y, ui.x);
        final (c, s) = (math.cos(theta), math.sin(theta));
        final rc = Pt(c * oi.centre.x - s * oi.centre.y,
            s * oi.centre.x + c * oi.centre.y);
        final cand = Alignment(
            rotation: theta,
            tx: oe.centre.x - rc.x,
            ty: oe.centre.y - rc.y,
            matchedRoom: ei,
            matchedAt: oe.centre);
        final moved = inc.transformed(cand);
        var overlap = 0.0;
        for (final other in existing) {
          overlap += overlapArea(moved.outline, other.outline);
        }
        final f = overlap / incArea;
        if (f > 0.2) continue;
        final collin = math.min(
            1.0, _collinearLength(moved.walls, allExisting) / wi.length);
        final score = (1 - math.min(1.0, f * 5)) *
            (1 - 0.3 * dw / 0.15) *
            (0.7 + 0.3 * collin);
        found.add(Alignment(
            rotation: theta,
            tx: cand.tx,
            ty: cand.ty,
            score: score,
            confidence: score,
            matchedRoom: ei,
            matchedAt: oe.centre));
      }
    }
  }
  if (found.isEmpty) return null;
  found.sort((a, b) => b.score.compareTo(a.score));

  // Distinct placements only: the same transform from two door pairs is one.
  final probe = inc.outline.first;
  bool same(Alignment a, Alignment b) {
    var d = (a.rotation - b.rotation) % (2 * math.pi);
    if (d > math.pi) d -= 2 * math.pi;
    return d.abs() < 0.05 && a.apply(probe).distanceTo(b.apply(probe)) < 0.1;
  }

  final distinct = <Alignment>[];
  for (final a in found) {
    if (!distinct.any((d) => same(d, a))) distinct.add(a);
  }
  final best = distinct.first;
  final rest = distinct.skip(1).toList();
  if (best.score <= 0) return best._with(confidence: 0, ambiguous: true);
  final ratio = rest.isEmpty ? 0.0 : rest.first.score / best.score;
  final ambiguous = ratio >= 0.85;
  var confidence = best.score * (1 - 0.5 * ratio);
  if (ambiguous) confidence = math.min(confidence, 0.35);
  return best._with(
      confidence: confidence, ambiguous: ambiguous, alternatives: rest);
}

/// [room] moved by [a] in plan space: every surface and object transform stays
/// a valid ARKit matrix (a rotation about Y plus a translation on the ground
/// plane); dimensions, heights and ids are unchanged.
ScannedRoom applyAlignment(ScannedRoom room, Alignment a) {
  final (c, s) = (math.cos(a.rotation), math.sin(a.rotation));
  // Plan (x, y) is ARKit (x, -z): x' = c x - s y + tx, y' = s x + c y + ty
  // becomes X' = c X + s Z + tx, Z' = -s X + c Z - ty. Column-major, so each
  // column (a direction, or the translation with w = 1) is mapped alone.
  List<double> move(List<double> m) {
    final out = List<double>.of(m);
    for (var j = 0; j < 4; j++) {
      final (x, z, w) = (m[4 * j], m[4 * j + 2], m[4 * j + 3]);
      out[4 * j] = c * x + s * z + a.tx * w;
      out[4 * j + 2] = -s * x + c * z - a.ty * w;
    }
    return out;
  }

  ScannedItem item(ScannedItem i) => ScannedItem(
        category: i.category,
        id: i.id,
        transform: move(i.transform),
        dimensions: i.dimensions,
        confidence: i.confidence,
        parentId: i.parentId,
      );
  return ScannedRoom(
    name: room.name,
    storeyHeight: room.storeyHeight,
    surfaces: [for (final i in room.surfaces) item(i)],
    objects: [for (final i in room.objects) item(i)],
    worldShared: room.worldShared,
    sessionId: room.sessionId,
  );
}

/// The scanned rooms already on [storey], one [PlanRoom] per AnalysisRun that
/// created walls (a scan is one run): wall axes, door/opening centres on their
/// hosts and the Space boundary as outline. Rejected elements are skipped;
/// elements without a run (drawn by hand) are not rooms and are ignored.
Future<List<PlanRoom>> loadPlacedRooms(
    BuildingRepository repo, Resource storey) async {
  final home = await repo.store.getResource(storey.parent!);
  final all = [
    for (final r in await home.children())
      if (!r.isRejected && r.getLink(Bldg.storey) == storey.subject) r
  ];
  final byRun = <String, List<Resource>>{};
  for (final r in all) {
    final run = r.getLink(Bldg.createdByRun);
    if (run != null) byRun.putIfAbsent(run, () => []).add(r);
  }
  final rooms = <PlanRoom>[];
  for (final group in byRun.values) {
    final walls = <WallAxis>[];
    final wallOf = <String, int>{};
    for (final r in group) {
      final g = r.geometry;
      if (r.isA(BuildingClass.element) && g is WallAxis) {
        wallOf[r.subject] = walls.length;
        walls.add(g);
      }
    }
    if (walls.length < 3) continue;
    final openings = <PlanOpening>[];
    for (final r in group) {
      final g = r.geometry;
      final host = wallOf[r.getLink(Bldg.hostedBy)];
      final ifc = r.getString(Bldg.ifcClass);
      if (g is! Opening || host == null) continue;
      if (ifc != 'IfcDoor' && ifc != 'IfcBuildingElementProxy') continue;
      final w = walls[host];
      final u = _unit(w);
      final at = g.offset + g.width / 2;
      openings.add(PlanOpening(
          Pt(w.start.x + u.x * at, w.start.y + u.y * at), g.width, host,
          category: ifc == 'IfcDoor' ? 'door' : 'opening'));
    }
    final space = group.where((r) => r.isA(BuildingClass.space)).firstOrNull;
    final boundary = space?.boundary;
    rooms.add(PlanRoom(walls, openings,
        boundary != null && boundary.length >= 3 ? boundary : null));
  }
  return rooms;
}
