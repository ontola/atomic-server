import 'dart:convert';

import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'resource_view_test.dart' show FakePage;
import 'unimplemented_api.dart';

class _PresenceApi extends UnimplementedApi {
  _PresenceApi(this.others);
  List<PresenceItem> others;
  final announced = <({
    String drive,
    String? resource,
    String? following,
    String? session,
    Map<String, Object?>? extra
  })>[];
  final cleared = <String>[];

  @override
  void noteOpened(String drive, String subject) {}
  @override
  Future<List<PresenceItem>> presence(String drive) async => others;
  @override
  Future<void> announcePresence(String drive,
      {String? resource,
      String? following,
      String? session,
      Map<String, Object?>? extra}) async {
    announced.add((
      drive: drive,
      resource: resource,
      following: following,
      session: session,
      extra: extra
    ));
  }

  @override
  Future<void> clearPresence(String drive) async => cleared.add(drive);
  @override
  Future<String?> conversationWith(String agent) async => 'dm-$agent';
  @override
  Future<ProfileIdentity?> identityOf(String agent) async =>
      ProfileIdentity(name: 'Name of $agent');
}

PresenceItem who(String agent,
        {String? resource = 'page', int at = 1, bool allowFollow = true}) =>
    PresenceItem(
        sessionId: 's-$agent-$at',
        agent: agent,
        resource: resource,
        updatedAt: at,
        allowFollow: allowFollow);

void main() {
  late FakePage page;
  setUp(() => ResourceView.pageFactory = (send) => page = FakePage(send));
  tearDown(() => ResourceView.pageFactory = null);

  Future<_PresenceApi> open(WidgetTester tester, List<PresenceItem> others,
      {bool tapAvatar = false}) async {
    final api = _PresenceApi(others);
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData(extensions: const [AppColors.light]),
      home: ResourceView(api: api, drive: 'drive', subject: 'page'),
    ));
    await tester.pump();
    await tester.pump();
    return api;
  }

  testWidgets('announces the resource when the page opens', (tester) async {
    final api = await open(tester, const []);
    expect(api.announced.first.resource, 'page');
    expect(api.announced.first.drive, 'drive');
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('no facepile when alone', (tester) async {
    await open(tester, [who('a', resource: 'elsewhere')]);
    expect(find.byKey(const Key('presence-facepile')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('shows the others on this page only', (tester) async {
    await open(tester, [
      who('a'),
      who('b'),
      who('c', resource: 'elsewhere'),
    ]);
    expect(find.byKey(const Key('presence-facepile')), findsOneWidget);
    expect(find.byKey(const Key('presence-avatar-a')), findsOneWidget);
    expect(find.byKey(const Key('presence-avatar-b')), findsOneWidget);
    expect(find.byKey(const Key('presence-avatar-c')), findsNothing);
    expect(find.byKey(const Key('presence-more')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('one avatar per agent, any session of theirs here counts',
      (tester) async {
    await open(tester, [
      who('a', at: 1),
      who('a', at: 2),
      // Their other device announced later, elsewhere: this one is still here.
      who('b', at: 1),
      who('b', resource: 'elsewhere', at: 2),
      who('c'),
      who('d'),
    ]);
    expect(find.byKey(const Key('presence-avatar-a')), findsOneWidget);
    expect(find.byKey(const Key('presence-avatar-b')), findsOneWidget);
    // Three shown, the rest as a number.
    expect(find.byKey(const Key('presence-avatar-c')), findsOneWidget);
    expect(find.byKey(const Key('presence-avatar-d')), findsNothing);
    expect(find.text('+1'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('the sheet offers Follow, unless they turned it off',
      (tester) async {
    await open(tester, [who('a'), who('b', allowFollow: false)]);
    await tester.tap(find.byKey(const Key('presence-avatar-a')));
    await tester.pumpAndSettle();
    expect(find.text('Name of a'), findsOneWidget);
    expect(find.text('Profile'), findsOneWidget);
    expect(find.text('Message'), findsOneWidget);
    expect(find.text('Follow'), findsOneWidget);
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('presence-avatar-b')));
    await tester.pumpAndSettle();
    expect(find.text('Profile'), findsOneWidget);
    expect(find.text('Message'), findsOneWidget);
    expect(find.text('Follow'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('following announces who, and Stop following ends it',
      (tester) async {
    final api = await open(tester, [who('a')]);
    await tester.tap(find.byKey(const Key('presence-avatar-a')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Follow'));
    await tester.pumpAndSettle();
    expect(api.announced.last.following, 'a');
    expect(api.announced.last.resource, 'page');

    await tester.tap(find.byKey(const Key('presence-avatar-a')));
    await tester.pumpAndSettle();
    expect(find.text('Stop following'), findsOneWidget);
    await tester.tap(find.text('Stop following'));
    await tester.pumpAndSettle();
    expect(api.announced.last.following, isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  /// What the page calls: `{id, method, args}`.
  void call(WidgetTester tester, String method, List<Object?> args) {
    page.send(jsonEncode({'id': 7, 'method': method, 'args': args}));
  }

  testWidgets('parses and writes back the fields the page reads',
      (tester) async {
    final item = PresenceItem.fromJson({
      'sessionId': 's1',
      'agent': 'a',
      'resource': 'r',
      'session': 'meeting',
      'data': {'cursor': 3},
      'typing': 'room',
      'allowFollow': false,
      'updatedAt': 5,
    });
    expect(item.session, 'meeting');
    expect(item.data, {'cursor': 3});
    expect(item.typing, 'room');
    expect(PresenceItem.fromJson(item.toJson()).toJson(), item.toJson());
    expect(item.toJson()['allowFollow'], false);

    final bare = PresenceItem.fromJson({'sessionId': 's', 'agent': 'a'});
    expect(bare.session, isNull);
    expect(bare.data, isNull);
    expect(bare.typing, isNull);
    expect(bare.toJson(), {'sessionId': 's', 'agent': 'a'});
  });

  testWidgets('pushes the others into the page, with who is followed',
      (tester) async {
    await open(tester, [
      PresenceItem(
          sessionId: 's1',
          agent: 'a',
          resource: 'page',
          data: const {'cursor': 3},
          typing: 'room',
          session: 'meeting'),
    ]);
    final push =
        page.scripts.lastWhere((s) => s.contains('atomicEmbed?.presence('));
    expect(push, contains('presence("drive",['));
    final items = jsonDecode(
        push.substring(push.indexOf('[{'), push.lastIndexOf(']') + 1)) as List;
    expect(items.single['agent'], 'a');
    expect(items.single['data'], {'cursor': 3});
    expect(items.single['typing'], 'room');
    expect(items.single['session'], 'meeting');
    expect(page.scripts, contains('window.atomicEmbed?.setFollow(null)'));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('a changed list is pushed again, an unchanged one is not',
      (tester) async {
    final api = await open(tester, [who('a')]);
    int pushes() =>
        page.scripts.where((s) => s.contains('atomicEmbed?.presence(')).length;
    final before = pushes();
    await tester.pump(const Duration(seconds: 6));
    expect(pushes(), before);

    api.others = [who('a'), who('b')];
    await tester.pump(const Duration(seconds: 6));
    expect(pushes(), before + 1);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('the page\'s presence fields join the next announcement',
      (tester) async {
    final api = await open(tester, const []);
    final before = api.announced.length;
    call(tester, 'presence', [
      {
        'data': {'cell': 'b2'},
        'typing': 'room',
        'session': 'meeting'
      }
    ]);
    await tester.pump();
    expect(api.announced.length, before + 1);
    final last = api.announced.last;
    // What the app owns stays.
    expect(last.resource, 'page');
    expect(last.following, isNull);
    expect(last.session, 'meeting');
    expect(last.extra, {
      'data': {'cell': 'b2'},
      'typing': 'room'
    });
    expect(page.scripts.last, contains('__atomicReply(7,true'));

    // Nothing new: nothing announced.
    call(tester, 'presence', [
      {'typing': 'room'}
    ]);
    await tester.pump();
    expect(api.announced.length, before + 1);

    // Null clears one field and leaves the others.
    call(tester, 'presence', [
      {'typing': null}
    ]);
    await tester.pump();
    expect(api.announced.last.extra, {
      'data': {'cell': 'b2'}
    });
    expect(api.announced.last.session, 'meeting');
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('follow and unfollow from the page set the app\'s follow state',
      (tester) async {
    final api = await open(tester, [who('a')]);
    call(tester, 'follow', ['a']);
    await tester.pumpAndSettle();
    expect(api.announced.last.following, 'a');
    expect(api.announced.last.resource, 'page');
    expect(page.scripts, contains('window.atomicEmbed?.setFollow("a")'));
    expect(page.scripts.last, contains('__atomicReply(7,true'));

    call(tester, 'unfollow', const []);
    await tester.pumpAndSettle();
    expect(api.announced.last.following, isNull);
    expect(page.scripts.last, contains('__atomicReply(7,true'));
    expect(page.scripts.where((s) => s.contains('setFollow(null)')).length, 2);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('follow from the page navigates to the leader, once',
      (tester) async {
    final api = await open(tester, [who('a', resource: 'elsewhere')]);
    call(tester, 'follow', ['a']);
    await tester.pumpAndSettle();
    // The app navigated: the page of the followed resource announces now.
    expect(api.announced.last.resource, 'elsewhere');
    expect(
        api.announced.where((a) => a.resource == 'elsewhere').length, 1);
    expect(find.byType(ResourceView), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });
}
