import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:calorie_tracker/main.dart';

void main() {
  testWidgets('the home screen renders before the store is open', (
    tester,
  ) async {
    // No native library and no platform channels in the test VM, so opening the
    // store fails here. That is the point: the screen has to be up and readable
    // regardless — Phase 3 puts a camera preview in this slot and it must not
    // wait on the database either.
    await tester.pumpWidget(const CalorieTrackerApp());
    await tester.pump();

    expect(find.text('Calorie Tracker'), findsOneWidget);

    final button = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(
      button.onPressed,
      isNull,
      reason: 'setup() must be unreachable until the store is actually open',
    );
  });
}
