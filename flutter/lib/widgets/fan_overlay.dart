import 'dart:math';
import 'package:flutter/material.dart';
import '../canvas/fan_helpers.dart';
import '../theme.dart';

enum FanType { color, width }

class FanOverlay extends StatelessWidget {
  final Offset buttonCenter;
  final Offset dragOffset;
  final FanType type;
  final Color? hoveredColor;
  final double? hoveredWidth;
  final double canvasScale;
  final bool isDarkMode;

  const FanOverlay({
    super.key,
    required this.buttonCenter,
    required this.dragOffset,
    required this.type,
    this.hoveredColor,
    this.hoveredWidth,
    required this.canvasScale,
    required this.isDarkMode,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    final screenWidth = MediaQuery.of(context).size.width;
    final fanScale = screenWidth < 500 ? 0.65 : 1.0;
    return IgnorePointer(
      child: CustomPaint(
        painter: _FanPainter(
          buttonCenter: buttonCenter,
          dragOffset: dragOffset,
          type: type,
          hoveredColor: hoveredColor,
          hoveredWidth: hoveredWidth,
          canvasScale: canvasScale,
          colors: c,
          isDarkMode: isDarkMode,
          scale: fanScale,
        ),
        child: const SizedBox.expand(),
      ),
    );
  }
}

class _FanPainter extends CustomPainter {
  final Offset buttonCenter;
  final Offset dragOffset;
  final FanType type;
  final Color? hoveredColor;
  final double? hoveredWidth;
  final double canvasScale;
  final AppColors colors;
  final bool isDarkMode;
  final double scale;

  const _FanPainter({
    required this.buttonCenter,
    required this.dragOffset,
    required this.type,
    this.hoveredColor,
    this.hoveredWidth,
    required this.canvasScale,
    required this.colors,
    required this.isDarkMode,
    this.scale = 1.0,
  });

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(
      Rect.fromLTWH(0, 0, size.width, size.height),
      Paint()..color = colors.overlayDim,
    );

    if (type == FanType.color) {
      _paintColorFan(canvas);
    } else {
      _paintWidthFan(canvas);
    }

    final linePaint = Paint()
      ..color = Colors.white.withOpacity(0.6)
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(buttonCenter, buttonCenter + dragOffset, linePaint);
  }

  void _paintColorFan(Canvas canvas) {
    const numHues = 8;
    const numDists = 4;
    final baseRadius = 80.0 * scale;
    final distStep = 50.0 * scale;
    final circleR = 24.0 * scale;

    for (int d = 0; d < numDists; d++) {
      final r = baseRadius + d * distStep;
      for (int h = 0; h < numHues; h++) {
        final angle = (-180.0 + h * (180.0 / (numHues - 1))) * pi / 180.0;
        final cx = buttonCenter.dx + r * cos(angle);
        final cy = buttonCenter.dy + r * sin(angle);
        final color =
            adjustColorForDarkMode(getFanColor(h, numHues, d), isDarkMode);
        final isHovered = hoveredColor != null &&
            adjustColorForDarkMode(hoveredColor!, isDarkMode).value ==
                color.value;
        final radius = isHovered ? circleR * 1.5 : circleR;

        if (isHovered) {
          canvas.drawCircle(
            Offset(cx, cy),
            radius + 5,
            Paint()..color = colors.hoverShadow,
          );
        }
        canvas.drawCircle(Offset(cx, cy), radius, Paint()..color = color);
        if (!isHovered) {
          canvas.drawCircle(
            Offset(cx, cy),
            radius,
            Paint()
              ..color = colors.border
              ..style = PaintingStyle.stroke
              ..strokeWidth = 1,
          );
        }
      }
    }
  }

  void _paintWidthFan(Canvas canvas) {
    final options = widthOptions;
    const numWidths = 7;
    final radius = 100.0 * scale;
    final minDisplay = 3.0 * scale;
    final maxDisplay = 36.0 * scale;

    for (int i = 0; i < numWidths; i++) {
      final angle = (-180.0 + i * (180.0 / (numWidths - 1))) * pi / 180.0;
      final cx = buttonCenter.dx + radius * cos(angle);
      final cy = buttonCenter.dy + radius * sin(angle);
      final w = options[i];
      final isHovered = w == hoveredWidth;
      final displayR =
          ((w * canvasScale / 2).clamp(minDisplay, maxDisplay)).toDouble();

      if (isHovered) {
        canvas.drawCircle(
          Offset(cx, cy),
          displayR + 7,
          Paint()..color = colors.hoverShadow,
        );
      }
      canvas.drawCircle(
        Offset(cx, cy),
        displayR,
        Paint()..color = isHovered ? const Color(0xFFAAAAAA) : colors.dot,
      );
    }

    final previewW = hoveredWidth ?? options[3];
    final previewR =
        (previewW * canvasScale / 2).clamp(minDisplay, maxDisplay).toDouble();
    final tipDist = dragOffset.distance;
    if (tipDist > 0) {
      final dir = dragOffset / tipDist;
      final previewCenter = buttonCenter + dragOffset + dir * (previewR + 16);
      canvas.drawCircle(
        previewCenter,
        previewR,
        Paint()
          ..color = colors.widthPreviewStroke
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5,
      );
    }
  }

  @override
  bool shouldRepaint(_FanPainter old) =>
      buttonCenter != old.buttonCenter ||
      dragOffset != old.dragOffset ||
      hoveredColor != old.hoveredColor ||
      hoveredWidth != old.hoveredWidth ||
      canvasScale != old.canvasScale ||
      isDarkMode != old.isDarkMode ||
      scale != old.scale;
}
