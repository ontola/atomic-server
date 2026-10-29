import 'dart:math' as math;

/// A geometry JSON is malformed. [message] says which field.
class GeometryException implements Exception {
  const GeometryException(this.message);
  final String message;
  @override
  String toString() => 'GeometryException: $message';
}

/// A point in metres, local to its storey (X right, Y up, Z up for height).
class Pt {
  const Pt(this.x, this.y);
  final double x, y;

  factory Pt.fromJson(Object? json, String field) {
    if (json is List && json.length == 2 && json.every((n) => n is num)) {
      return Pt((json[0] as num).toDouble(), (json[1] as num).toDouble());
    }
    throw GeometryException('$field must be [x, y]');
  }

  List<double> toJson() => [x, y];

  double distanceTo(Pt o) =>
      math.sqrt(math.pow(x - o.x, 2) + math.pow(y - o.y, 2));

  @override
  bool operator ==(Object other) => other is Pt && other.x == x && other.y == y;
  @override
  int get hashCode => Object.hash(x, y);
}

/// A polygon outline as stored in `bldg-boundary` (not self-closing).
List<Pt> polygonFromJson(Object? json, String field) {
  if (json is! List || json.length < 3) {
    throw GeometryException('$field needs at least 3 points');
  }
  return [for (final p in json) Pt.fromJson(p, '$field point')];
}

List<List<double>> polygonToJson(List<Pt> polygon) =>
    [for (final p in polygon) p.toJson()];

double _num(Map json, String key, {bool positive = false, double? orElse}) {
  final v = json[key];
  if (v == null && orElse != null) return orElse;
  if (v is! num) throw GeometryException('$key must be a number');
  if (positive ? v <= 0 : v < 0) {
    throw GeometryException(
        '$key must be ${positive ? 'positive' : 'not negative'}');
  }
  return v.toDouble();
}

/// The shape of an Element: the `bldg-geometry` JSON for one geometry kind.
sealed class Geometry {
  const Geometry();

  static const kinds = ['wallAxis', 'extrusion', 'opening', 'mesh'];

  /// Parses [json] as [kind] (the `bldg-geometry-kind` value). Throws
  /// [GeometryException] for an unknown kind or a bad field.
  factory Geometry.fromJson(String kind, Object? json) {
    if (json is! Map) {
      throw const GeometryException('geometry must be an object');
    }
    return switch (kind) {
      'wallAxis' => WallAxis.fromJson(json),
      'extrusion' => Extrusion.fromJson(json),
      'opening' => Opening.fromJson(json),
      'mesh' => Mesh.fromJson(json),
      _ => throw GeometryException('unknown geometry kind "$kind"'),
    };
  }

  String get kind;
  Map<String, Object?> toJson();
}

/// A wall as a line with a thickness and height.
class WallAxis extends Geometry {
  const WallAxis({
    required this.start,
    required this.end,
    required this.height,
    required this.thickness,
  });

  factory WallAxis.fromJson(Map json) {
    final start = Pt.fromJson(json['start'], 'start');
    final end = Pt.fromJson(json['end'], 'end');
    if (start == end) throw const GeometryException('wall start equals end');
    return WallAxis(
      start: start,
      end: end,
      height: _num(json, 'height', positive: true),
      thickness: _num(json, 'thickness', positive: true),
    );
  }

  final Pt start, end;
  final double height, thickness;

  double get length => start.distanceTo(end);

  @override
  String get kind => 'wallAxis';
  @override
  Map<String, Object?> toJson() => {
        'start': start.toJson(),
        'end': end.toJson(),
        'height': height,
        'thickness': thickness,
      };
}

/// A polygon pushed up by [depth]: slabs, roofs, columns.
class Extrusion extends Geometry {
  const Extrusion({required this.polygon, required this.depth});

  factory Extrusion.fromJson(Map json) => Extrusion(
        polygon: polygonFromJson(json['polygon'], 'polygon'),
        depth: _num(json, 'depth', positive: true),
      );

  final List<Pt> polygon;
  final double depth;

  @override
  String get kind => 'extrusion';
  @override
  Map<String, Object?> toJson() =>
      {'polygon': polygonToJson(polygon), 'depth': depth};
}

/// A door or window: a gap in its host wall, [offset] metres from the wall's
/// start, [width] wide, [height] high, with its lower edge [sill] above the floor.
class Opening extends Geometry {
  const Opening({
    required this.offset,
    required this.width,
    required this.height,
    this.sill = 0,
  });

  factory Opening.fromJson(Map json) => Opening(
        offset: _num(json, 'offset'),
        width: _num(json, 'width', positive: true),
        height: _num(json, 'height', positive: true),
        sill: _num(json, 'sill', orElse: 0),
      );

  final double offset, width, height, sill;

  @override
  String get kind => 'opening';
  @override
  Map<String, Object?> toJson() =>
      {'offset': offset, 'width': width, 'height': height, 'sill': sill};
}

/// Freeform geometry: a link to a glTF/GLB File resource.
class Mesh extends Geometry {
  const Mesh({required this.file});

  factory Mesh.fromJson(Map json) {
    final file = json['file'];
    if (file is! String || file.isEmpty) {
      throw const GeometryException('file must be a subject');
    }
    return Mesh(file: file);
  }

  final String file;

  @override
  String get kind => 'mesh';
  @override
  Map<String, Object?> toJson() => {'file': file};
}
