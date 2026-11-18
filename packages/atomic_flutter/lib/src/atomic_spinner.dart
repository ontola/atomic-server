import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'theme.dart';

/// The app's loader: the atomic.place mark, its fading trail circling the
/// orb, as the web app's `Spinner` (`browser/data-browser/src/components/
/// Spinner.tsx`, geometry from `helpers/orbitTrail.ts`). One turn takes
/// 2.4 s, 8 s with reduced motion. It fills a tight box (a 20 dp slot in a
/// row); in a loose one it is [size] square.
class AtomicSpinner extends StatefulWidget {
  /// The size of a page's loader.
  static const pageSize = 48.0;

  final double size;

  /// The trail's colour; the theme's text colour when null.
  final Color? color;

  final String semanticsLabel;

  const AtomicSpinner({
    super.key,
    this.size = pageSize,
    this.color,
    this.semanticsLabel = 'Loading',
  });

  @override
  State<AtomicSpinner> createState() => _AtomicSpinnerState();
}

class _AtomicSpinnerState extends State<AtomicSpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _turn = AnimationController(vsync: this);
  bool? _reduced;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduced = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduced != _reduced) {
      _reduced = reduced;
      _turn
        ..duration = Duration(milliseconds: reduced ? 8000 : 2400)
        ..repeat();
    }
  }

  @override
  void dispose() {
    _turn.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ??
        Theme.of(context).extension<AppColors>()?.textPrimary ??
        Theme.of(context).colorScheme.onSurface;
    return Semantics(
      label: widget.semanticsLabel,
      child: SizedBox.square(
        dimension: widget.size,
        child: RepaintBoundary(
          child: CustomPaint(
              painter: _MarkPainter(_turn, color), willChange: true),
        ),
      ),
    );
  }
}

/// The mark on a 100 × 100 grid: a 270° arc of radius 24 and width 14 from
/// 3 o'clock round to the top, its opacity rising from nothing to solid,
/// headed by a dot of radius 7; the orb (24 wide) in the middle.
class _MarkPainter extends CustomPainter {
  final Animation<double> turn;
  final Color color;

  _MarkPainter(this.turn, this.color) : super(repaint: turn);

  /// Opacity along the trail (degrees from its start), as `orbitTrail.ts`.
  static const _ramp = [(0.0, 0.0), (75.6, 0.34), (176.4, 0.78), (248.4, 1.0)];

  @override
  void paint(Canvas canvas, Size size) {
    final k = math.min(size.width, size.height) / 100;
    final center = size.center(Offset.zero);
    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.rotate(turn.value * 2 * math.pi);
    final rect = Rect.fromCircle(center: Offset.zero, radius: 24 * k);
    const sweep = 1.5 * math.pi;
    canvas.drawArc(
      rect,
      0,
      sweep,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 14 * k
        ..shader = SweepGradient(
          endAngle: 2 * math.pi,
          colors: [
            for (final (_, o) in _ramp) color.withValues(alpha: color.a * o),
            color,
          ],
          stops: [for (final (a, _) in _ramp) a / 360, 0.75],
        ).createShader(rect),
    );
    canvas.drawCircle(Offset(0, -24 * k), 7 * k, Paint()..color = color);
    canvas.restore();
    final orb = Rect.fromCircle(center: center, radius: 12 * k);
    canvas.drawCircle(
      center,
      12 * k,
      Paint()
        ..color = const Color(0x7300C2FF)
        ..maskFilter = MaskFilter.blur(BlurStyle.normal, 4 * k),
    );
    canvas.drawCircle(
      center,
      12 * k,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.centerRight,
          end: Alignment.centerLeft,
          colors: [Color(0xFF01ECFF), Color(0xFF2210FF)],
        ).createShader(orb),
    );
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.color != color;
}
