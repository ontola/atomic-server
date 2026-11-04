import 'dart:convert';

import 'package:atomic_embed/atomic_embed.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakePage implements EmbedPage, ReleasablePage {
  final scripts = <String>[];
  bool released = false;
  @override
  Future<void> runJavaScript(String script) async => scripts.add(script);
  @override
  Future<Object> runJavaScriptReturningResult(String script) async => '';
  @override
  Widget build() => const SizedBox(key: Key('page'));
  @override
  void release() => released = true;
}

void main() {
  testWidgets('store calls go to the store and are answered in the page',
      (tester) async {
    final page = _FakePage();
    late void Function(String) send;
    Uri? opened;
    final calls = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: AtomicDocumentView(
        subject: 'did:ad:doc',
        call: (method, args) async {
          calls.add('$method $args');
          return '{"ok":1}';
        },
        pageFactory: (url, onMessage) async {
          opened = url;
          send = onMessage;
          return page;
        },
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('page')), findsOneWidget);
    expect(opened!.queryParameters['subject'], 'did:ad:doc');
    // The page stays on the document: no breadcrumbs to walk away with.
    expect(opened!.queryParameters['lock'], '1');

    send(jsonEncode({'id': 1, 'method': 'getResource', 'args': ['did:ad:doc']}));
    // Asks for something only an app with its own screens has: not the store.
    send(jsonEncode({'id': 2, 'method': 'openNative', 'args': ['x']}));
    // Drawing notices need no answer.
    send(jsonEncode({'method': 'revealed'}));
    await tester.pumpAndSettle();

    expect(calls, ['getResource ["did:ad:doc"]']);
    expect(page.scripts, unorderedEquals([
      'window.__atomicReply(1,true,${jsonEncode('{"ok":1}')})',
      'window.__atomicReply(2,true,${jsonEncode('true')})',
    ]));

    // Leaving without an answer from the page gives up after the timeout.
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await tester.pump(const Duration(seconds: 3));
    expect(page.released, isTrue);
  });

  testWidgets('leaving hands over the edits before the page is released',
      (tester) async {
    final page = _FakePage();
    late void Function(String) send;
    await tester.pumpWidget(MaterialApp(
      home: AtomicDocumentView(
        subject: 'did:ad:doc',
        call: (_, __) async => 'null',
        pageFactory: (url, onMessage) async {
          send = onMessage;
          return page;
        },
      ),
    ));
    await tester.pumpAndSettle();

    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    expect(page.scripts.single, contains('atomicEmbed.flush(true)'));
    expect(page.released, isFalse);
    send(jsonEncode({'method': 'flushed', 'flush': 1}));
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    expect(page.released, isTrue);
  });
}
