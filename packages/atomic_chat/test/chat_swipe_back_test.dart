import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'assistant_screens_test.dart' show FakeApi, shellApp;

void main() {
  FakeApi api() {
    final now = DateTime.now().millisecondsSinceEpoch;
    return FakeApi(
      chatList: [
        for (var i = 0; i < 6; i++)
          (
            subject: 'did:ad:$i',
            name: 'Chat $i',
            lastActivity: now - i,
            emoji: null
          ),
      ],
      messageList: [
        (id: 'p#1', role: 'user', text: 'Where to?', createdAt: 1),
        (id: 'p#2', role: 'assistant', text: 'Lisbon.', createdAt: 2),
      ],
    );
  }

  Future<void> swipeRight(WidgetTester tester, {double y = 300}) async {
    final g = await tester.startGesture(Offset(150, y));
    for (var i = 0; i < 10; i++) {
      await g.moveBy(const Offset(25, 0));
      await tester.pump(const Duration(milliseconds: 10));
    }
    await g.up();
    await tester.pumpAndSettle();
  }

  testWidgets('a swipe right in a chat goes back to the AI chats list',
      (tester) async {
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester
        .pumpWidget(shellApp(ChatsScreen(drive: 'did:ad:drive', api: api())));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show all (6)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Chat 5'));
    await tester.pumpAndSettle();
    expect(find.text('Lisbon.'), findsOneWidget);

    await swipeRight(tester);
    expect(find.byType(ChatScreen), findsNothing);
    expect(find.text('Chat 5'), findsOneWidget);
  });

  testWidgets('the system back in a chat goes back to the AI chats list',
      (tester) async {
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester
        .pumpWidget(shellApp(ChatsScreen(drive: 'did:ad:drive', api: api())));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show all (6)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Chat 5'));
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsNothing);
    expect(find.text('Chat 5'), findsOneWidget);
  });

  testWidgets('+ New on the AI chats list starts a new chat', (tester) async {
    await tester
        .pumpWidget(shellApp(ChatsScreen(drive: 'did:ad:drive', api: api())));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show all (6)'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('chats-new')));
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    expect(find.text('New chat'), findsOneWidget);
  });

  for (final y in [120.0, 400.0, 740.0]) {
    testWidgets('a swipe right at $y in a new chat goes back', (tester) async {
      tester.view.physicalSize = const Size(400, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester
          .pumpWidget(shellApp(ChatsScreen(drive: 'did:ad:drive', api: api())));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Show all (6)'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('chats-new')));
      await tester.pumpAndSettle();
      await swipeRight(tester, y: y);
      expect(find.byType(ChatScreen), findsNothing);
    });
  }

  group('tablet', () {
    Future<void> openList(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester
          .pumpWidget(shellApp(ChatsScreen(drive: 'did:ad:drive', api: api())));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Show all (6)'));
      await tester.pumpAndSettle();
    }

    Future<void> swipe(WidgetTester tester) async {
      final g = await tester.startGesture(const Offset(700, 300));
      for (var i = 0; i < 10; i++) {
        await g.moveBy(const Offset(30, 0),
            timeStamp: Duration(milliseconds: 10 * (i + 1)));
        await tester.pump(const Duration(milliseconds: 10));
      }
      await g.up(timeStamp: const Duration(milliseconds: 110));
      await tester.pumpAndSettle();
    }

    testWidgets('a swipe right in a chat in the detail pane goes back',
        (tester) async {
      await openList(tester);
      await tester.tap(find.text('Chat 5').last);
      await tester.pumpAndSettle();
      expect(find.byType(ChatScreen), findsOneWidget);
      await swipe(tester);
      expect(find.byType(ChatScreen), findsNothing);
      expect(find.text('Chat 5'), findsWidgets);
    });

    testWidgets('the first detail page does not leave on a swipe',
        (tester) async {
      await openList(tester);
      expect(find.byKey(const Key('chats-new')), findsOneWidget);
      await swipe(tester);
      expect(find.byKey(const Key('chats-new')), findsOneWidget);
    });
  });
}
