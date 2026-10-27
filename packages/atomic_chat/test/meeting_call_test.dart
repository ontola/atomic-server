import 'dart:async';
import 'dart:convert';

import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter/webview_flutter.dart'
    show WebViewPermissionResourceType;

import 'assistant_screens_test.dart' show FakeApi, app;
import 'resource_view_test.dart' show FakePage;
import 'unimplemented_api.dart';

/// A call page that needs no web view.
class FakeCallPage implements WarmPage {
  FakeCallPage(this.url, this.send);
  final Uri url;
  final void Function(String message) send;
  final scripts = <String>[];
  bool released = false;

  @override
  bool get isReady => !released;
  @override
  Future<void> get whenReady async {}
  @override
  set onMessage(void Function(String)? handler) {}
  @override
  set onLoaded(VoidCallback? handler) {}
  @override
  Future<void> runJavaScript(String script) async => scripts.add(script);
  @override
  Future<Object> runJavaScriptReturningResult(String script) async => false;
  @override
  Widget build() => const Center(child: Text('the call page'));
  @override
  void release() => released = true;
}

class _StoreApi extends UnimplementedApi {
  final calls = <String>[];
  @override
  Future<String> embedCall(String method, String argsJson) async {
    calls.add('$method $argsJson');
    return '"stored"';
  }
}

class _Permissions implements CallPermissions {
  _Permissions(this.allow);
  bool allow;
  final asked = <Set<CallMedia>>[];
  @override
  Future<bool> request(Set<CallMedia> media) async {
    asked.add(media);
    return allow;
  }
}

void main() {
  final pages = <FakeCallPage>[];
  Completer<void>? hold;

  setUp(() {
    pages.clear();
    hold = null;
    MeetingCall.pageFactory = (url, send) async {
      await hold?.future;
      final page = FakeCallPage(url, send);
      pages.add(page);
      return page;
    };
  });
  tearDown(() {
    MeetingCall.pageFactory = null;
    ResourceView.pageFactory = null;
  });

  group('MeetingCall', () {
    test('starts the call page of a meeting, expanded', () async {
      final call = MeetingCall(api: _StoreApi());
      expect(call.active, isFalse);

      await call.start('did:ad:meeting', scheme: 'dark');

      expect(call.active, isTrue);
      expect(call.meeting, 'did:ad:meeting');
      expect(call.expanded, isTrue);
      expect(call.page, same(pages.single));
      expect(pages.single.url.queryParameters,
          {'call': 'did:ad:meeting', 'scheme': 'dark'});
    });

    test('a meeting already in a call is not started twice', () async {
      final call = MeetingCall(api: _StoreApi());
      await call.start('did:ad:meeting');
      call.collapse();
      expect(call.expanded, isFalse);

      await call.start('did:ad:meeting');

      expect(pages, hasLength(1));
      expect(call.expanded, isTrue);
    });

    test('another meeting ends the first call', () async {
      final call = MeetingCall(api: _StoreApi());
      await call.start('did:ad:one');
      await call.start('did:ad:two');

      expect(pages, hasLength(2));
      expect(pages.first.released, isTrue);
      expect(pages.last.released, isFalse);
      expect(call.meeting, 'did:ad:two');
    });

    test('leaving drops the page and the call', () async {
      final call = MeetingCall(api: _StoreApi());
      await call.start('did:ad:meeting');
      var notified = 0;
      call.addListener(() => notified++);

      call.leave();

      expect(call.active, isFalse);
      expect(call.page, isNull);
      expect(pages.single.released, isTrue);
      expect(notified, 1);
      call.leave();
      expect(notified, 1);
    });

    test('leaving before the page is up releases it when it arrives', () async {
      hold = Completer<void>();
      final call = MeetingCall(api: _StoreApi());
      final started = call.start('did:ad:meeting');
      await pumpEventQueue();
      expect(call.active, isTrue);
      expect(call.page, isNull);

      call.leave();
      hold!.complete();
      await started;

      expect(pages.single.released, isTrue);
      expect(call.page, isNull);
      expect(call.active, isFalse);
    });

    test('the page\'s Leave button ends the call', () async {
      final call = MeetingCall(api: _StoreApi());
      await call.start('did:ad:meeting');
      final page = pages.single;

      page.send(jsonEncode({'id': 5, 'method': 'leaveCall', 'args': []}));
      await pumpEventQueue();

      expect(call.active, isFalse);
      expect(page.released, isTrue);
      expect(page.scripts, contains('window.__atomicReply(5,true,"true")'));
    });

    test('the page reads and writes the store through the api', () async {
      final api = _StoreApi();
      final call = MeetingCall(api: api);
      await call.start('did:ad:meeting');
      final page = pages.single;

      page.send(jsonEncode({
        'id': 1,
        'method': 'getResource',
        'args': ['did:ad:agent']
      }));
      page.send(jsonEncode({
        'id': 2,
        'method': 'theme',
        'args': ['dark']
      }));
      await pumpEventQueue();

      expect(api.calls, ['getResource ["did:ad:agent"]']);
      expect(page.scripts,
          contains('window.__atomicReply(1,true,"\\"stored\\"")'));
      // Reports that mean nothing to a call page are acknowledged only.
      expect(page.scripts, contains('window.__atomicReply(2,true,"false")'));
    });

    test('the small tile is moved, kept through collapse and expand', () async {
      final call = MeetingCall(api: _StoreApi());
      await call.start('did:ad:meeting');

      call.moveTile(const Offset(10, 20));
      call.expand();
      call.collapse();

      expect(call.tileOffset, const Offset(10, 20));
    });
  });

  group('permissions', () {
    test('maps the page\'s request to the device resources', () {
      expect(callMediaOf({WebViewPermissionResourceType.microphone}),
          {CallMedia.microphone});
      expect(
          callMediaOf({
            WebViewPermissionResourceType.camera,
            WebViewPermissionResourceType.microphone,
          }),
          {CallMedia.camera, CallMedia.microphone});
      expect(callMediaOf({}), isNull);
    });

    Future<List<String>> answer(
        Set<WebViewPermissionResourceType> types, CallPermissions p) async {
      final result = <String>[];
      await answerPermissionRequest(
        types: types,
        grant: () async => result.add('grant'),
        deny: () async => result.add('deny'),
        permissions: p,
      );
      return result;
    }

    test('grants after the person allowed what was asked', () async {
      final p = _Permissions(true);
      expect(
          await answer({
            WebViewPermissionResourceType.camera,
            WebViewPermissionResourceType.microphone,
          }, p),
          ['grant']);
      expect(p.asked.single, {CallMedia.camera, CallMedia.microphone});
    });

    test('denies when the person refused', () async {
      final p = _Permissions(false);
      expect(await answer({WebViewPermissionResourceType.microphone}, p),
          ['deny']);
    });

    test('a request of anything else is denied without asking', () async {
      final p = _Permissions(true);
      expect(await answer({}, p), ['deny']);
      expect(p.asked, isEmpty);
    });

    test('a permission layer that throws denies', () async {
      expect(await answer({WebViewPermissionResourceType.camera}, _Throws()),
          ['deny']);
    });
  });

  group('in the shell', () {
    Widget shell(FakeApi api) => app(AppShell(
          api: api,
          drive: 'did:ad:drive',
          warmPool: (_) => null,
          landOn: (subject: 'did:ad:meeting', title: 'Standup'),
          home: ChatsScreen(drive: 'did:ad:drive', api: api),
        ));

    late FakePage resourcePage;
    setUp(() =>
        ResourceView.pageFactory = (send) => resourcePage = FakePage(send));

    ShellController controller(WidgetTester tester) =>
        tester.widget<ShellScope>(find.byType(ShellScope).first).controller;

    Future<void> joinFromPage(WidgetTester tester) async {
      resourcePage.send(jsonEncode({
        'id': 11,
        'method': 'joinCall',
        'args': ['did:ad:meeting'],
      }));
      await tester.pumpAndSettle();
    }

    testWidgets('the page\'s joinCall starts the call, shown as a tile',
        (tester) async {
      await tester.pumpWidget(shell(FakeApi()));
      await tester.pumpAndSettle();
      expect(controller(tester).call?.active, isFalse);
      expect(find.text('the call page'), findsNothing);

      await joinFromPage(tester);

      expect(resourcePage.scripts,
          contains('window.__atomicReply(11,true,"true")'));
      final call = controller(tester).call!;
      expect(call.meeting, 'did:ad:meeting');
      expect(find.text('the call page'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('the call survives the page being left', (tester) async {
      await tester.pumpWidget(shell(FakeApi()));
      await tester.pumpAndSettle();
      await joinFromPage(tester);
      final call = controller(tester).call!;
      final callPage = pages.single;

      // Follow the leader away: the resource page goes, another may come.
      controller(tester).navigatorKey.currentState!.pop();
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.byType(ResourceView), findsNothing);

      expect(call.active, isTrue);
      expect(callPage.released, isFalse);
      expect(find.text('the call page'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('the tile expands on a tap, moves on a drag and leaves',
        (tester) async {
      await tester.pumpWidget(shell(FakeApi()));
      await tester.pumpAndSettle();
      await joinFromPage(tester);
      final call = controller(tester).call!;

      // Expanded at first: a larger view with a minimize button.
      expect(call.expanded, isTrue);
      final big = tester.getSize(find.byKey(const ValueKey('meeting-call')));
      await tester.tap(find.byKey(const ValueKey('meeting-call-collapse')));
      await tester.pumpAndSettle();
      expect(call.expanded, isFalse);
      final small = tester.getSize(find.byKey(const ValueKey('meeting-call')));
      expect(small.width, lessThan(big.width));
      expect(find.byKey(const ValueKey('meeting-call-collapse')), findsNothing);

      // A drag moves it (the call page is not touched).
      final before =
          tester.getTopLeft(find.byKey(const ValueKey('meeting-call')));
      await tester.drag(find.byKey(const ValueKey('meeting-call-tile')),
          const Offset(-40, 30));
      await tester.pumpAndSettle();
      final after =
          tester.getTopLeft(find.byKey(const ValueKey('meeting-call')));
      expect(after.dx, lessThan(before.dx));
      expect(after.dy, greaterThan(before.dy));
      expect(call.expanded, isFalse);

      // A tap expands it again.
      await tester.tap(find.byKey(const ValueKey('meeting-call-tile')));
      await tester.pumpAndSettle();
      expect(call.expanded, isTrue);

      // Leave ends the call and takes the tile away.
      await tester.tap(find.byKey(const ValueKey('meeting-call-leave')));
      await tester.pumpAndSettle();
      expect(call.active, isFalse);
      expect(pages.single.released, isTrue);
      expect(find.byKey(const ValueKey('meeting-call')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('a page outside a shell says no to joinCall', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData(extensions: const [AppColors.light]),
        home: const ResourceView(
            api: UnimplementedApi(), drive: 'd', subject: 's'),
      ));
      await tester.pumpAndSettle();

      resourcePage.send(jsonEncode({
        'id': 3,
        'method': 'joinCall',
        'args': ['did:ad:meeting'],
      }));
      await tester.pumpAndSettle();

      expect(resourcePage.scripts,
          contains('window.__atomicReply(3,true,"false")'));
      expect(pages, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    });
  });
}

class _Throws implements CallPermissions {
  @override
  Future<bool> request(Set<CallMedia> media) async => throw StateError('no');
}
