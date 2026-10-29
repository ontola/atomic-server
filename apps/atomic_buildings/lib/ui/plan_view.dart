import 'dart:math' as math;

import 'package:atomic_store/atomic_store.dart';
import 'package:flutter/material.dart';

import '../src/geometry.dart';
import '../src/repository.dart';
import '../src/room_scanner.dart';
import '../src/roomplan.dart';
import '../src/terms.g.dart';
import 'common.dart';

/// A storey selector over a 2D plan of the chosen storey.
class PlanView extends StatefulWidget {
  const PlanView(this.repo, this.home, {super.key, required this.scanner});
  final BuildingRepository repo;
  final Resource home;
  final RoomScanner scanner;

  @override
  State<PlanView> createState() => _PlanViewState();
}

class _PlanViewState extends State<PlanView> {
  String? _storey;
  late final Future<bool> _canScan = widget.scanner.isSupported();

  Future<void> _scan(Resource storey) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final room = await widget.scanner.scan();
      if (room == null) return;
      final items = await importScannedRoom(widget.repo, storey, room);
      messenger.showSnackBar(SnackBar(
          content:
              Text('${items.length} items proposed, review them on the plan')));
    } on Object catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Scan failed: $e')));
    }
  }

  @override
  Widget build(BuildContext context) => Watch(
        stream: () => widget.repo.watchStoreys(widget.home),
        builder: (context, found) {
          final storeys = [...found]
            ..sort((a, b) => _elevation(a).compareTo(_elevation(b)));
          final current =
              storeys.where((s) => s.subject == _storey).firstOrNull ??
                  storeys.firstOrNull;
          return Stack(children: [
            Column(children: [
              SizedBox(
                height: 56,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.all(8),
                  children: [
                    for (final s in storeys)
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          label: Text(s.name ?? '?'),
                          selected: s == current,
                          onSelected: (_) =>
                              setState(() => _storey = s.subject),
                        ),
                      ),
                    ActionChip(
                      avatar: const Icon(Icons.add),
                      label: const Text('Storey'),
                      onPressed: () async {
                        final name =
                            await askText(context, 'Name of the storey');
                        if (name == null) return;
                        await widget.repo.createStorey(
                          widget.home,
                          name,
                          elevation: storeys.length * 2.8,
                          level: storeys.length,
                        );
                      },
                    ),
                  ],
                ),
              ),
              Expanded(
                child: current == null
                    ? const Center(child: Text('Add a storey to start'))
                    : _Plan(
                        key: ValueKey(current.subject),
                        repo: widget.repo,
                        storey: current),
              ),
            ]),
            if (current != null)
              Positioned(
                right: 16,
                bottom: 16,
                child: FutureBuilder(
                  future: _canScan,
                  builder: (context, snap) => snap.data != true
                      ? const SizedBox()
                      : FloatingActionButton.extended(
                          onPressed: () => _scan(current),
                          icon: const Icon(Icons.view_in_ar),
                          label: const Text('Scan room'),
                        ),
                ),
              ),
          ]);
        },
      );

  double _elevation(Resource s) =>
      (s.get(Bldg.elevation) as FloatValue?)?.value ?? 0;
}

class _Plan extends StatelessWidget {
  const _Plan({super.key, required this.repo, required this.storey});
  final BuildingRepository repo;
  final Resource storey;

  @override
  Widget build(BuildContext context) => Watch(
        stream: () => repo.watchSpaces(storey),
        builder: (context, spaces) => Watch(
          stream: () => repo.watchElements(storey),
          builder: (context, elements) {
            final plan =
                Plan([...spaces, ...elements].where((r) => !r.isRejected));
            final scheme = Theme.of(context).colorScheme;
            return LayoutBuilder(
              builder: (context, box) {
                final size = box.biggest;
                return GestureDetector(
                  onTapUp: (d) {
                    final hit = plan.hit(d.localPosition, size);
                    if (hit != null) _showItem(context, hit);
                  },
                  child: CustomPaint(
                    size: size,
                    painter: PlanPainter(plan, scheme),
                  ),
                );
              },
            );
          },
        ),
      );

  void _showItem(BuildContext context, Resource item) =>
      showModalBottomSheet<void>(
        context: context,
        builder: (context) => ItemSheet(repo, item),
      );
}

/// What a tapped plan item says: its review state and the Evidence behind it,
/// with Confirm and Reject.
class ItemSheet extends StatelessWidget {
  const ItemSheet(this.repo, this.item, {super.key});
  final BuildingRepository repo;
  final Resource item;

  @override
  Widget build(BuildContext context) {
    final confidence = (item.get(Bldg.confidence) as FloatValue?)?.value;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(item.name ?? '', style: Theme.of(context).textTheme.titleLarge),
          Text('${item.getString(Bldg.origin)} · ${item.reviewState}'
              '${confidence == null ? '' : ' · ${(confidence * 100).round()}%'}'),
          const SizedBox(height: 8),
          FutureBuilder(
            future: repo.evidenceFor(item),
            builder: (context, snap) {
              final evidence = snap.data ?? const [];
              if (evidence.isEmpty) return const Text('No evidence yet');
              return Column(children: [
                for (final e in evidence)
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.fact_check),
                    title: Text(e.source.name ?? '(source)'),
                    subtitle: Text(e.source.getString(Bldg.mediaKind) ?? ''),
                  ),
              ]);
            },
          ),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            OutlinedButton(
              onPressed: () async {
                await repo.reject(item);
                if (context.mounted) Navigator.pop(context);
              },
              child: const Text('Reject'),
            ),
            const SizedBox(width: 8),
            FilledButton(
              onPressed: () async {
                await repo.confirm(item);
                if (context.mounted) Navigator.pop(context);
              },
              child: const Text('Confirm'),
            ),
          ]),
        ],
      ),
    );
  }
}

/// The drawable items of one storey, parsed once, with their layout.
class Plan {
  Plan(Iterable<Resource> items) {
    for (final r in items) {
      if (r.isA(BuildingClass.space)) {
        final b = r.boundary;
        if (b != null) spaces.add((r, b));
      } else if (r.geometry case final Geometry g) {
        elements.add((r, g));
      }
    }
  }

  final spaces = <(Resource, List<Pt>)>[];
  final elements = <(Resource, Geometry)>[];

  WallAxis? host(Resource opening) {
    final h = opening.getLink(Bldg.hostedBy);
    for (final (r, g) in elements) {
      if (r.subject == h && g is WallAxis) return g;
    }
    return null;
  }

  /// The segment of an opening along its host wall.
  (Pt, Pt) span(Opening o, WallAxis wall) {
    final len = wall.length;
    final dx = (wall.end.x - wall.start.x) / len,
        dy = (wall.end.y - wall.start.y) / len;
    Pt at(double d) => Pt(wall.start.x + dx * d, wall.start.y + dy * d);
    return (at(o.offset), at(o.offset + o.width));
  }

  Iterable<Pt> get _points sync* {
    for (final (_, b) in spaces) {
      yield* b;
    }
    for (final (_, g) in elements) {
      switch (g) {
        case WallAxis():
          yield g.start;
          yield g.end;
        case Extrusion():
          yield* g.polygon;
        case Opening() || Mesh():
          break;
      }
    }
  }

  /// Fits the points into [size], Y up, with a margin.
  PlanFit fit(Size size) {
    final pts = _points.toList();
    if (pts.isEmpty) return PlanFit(0, 0, 1, size.height);
    final minX = pts.map((p) => p.x).reduce(math.min),
        maxX = pts.map((p) => p.x).reduce(math.max);
    final minY = pts.map((p) => p.y).reduce(math.min),
        maxY = pts.map((p) => p.y).reduce(math.max);
    const m = 24.0;
    final s = math.min((size.width - 2 * m) / math.max(maxX - minX, 0.1),
        (size.height - 2 * m) / math.max(maxY - minY, 0.1));
    return PlanFit(minX, minY, s, size.height - m, m);
  }

  /// The item under [at], elements before spaces.
  Resource? hit(Offset at, Size size) {
    final f = fit(size);
    final p = f.toModel(at);
    final slop = 12 / f.scale;
    for (final (r, g) in elements.reversed) {
      final near = switch (g) {
        WallAxis() =>
          _distance(p, g.start, g.end) <= math.max(g.thickness / 2, slop),
        Opening() => switch (host(r)) {
            final w? => _distance(p, span(g, w).$1, span(g, w).$2) <= slop,
            _ => false,
          },
        Extrusion() => _inside(p, g.polygon),
        Mesh() => false,
      };
      if (near) return r;
    }
    for (final (r, b) in spaces) {
      if (_inside(p, b)) return r;
    }
    return null;
  }

  static double _distance(Pt p, Pt a, Pt b) {
    final dx = b.x - a.x, dy = b.y - a.y;
    final t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))
        .clamp(0.0, 1.0);
    return p.distanceTo(Pt(a.x + t * dx, a.y + t * dy));
  }

  static bool _inside(Pt p, List<Pt> poly) {
    var in_ = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      final a = poly[i], b = poly[j];
      if ((a.y > p.y) != (b.y > p.y) &&
          p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
        in_ = !in_;
      }
    }
    return in_;
  }
}

/// Model metres to canvas pixels (and back).
class PlanFit {
  const PlanFit(this.minX, this.minY, this.scale, this.bottom,
      [this.margin = 0]);
  final double minX, minY, scale, bottom, margin;

  Offset toCanvas(Pt p) =>
      Offset(margin + (p.x - minX) * scale, bottom - (p.y - minY) * scale);
  Pt toModel(Offset o) =>
      Pt((o.dx - margin) / scale + minX, (bottom - o.dy) / scale + minY);
}

/// Walls as thick lines, rooms as filled polygons, openings as gaps in their
/// wall. Proposed items are dashed, confirmed ones solid.
class PlanPainter extends CustomPainter {
  PlanPainter(this.plan, this.scheme);
  final Plan plan;
  final ColorScheme scheme;

  @override
  void paint(Canvas canvas, Size size) {
    final f = plan.fit(size);
    Path poly(List<Pt> pts) =>
        Path()..addPolygon([for (final p in pts) f.toCanvas(p)], true);

    void stroke(Resource r, Path path, Paint paint) {
      if (!r.isProposed) return canvas.drawPath(path, paint);
      for (final m in path.computeMetrics()) {
        for (var d = 0.0; d < m.length; d += 12) {
          canvas.drawPath(m.extractPath(d, math.min(d + 6, m.length)), paint);
        }
      }
    }

    for (final (r, b) in plan.spaces) {
      canvas.drawPath(
        poly(b),
        Paint()
          ..color = scheme.primaryContainer
              .withValues(alpha: r.isProposed ? 0.4 : 0.9),
      );
      stroke(
          r,
          poly(b),
          Paint()
            ..color = scheme.primary
            ..style = PaintingStyle.stroke);
    }
    for (final (r, g) in plan.elements) {
      final line = Paint()
        ..color = r.isProposed ? scheme.tertiary : scheme.onSurface
        ..style = PaintingStyle.stroke;
      switch (g) {
        case WallAxis():
          stroke(
              r,
              Path()
                ..addPolygon([f.toCanvas(g.start), f.toCanvas(g.end)], false),
              line..strokeWidth = math.max(g.thickness * f.scale, 2));
        case Extrusion():
          stroke(r, poly(g.polygon), line..strokeWidth = 2);
        case Opening() || Mesh():
          break;
      }
    }
    // Openings last: a gap in the wall is the background drawn over it.
    for (final (r, g) in plan.elements) {
      if (g case Opening()) {
        final wall = plan.host(r);
        if (wall == null) continue;
        final (a, b) = plan.span(g, wall);
        canvas.drawLine(
            f.toCanvas(a),
            f.toCanvas(b),
            Paint()
              ..color = scheme.surface
              ..strokeWidth = math.max(wall.thickness * f.scale, 2) + 2);
      }
    }
  }

  @override
  bool shouldRepaint(PlanPainter old) => true;
}
