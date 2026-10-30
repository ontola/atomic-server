import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// An app that goes full screen gets a black route over the whole app, and
/// back hands control to the page.

Future<void> _pump(
  WidgetTester tester,
  ValueNotifier<Widget?> fullscreen,
  VoidCallback onExit,
) =>
    tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: FullscreenHost(
          fullscreen: fullscreen,
          onExit: onExit,
          child: const Text('page'),
        ),
      ),
    ));

void main() {
  testWidgets('shows the fullscreen view and back calls onExit',
      (tester) async {
    final fullscreen = ValueNotifier<Widget?>(null);
    var exits = 0;
    await _pump(tester, fullscreen, () => exits++);
    expect(find.text('video'), findsNothing);

    fullscreen.value = const Text('video');
    await tester.pumpAndSettle();
    expect(find.text('video'), findsOneWidget);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('video'), findsNothing);
    expect(exits, 1);
  });

  testWidgets('the page leaving fullscreen closes it without onExit',
      (tester) async {
    final fullscreen = ValueNotifier<Widget?>(null);
    var exits = 0;
    await _pump(tester, fullscreen, () => exits++);

    fullscreen.value = const Text('video');
    await tester.pumpAndSettle();
    fullscreen.value = null;
    await tester.pumpAndSettle();

    expect(find.text('video'), findsNothing);
    expect(find.text('page'), findsOneWidget);
    expect(exits, 0);
  });
}
