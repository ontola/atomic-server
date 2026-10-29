import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'resource_view_test.dart' show FakePage;
import 'unimplemented_api.dart';

class _PresenceApi extends UnimplementedApi {
  _PresenceApi(this.others);
  List<PresenceItem> others;
  final announced = <({String drive, String? resource, String? following})>[];
  final cleared = <String>[];

  @override
  void noteOpened(String drive, String subject) {}
  @override
  Future<List<PresenceItem>> presence(String drive) async => others;
  @override
  Future<void> announcePresence(String drive,
      {String? resource, String? following}) async {
    announced.add((drive: drive, resource: resource, following: following));
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
  setUp(() => ResourceView.pageFactory = (send) => FakePage(send));
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
}
