import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'unimplemented_api.dart';

class _Api extends UnimplementedApi {
  _Api({this.can = true, this.fail = false});
  final bool can;
  final bool fail;
  final sent = <({String message, String? email, String source})>[];

  @override
  bool get canSendFeedback => can;
  @override
  Future<void> sendFeedback(
      {required String message, String? email, String source = 'app'}) async {
    if (fail) throw StateError('no');
    sent.add((message: message, email: email, source: source));
  }
}

Future<void> _open(WidgetTester tester, _Api api) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => TextButton(
        onPressed: () =>
            showFeedbackDialog(context, api: api, source: 'user-page'),
        child: const Text('open'),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

FilledButton _send(WidgetTester tester) =>
    tester.widget<FilledButton>(find.byKey(const Key('feedback-send')));

void main() {
  testWidgets('sends the message and email, then thanks', (tester) async {
    final api = _Api();
    await _open(tester, api);
    expect(_send(tester).onPressed, isNull, reason: 'nothing written yet');

    await tester.enterText(
        find.byKey(const Key('feedback-message')), '  The + button  ');
    await tester.enterText(
        find.byKey(const Key('feedback-email')), 'joep@example.com');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-send')));
    await tester.pumpAndSettle();

    expect(api.sent.single.message, 'The + button');
    expect(api.sent.single.email, 'joep@example.com');
    expect(api.sent.single.source, 'user-page');
    expect(find.byKey(const Key('feedback-sent')), findsOneWidget);
  });

  testWidgets('a bad email is refused', (tester) async {
    final api = _Api();
    await _open(tester, api);
    await tester.enterText(find.byKey(const Key('feedback-message')), 'Hi');
    await tester.enterText(find.byKey(const Key('feedback-email')), 'nope');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-send')));
    await tester.pumpAndSettle();

    expect(api.sent, isEmpty);
    expect(find.text('Enter a valid email address'), findsOneWidget);
  });

  testWidgets('without Sentry it says so and cannot send', (tester) async {
    await _open(tester, _Api(can: false));
    await tester.enterText(find.byKey(const Key('feedback-message')), 'Hi');
    await tester.pump();

    expect(find.byKey(const Key('feedback-unavailable')), findsOneWidget);
    expect(_send(tester).onPressed, isNull);
  });

  testWidgets('a failed send keeps the text', (tester) async {
    await _open(tester, _Api(fail: true));
    await tester.enterText(find.byKey(const Key('feedback-message')), 'Hi');
    await tester.pump();
    await tester.tap(find.byKey(const Key('feedback-send')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('feedback-failed')), findsOneWidget);
    expect(find.text('Hi'), findsOneWidget);
  });
}
