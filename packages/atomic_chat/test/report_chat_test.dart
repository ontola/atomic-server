import 'package:atomic_chat/atomic_chat.dart';
import 'package:atomic_chat/src/report_chat_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

final _chat = [
  ChatEntry(
      id: 'a', role: 'user', createdAt: 1, parts: [TextPart('Hello there')]),
  ChatEntry(id: 'b', role: 'assistant', createdAt: 2, parts: [
    TextPart('Hi!'),
    FilePart(url: 'data:x', mediaType: 'image/png', filename: 'a.png'),
    ToolPart(
        toolCallId: '1',
        toolName: 'search',
        state: ToolState.outputError,
        errorText: 'boom'),
  ]),
];

Future<void> _open(WidgetTester tester, _Api api,
    {List<ChatEntry>? messages}) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => TextButton(
        onPressed: () => showReportChatDialog(context,
            api: api, title: 'My chat', messages: messages ?? _chat),
        child: const Text('open'),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

String _transcript(WidgetTester tester) => tester
    .widget<TextField>(find.byKey(const Key('report-transcript')))
    .controller!
    .text;

void main() {
  test('the transcript lists messages, files and errors, not payloads', () {
    final r = formatAiChatReport('My chat', _chat);
    expect(r.omitted, 0);
    expect(
        r.text,
        'AI chat: My chat\nMessages: 2\n\n'
        '1. user\nHello there\n\n'
        '2. assistant\nHi!\n[Attachment: a.png]\n[tool-search]\nError: boom');
  });

  test('a long chat keeps the newest messages and says so', () {
    final long = [
      for (var i = 0; i < 10; i++)
        ChatEntry(
            id: '$i',
            role: 'user',
            createdAt: i,
            parts: [TextPart('m$i ${'x' * 9000}')]),
    ];
    final r = formatAiChatReport('', long);
    expect(r.text.length, lessThanOrEqualTo(maxAiChatReportLength));
    expect(r.omitted, greaterThan(0));
    expect(r.text, contains('AI chat: Untitled Chat'));
    expect(r.text, contains('earlier messages omitted'));
    expect(r.text, contains('m9 '));
  });

  testWidgets('prefilled transcript; Send passes details, transcript, email',
      (tester) async {
    final api = _Api();
    await _open(tester, api);
    expect(_transcript(tester), contains('1. user\nHello there'));
    expect(find.byKey(const Key('report-unavailable')), findsNothing);
    await tester.enterText(find.byKey(const Key('report-details')), 'Wrong');
    await tester.enterText(
        find.byKey(const Key('report-email')), 'me@example.com');
    await tester.tap(find.byKey(const Key('report-send')));
    await tester.pumpAndSettle();
    expect(api.sent, hasLength(1));
    expect(api.sent.single.message,
        startsWith('What went wrong:\nWrong\n\nAI chat: My chat'));
    expect(api.sent.single.message, contains('Hello there'));
    expect(api.sent.single.email, 'me@example.com');
    expect(find.byKey(const Key('report-sent')), findsOneWidget);
  });

  testWidgets('an edited transcript is what is sent; a bad email is refused',
      (tester) async {
    final api = _Api();
    await _open(tester, api);
    await tester.enterText(
        find.byKey(const Key('report-transcript')), 'redacted');
    await tester.enterText(find.byKey(const Key('report-email')), 'nope');
    await tester.tap(find.byKey(const Key('report-send')));
    await tester.pumpAndSettle();
    expect(api.sent, isEmpty);
    await tester.enterText(find.byKey(const Key('report-email')), '');
    await tester.tap(find.byKey(const Key('report-send')));
    await tester.pumpAndSettle();
    expect(api.sent.single.message,
        'What went wrong:\n(No description)\n\nredacted');
    expect(api.sent.single.email, isNull);
  });

  testWidgets('Copy puts the report on the clipboard, sending nothing',
      (tester) async {
    final api = _Api();
    String? copied;
    tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied = (call.arguments as Map)['text'] as String;
      }
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));
    await _open(tester, api);
    await tester.enterText(find.byKey(const Key('report-details')), 'Wrong');
    await tester.tap(find.byKey(const Key('report-copy')));
    await tester.pumpAndSettle();
    expect(copied, startsWith('What went wrong:\nWrong\n\nAI chat: My chat'));
    expect(find.byKey(const Key('report-copied')), findsOneWidget);
    expect(api.sent, isEmpty);
  });

  testWidgets('without sending the dialog says so and only offers Copy',
      (tester) async {
    await _open(tester, _Api(can: false));
    expect(find.byKey(const Key('report-unavailable')), findsOneWidget);
    expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('report-send')))
            .onPressed,
        isNull);
    expect(
        tester
            .widget<TextButton>(find.byKey(const Key('report-copy')))
            .onPressed,
        isNotNull);
  });

  testWidgets('a failed send keeps the text and shows it', (tester) async {
    await _open(tester, _Api(fail: true));
    await tester.tap(find.byKey(const Key('report-send')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('report-failed')), findsOneWidget);
    expect(find.byKey(const Key('report-sent')), findsNothing);
    expect(_transcript(tester), contains('Hello there'));
  });
}
