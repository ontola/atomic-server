import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:atomiccanvas_flutter/canvas/canvas_pop_scope.dart';
import 'package:atomiccanvas_flutter/canvas/rotation_pop_guard.dart';

void main() {
  testWidgets('back while drawing returns to the gallery', (tester) async {
    var closed = 0;
    await tester.pumpWidget(MaterialApp(
      home: CanvasPopScope(
        onClose: () => closed++,
        child: const Scaffold(body: Text('canvas')),
      ),
    ));

    await tester.binding.handlePopRoute();
    await tester.pump();

    expect(find.text('canvas'), findsOneWidget);
    expect(closed, 1);
  });

  testWidgets(
      'a spurious back fired by rotation does not return to the gallery',
      (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    var closed = 0;
    var now = DateTime(2026, 1, 1, 12);
    final guard = RotationPopGuard(now: () => now);

    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1.0;

    await tester.pumpWidget(MaterialApp(
      home: CanvasPopScope(
        guard: guard,
        onClose: () => closed++,
        child: const Scaffold(body: Text('canvas')),
      ),
    ));

    tester.view.physicalSize = const Size(800, 400);
    await tester.pump();

    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(closed, 0, reason: 'rotation must not close the canvas');
    expect(find.text('canvas'), findsOneWidget);

    now = now.add(const Duration(seconds: 1));
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(closed, 1, reason: 'a later back press is still the gallery');
  });
}
