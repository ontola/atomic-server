import 'dart:ui' as ui;

class StrokeData {
  final List<ui.Offset> points;
  final ui.Color color;
  final double strokeWidth;

  const StrokeData({
    required this.points,
    required this.color,
    required this.strokeWidth,
  });

  StrokeData copyWith(
      {List<ui.Offset>? points, ui.Color? color, double? strokeWidth}) {
    return StrokeData(
      points: points ?? this.points,
      color: color ?? this.color,
      strokeWidth: strokeWidth ?? this.strokeWidth,
    );
  }

  Map<String, dynamic> toJson() => {
        'color': color.value,
        'width': strokeWidth,
        'path': points.map((p) => [p.dx, p.dy]).toList(),
      };

  factory StrokeData.fromJson(Map<String, dynamic> json) {
    final path = json['path'] as List;
    return StrokeData(
      color: ui.Color(json['color'] as int),
      strokeWidth: (json['width'] as num).toDouble(),
      points: path.map((p) {
        final coords = p as List;
        return ui.Offset(
            (coords[0] as num).toDouble(), (coords[1] as num).toDouble());
      }).toList(),
    );
  }
}

class DiscardedBranch {
  final int id; // milliseconds timestamp, used as unique key
  final int fromIndex;
  final List<StrokeData> strokes;
  ui.Image? thumbnail;

  DiscardedBranch({
    required this.id,
    required this.fromIndex,
    required this.strokes,
  });
}

sealed class HistoryAction {}

class StrokeAdded extends HistoryAction {
  final StrokeData stroke;
  StrokeAdded(this.stroke);
}

class StrokesDeleted extends HistoryAction {
  final List<int> sortedIndices;
  final List<StrokeData> deletedStrokes;
  StrokesDeleted(this.sortedIndices, this.deletedStrokes);
}

class StrokesReplaced extends HistoryAction {
  final List<int> indices;
  final List<StrokeData> before;
  final List<StrokeData> after;
  StrokesReplaced(this.indices, this.before, this.after);
}
