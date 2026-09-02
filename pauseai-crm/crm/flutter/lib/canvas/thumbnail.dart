import 'dart:ui' as ui;
import 'package:flutter/material.dart' show Colors;
import '../models/stroke_data.dart';
import '../theme.dart';

Future<ui.Image> renderThumbnail(List<StrokeData> strokes,
    {int size = 128, bool isDarkMode = false}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(
      recorder, ui.Rect.fromLTWH(0, 0, size.toDouble(), size.toDouble()));

  // Background
  canvas.drawRect(
    ui.Rect.fromLTWH(0, 0, size.toDouble(), size.toDouble()),
    ui.Paint()..color = isDarkMode ? Colors.black : const ui.Color(0xFFF5F5F5),
  );

  if (strokes.isEmpty) {
    final picture = recorder.endRecording();
    return picture.toImage(size, size);
  }

  // Compute bounding box
  double minX = double.infinity, minY = double.infinity;
  double maxX = double.negativeInfinity, maxY = double.negativeInfinity;
  for (final stroke in strokes) {
    for (final p in stroke.points) {
      if (p.dx < minX) minX = p.dx;
      if (p.dy < minY) minY = p.dy;
      if (p.dx > maxX) maxX = p.dx;
      if (p.dy > maxY) maxY = p.dy;
    }
  }

  const padding = 8.0;
  final contentW = (maxX - minX) + padding * 2;
  final contentH = (maxY - minY) + padding * 2;
  final previewScale =
      (size / contentW).clamp(0.0, size / contentH.clamp(1.0, double.infinity));
  final tx =
      (size - contentW * previewScale) / 2 - (minX - padding) * previewScale;
  final ty =
      (size - contentH * previewScale) / 2 - (minY - padding) * previewScale;

  canvas.save();
  canvas.translate(tx, ty);
  canvas.scale(previewScale);

  for (final stroke in strokes) {
    if (stroke.points.isEmpty) continue;
    final paint = ui.Paint()
      ..color = adjustColorForDarkMode(stroke.color, isDarkMode)
      ..strokeWidth = stroke.strokeWidth
      ..strokeCap = ui.StrokeCap.round
      ..strokeJoin = ui.StrokeJoin.round
      ..style = ui.PaintingStyle.stroke;

    if (stroke.points.length == 1) {
      canvas.drawCircle(stroke.points.first, stroke.strokeWidth / 2,
          paint..style = ui.PaintingStyle.fill);
      continue;
    }

    final path = ui.Path();
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

  canvas.restore();
  final picture = recorder.endRecording();
  return picture.toImage(size, size);
}
