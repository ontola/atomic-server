import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import '../models/stroke_data.dart';
import '../theme.dart';

class CanvasPainter extends CustomPainter {
  final List<StrokeData> strokes;
  final StrokeData? currentStroke;
  final double scale;
  final Offset offset;
  final bool isDarkMode;
  final ui.Image? backgroundImage;

  const CanvasPainter({
    required this.strokes,
    this.currentStroke,
    required this.scale,
    required this.offset,
    required this.isDarkMode,
    this.backgroundImage,
  });

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.translate(offset.dx, offset.dy);
    canvas.scale(scale);

    if (backgroundImage != null) {
      final img = backgroundImage!;
      final dst = Rect.fromCenter(
        center: Offset.zero,
        width: img.width.toDouble(),
        height: img.height.toDouble(),
      );
      canvas.drawImageRect(
          img,
          Rect.fromLTWH(0, 0, img.width.toDouble(), img.height.toDouble()),
          dst,
          Paint());
    }

    for (final stroke in strokes) {
      _drawStroke(canvas, stroke);
    }
    if (currentStroke != null) {
      _drawStroke(canvas, currentStroke!);
    }

    canvas.restore();
  }

  void _drawStroke(Canvas canvas, StrokeData stroke) {
    if (stroke.points.isEmpty) return;

    final paint = Paint()
      ..color = adjustColorForDarkMode(stroke.color, isDarkMode)
      ..strokeWidth = stroke.strokeWidth
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;

    if (stroke.points.length == 1) {
      canvas.drawCircle(stroke.points.first, stroke.strokeWidth / 2,
          paint..style = PaintingStyle.fill);
      return;
    }

    final path = Path();
    path.moveTo(stroke.points.first.dx, stroke.points.first.dy);

    for (int i = 1; i < stroke.points.length; i++) {
      final prev = stroke.points[i - 1];
      final curr = stroke.points[i];
      path.quadraticBezierTo(
        prev.dx,
        prev.dy,
        (prev.dx + curr.dx) / 2,
        (prev.dy + curr.dy) / 2,
      );
    }

    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(CanvasPainter oldDelegate) =>
      strokes != oldDelegate.strokes ||
      currentStroke != oldDelegate.currentStroke ||
      scale != oldDelegate.scale ||
      offset != oldDelegate.offset ||
      isDarkMode != oldDelegate.isDarkMode;
}
