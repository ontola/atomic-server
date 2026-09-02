import 'dart:math';
import 'package:flutter/material.dart';

const _widthOptions = [1.0, 2.0, 5.0, 10.0, 18.0, 30.0, 46.0];
List<double> get widthOptions => _widthOptions;

Color getFanColor(int hueIndex, int numHues, int distIndex) {
  if (hueIndex == numHues - 1) {
    const values = [0.9, 0.6, 0.3, 0.0];
    final v = values[distIndex];
    return HSVColor.fromAHSV(1.0, 0, 0, v).toColor();
  }
  final hue = (hueIndex / (numHues - 2)) * 300.0;
  const satVal = [
    [0.4, 1.0], // pastel
    [0.8, 0.9], // normal
    [0.9, 0.6], // dark
    [1.0, 0.3], // very dark
  ];
  final sv = satVal[distIndex];
  return HSVColor.fromAHSV(1.0, hue, sv[0], sv[1]).toColor();
}

/// Returns the color closest to [dragOffset] (relative to button center),
/// or null if too close to center.
Color? calculateHoveredColor(Offset dragOffset, {double scale = 1.0}) {
  if (dragOffset.distance < 40.0 * scale) return null;
  const numHues = 8;
  const numDists = 4;
  final baseRadius = 80.0 * scale;
  final distStep = 50.0 * scale;

  double closest = double.infinity;
  Color? best;

  for (int d = 0; d < numDists; d++) {
    final r = baseRadius + d * distStep;
    for (int h = 0; h < numHues; h++) {
      final angle = (-180.0 + h * (180.0 / (numHues - 1))) * pi / 180.0;
      final cx = r * cos(angle);
      final cy = r * sin(angle);
      final dist = (Offset(cx, cy) - dragOffset).distance;
      if (dist < closest) {
        closest = dist;
        best = getFanColor(h, numHues, d);
      }
    }
  }
  return best;
}

/// Returns the width closest to [dragOffset], or null if too close to center.
double? calculateHoveredWidth(Offset dragOffset, {double scale = 1.0}) {
  if (dragOffset.distance < 40.0 * scale) return null;
  const numWidths = 7;
  final radius = 100.0 * scale;

  double closest = double.infinity;
  double? best;

  for (int i = 0; i < numWidths; i++) {
    final angle = (-180.0 + i * (180.0 / (numWidths - 1))) * pi / 180.0;
    final cx = radius * cos(angle);
    final cy = radius * sin(angle);
    final dist = (Offset(cx, cy) - dragOffset).distance;
    if (dist < closest) {
      closest = dist;
      best = _widthOptions[i];
    }
  }
  return best;
}
