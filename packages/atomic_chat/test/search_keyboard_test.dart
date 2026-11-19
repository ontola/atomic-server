import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'assistant_screens_test.dart' show FakeApi, app;

/// The phone's search lays out above the keyboard from its first frame (the
/// height it had last time) instead of riding up with it.

const _size = Size(393, 851);

Future<void> _pump(WidgetTester tester, double keyboard) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = _size;
  tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MediaQuery(
    data: MediaQueryData(
        size: _size, viewInsets: EdgeInsets.only(bottom: keyboard)),
    child: app(SearchScreen(drive: 'did:ad:drive', api: FakeApi())),
  ));
}

double _fieldBottom(WidgetTester tester) =>
    tester.getBottomLeft(find.byType(TextField)).dy;

void main() {
  testWidgets('starts above the keyboard it saw last time', (tester) async {
    SearchScreen.keyboardHeight = 300;
    await _pump(tester, 0);
    await tester.pump();
    expect(_fieldBottom(tester), lessThanOrEqualTo(_size.height - 300));

    // The keyboard comes up under it: nothing moves.
    final ahead = _fieldBottom(tester);
    await _pump(tester, 120);
    expect(_fieldBottom(tester), ahead);
    await _pump(tester, 300);
    expect(_fieldBottom(tester), ahead);

    // Put away: the field follows it down.
    await _pump(tester, 0);
    expect(_fieldBottom(tester), greaterThan(ahead + 200));
    await tester.pumpAndSettle();
  });

  testWidgets('no keyboard comes (a hardware one): the field drops back',
      (tester) async {
    SearchScreen.keyboardHeight = 300;
    await _pump(tester, 0);
    await tester.pump();
    final ahead = _fieldBottom(tester);
    await tester.pump(const Duration(milliseconds: 800));
    expect(_fieldBottom(tester), greaterThan(ahead + 200));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    expect(SearchScreen.keyboardHeight, 0);
  });

  testWidgets('remembers how high the keyboard came', (tester) async {
    await _pump(tester, 0);
    await _pump(tester, 280);
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    expect(SearchScreen.keyboardHeight, 280);
  });
}
