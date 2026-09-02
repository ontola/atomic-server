import 'package:flutter_test/flutter_test.dart';
import 'package:atomiccanvas_flutter/canvas/infinite_canvas.dart';

void main() {
  final t0 = DateTime(2026, 1, 1, 12);

  test('a back press is not ignored', () {
    expect(ignorePopFromRotation(null, t0), isFalse);
  });

  test('a back press right after rotation is ignored', () {
    expect(
      ignorePopFromRotation(t0, t0.add(const Duration(milliseconds: 100))),
      isTrue,
    );
  });

  test('a later back press still returns to the gallery', () {
    expect(
      ignorePopFromRotation(t0, t0.add(const Duration(seconds: 1))),
      isFalse,
    );
  });
}
