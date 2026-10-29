import 'package:atomic_buildings/ui/building_chat_page.dart';
import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<HostedAi?> _noAccount() async => null;

/// A chat with no linked account.
const noAccountChat = BuildingChat(ai: _noAccount);

/// [home] in an app whose theme has the colours the chat screens read.
Widget chatApp(Widget home) => MaterialApp(
    theme: ThemeData(extensions: const [AppColors.light]), home: home);

/// Opens Plan, Sources or Questions from the title bar menu.
Future<void> openScreen(WidgetTester tester, String name) async {
  await tester.tap(find.byTooltip('Plan, sources and questions'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(name).last);
  await tester.pumpAndSettle();
}
