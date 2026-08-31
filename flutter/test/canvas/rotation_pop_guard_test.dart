import 'package:flutter_test/flutter_test.dart';
import 'package:atomiccanvas_flutter/canvas/rotation_pop_guard.dart';

void main() {
  test('a back press with no metrics change is not ignored', () {
    final guard = RotationPopGuard();
    expect(guard.shouldIgnorePop, isFalse);
  });

  test('a back press shortly after rotation is ignored', () {
    var now = DateTime(2026, 1, 1, 12);
    final guard = RotationPopGuard(now: () => now);

    guard.onMetricsChanged();
    now = now.add(const Duration(milliseconds: 100));
    expect(guard.shouldIgnorePop, isTrue);
  });

  test('a back press after the rotation window is a real back', () {
    var now = DateTime(2026, 1, 1, 12);
    final guard = RotationPopGuard(
      now: () => now,
      window: const Duration(milliseconds: 600),
    );

    guard.onMetricsChanged();
    now = now.add(const Duration(milliseconds: 600));
    expect(guard.shouldIgnorePop, isFalse);
  });
}
