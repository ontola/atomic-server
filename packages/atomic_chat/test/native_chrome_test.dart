import 'dart:convert';

import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'assistant_screens_test.dart' show FakeApi, app;

const _parent = 'https://atomicdata.dev/properties/parent';
const _name = 'https://atomicdata.dev/properties/name';
const _isA = 'https://atomicdata.dev/properties/isA';

/// A store with Home > Projects > the screen's own resource.
class _TreeApi extends FakeApi {
  final renamed = <(String, String)>[];

  static const _tree = <String, Map<String, Object>>{
    'did:ad:home': {_name: 'Home'},
    'did:ad:projects': {
      _name: 'Projects',
      _parent: 'did:ad:home',
      _isA: [chatRoomClass],
    },
    'did:ad:res': {_name: 'Standup', _parent: 'did:ad:projects'},
  };

  @override
  Future<String> embedCall(String method, String argsJson) async {
    final subject = (jsonDecode(argsJson) as List).first as String;
    return jsonEncode(_tree[subject]);
  }

  @override
  Future<List<ChatRoomMessage>> chatRoomMessages(String s) async => [];

  @override
  Future<void> renameResource(String subject, String name) async =>
      renamed.add((subject, name));
}

/// Opens [screen] on top of the shell's home, as a resource is opened.
Future<void> _push(WidgetTester tester, _TreeApi api, Widget screen) async {
  SharedPreferences.setMockInitialValues({});
  await tester.pumpWidget(app(AppShell(
      api: api,
      drive: 'did:ad:home',
      warmPool: (_) => null,
      home: const Scaffold(body: Text('home')))));
  final shell = tester.widget<ShellScope>(find.byType(ShellScope)).controller;
  shell.navigatorKey.currentState!
      .push(MaterialPageRoute<void>(builder: (_) => screen));
  await tester.pumpAndSettle();
}

/// Taps the bar's "more" button.
Future<void> openMoreMenu(WidgetTester tester) async {
  await tester.tap(find.byTooltip('More'));
  await tester.pump();
  // The page is told once the overlay is laid out.
  await tester.pump(const Duration(milliseconds: 200));
  await tester.pumpAndSettle();
}

/// The page in a web view, without the web view.
class _FakePage implements EmbedPage {
  final void Function(String message) send;
  final scripts = <String>[];
  _FakePage(this.send);

  @override
  Future<void> runJavaScript(String script) async => scripts.add(script);

  @override
  Future<Object> runJavaScriptReturningResult(String script) async => false;

  @override
  Widget build() => const Center(child: Text('the page'));
}

late EmbedPage page;

/// Lets the closed overlay's page be released (a timer after it closes).
Future<void> _letGo(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 6));
}

void main() {
  setUp(() => ResourceView.pageFactory = (send) => page = _FakePage(send));
  tearDown(() => ResourceView.pageFactory = null);

  final screens = <String, Widget Function(_TreeApi)>{
    'chat room': (api) => ChatRoomScreen(
        api: api,
        drive: 'did:ad:home',
        subject: 'did:ad:res',
        title: 'Standup'),
    'conversation': (api) => ConversationScreen(
        api: api,
        drive: 'did:ad:home',
        subject: 'did:ad:res',
        title: 'Standup'),
    'AI chat': (api) => ChatScreen(
        api: api,
        drive: 'did:ad:home',
        subject: 'did:ad:res',
        title: 'Standup'),
  };

  for (final MapEntry(key: name, value: build) in screens.entries) {
    group('the $name', () {
      testWidgets('shows the breadcrumbs of the web page', (tester) async {
        final api = _TreeApi();
        if (name == 'AI chat') {
          // An AI chat is person-scoped: no drive trail over it.
          await _push(tester, api, build(api));
          expect(find.byKey(const Key('breadcrumbs')), findsNothing);
          return;
        }
        await _push(tester, api, build(api));
        final bar = find.byKey(const Key('breadcrumbs'));
        expect(find.descendant(of: bar, matching: find.text('Home')),
            findsOneWidget);
        expect(find.descendant(of: bar, matching: find.text('Projects')),
            findsOneWidget);
        // The title bar names the resource itself.
        expect(find.descendant(of: bar, matching: find.text('Standup')),
            findsNothing);
      });

      testWidgets('More shows the web app\'s menu for the resource',
          (tester) async {
        final api = _TreeApi();
        await _push(tester, api, build(api));
        await openMoreMenu(tester);
        // The web page's menu, on a transparent page over the screen: the
        // page is told to show only the menu of this resource.
        expect(
            (page as _FakePage)
                .scripts
                .where((s) => s.contains('showMenu'))
                .single,
            contains('"did:ad:res"'));
        expect(find.text('the page'), findsOneWidget);
        // No second, hand-made menu.
        expect(find.text('Copy link'), findsNothing);
        expect(find.text('Open in browser'), findsNothing);
        await _letGo(tester);
      });

      testWidgets('the overlay closes when the page says the menu is done',
          (tester) async {
        final api = _TreeApi();
        await _push(tester, api, build(api));
        await openMoreMenu(tester);
        (page as _FakePage)
            .send(jsonEncode({'method': 'menuState', 'state': 'closed'}));
        // Leaving waits (at most 2 s) for the page to hand over its edits.
        await tester.pump(const Duration(seconds: 3));
        await tester.pumpAndSettle();
        expect(find.text('the page'), findsNothing);
        expect(find.byTooltip('More'), findsOneWidget);
        await _letGo(tester);
      });
    });
  }

  testWidgets('a crumb opens that resource', (tester) async {
    final api = _TreeApi();
    await _push(tester, api, screens['chat room']!(api));
    await tester.tap(find.text('Projects'));
    await tester.pumpAndSettle();
    expect(api.opened, ['did:ad:projects']);
    expect(find.byType(ChatRoomScreen, skipOffstage: false), findsNWidgets(2));
  });

  testWidgets('an action that opens a page keeps the overlay as that page',
      (tester) async {
    final api = _TreeApi();
    await _push(tester, api, screens['chat room']!(api));
    await openMoreMenu(tester);
    (page as _FakePage)
        .send(jsonEncode({'method': 'menuState', 'state': 'page'}));
    await tester.pumpAndSettle();
    // Still there, no longer transparent: it is a page now.
    expect(find.text('the page'), findsOneWidget);
    expect(find.byType(Scaffold), findsWidgets);
    await _letGo(tester);
  });

  testWidgets('the room is renamed from its title', (tester) async {
    final api = _TreeApi();
    await _push(tester, api, screens['chat room']!(api));
    await tester.tap(find.byKey(const Key('chat-title')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('chat-room-name')), ' Family ');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(api.renamed, [('did:ad:res', 'Family')]);
    expect(find.text('Family'), findsWidgets);
  });

  testWidgets('a new chat is not in the drive yet: no crumbs, no menu',
      (tester) async {
    final api = _TreeApi();
    await _push(tester, api, ChatScreen(api: api, drive: 'did:ad:home'));
    expect(find.byKey(const Key('breadcrumbs')), findsNothing);
    expect(find.byTooltip('More'), findsNothing);
  });
}
