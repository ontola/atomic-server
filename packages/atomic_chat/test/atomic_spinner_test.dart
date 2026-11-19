import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'assistant_screens_test.dart' show app;

void main() {
  testWidgets('the spinner is the mark at its size, or its slot\'s',
      (tester) async {
    await tester.pumpWidget(app(const Scaffold(
      body: Column(children: [
        AtomicSpinner(key: Key('page')),
        SizedBox.square(dimension: 20, child: AtomicSpinner(key: Key('row'))),
      ]),
    )));
    await tester.pump(const Duration(milliseconds: 600));
    expect(tester.getSize(find.byKey(const Key('page'))),
        const Size.square(AtomicSpinner.pageSize));
    expect(tester.getSize(find.byKey(const Key('row'))), const Size.square(20));
    expect(find.bySemanticsLabel('Loading'), findsNWidgets(2));
  });
}
