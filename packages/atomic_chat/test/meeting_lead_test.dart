import 'dart:convert';

import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'resource_view_test.dart' show FakePage;
import 'unimplemented_api.dart';

class _Api extends UnimplementedApi {
  _Api({this.others = const [], this.listed});
  List<PresenceItem> others;

  /// The drive's `currentMeetings`; null: the host cannot tell.
  Set<String>? listed;
  final announced =
      <({String? resource, String? following, String? session})>[];
  final sent = <({String room, String text})>[];

  @override
  void noteOpened(String drive, String subject) {}
  @override
  Future<List<PresenceItem>> presence(String drive) async => others;
  @override
  Future<Set<String>?> currentMeetings(String drive) async => listed;
  @override
  Future<void> announcePresence(String drive,
      {String? resource,
      String? following,
      String? session,
      Map<String, Object?>? extra}) async {
    announced.add((resource: resource, following: following, session: session));
  }

  @override
  Future<void> clearPresence(String drive) async {}
  @override
  Future<void> sendChatRoomMessage(String subject, String text) async {
    sent.add((room: subject, text: text));
  }

  @override
  Future<ProfileIdentity?> identityOf(String agent) async =>
      ProfileIdentity(name: 'Name of $agent');
}

PresenceItem _leader({int at = 1}) => PresenceItem(
    sessionId: 's-lead',
    agent: 'lead',
    resource: 'elsewhere',
    updatedAt: at,
    session: 'meeting');

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('MeetingLead', () {
    test('is kept per drive, ends only the meeting it leads', () {
      final lead = MeetingLead();
      expect(lead.leading, isFalse);
      lead.start('drive', 'm1');
      expect(lead.meetingIn('drive'), 'm1');
      expect(lead.meetingIn('other'), isNull);
      // A late "ended" for an older meeting does not end the new one.
      lead.end('m0');
      expect(lead.meeting, 'm1');
      lead.end('m1');
      expect(lead.leading, isFalse);
    });

    test('survives a restart and forgets when the meeting ends', () async {
      final first = MeetingLead()..start('drive', 'm1');
      expect(first.markTrailed('page'), isTrue);
      await pumpEventQueue();
      final restarted = MeetingLead();
      await restarted.load();
      expect(restarted.meetingIn('drive'), 'm1');
      // What was trailed before the restart is not trailed again.
      expect(restarted.markTrailed('page'), isFalse);
      expect(restarted.markTrailed('another'), isTrue);

      restarted.end();
      await pumpEventQueue();
      final after = MeetingLead();
      await after.load();
      expect(after.leading, isFalse);
    });

    test('trails each resource once per meeting, the meeting itself never', () {
      final lead = MeetingLead()..start('drive', 'm1');
      expect(lead.markTrailed('m1'), isFalse);
      expect(lead.markTrailed('a'), isTrue);
      expect(lead.markTrailed('a'), isFalse);
      lead.end();
      expect(lead.markTrailed('a'), isFalse);
      lead.start('drive', 'm2');
      expect(lead.markTrailed('a'), isTrue);
    });
  });

  group('liveMeetingOf', () {
    test('needs an announcement, and the listing when it is known', () {
      expect(liveMeetingOf(const [], null), isNull);
      expect(liveMeetingOf([_leader()], null)?.meeting, 'meeting');
      expect(liveMeetingOf([_leader()], {'meeting'})?.meeting, 'meeting');
      expect(liveMeetingOf([_leader()], {'another'}), isNull);
      expect(liveMeetingOf([_leader()], const {}), isNull);
    });

    test('takes the freshest announcement', () {
      final newer = PresenceItem(
          sessionId: 's2', agent: 'b', updatedAt: 9, session: 'meeting');
      expect(liveMeetingOf([_leader(), newer], null)?.leader.agent, 'b');
    });
  });

  group('on a resource page', () {
    late FakePage page;
    setUp(() => ResourceView.pageFactory = (send) => page = FakePage(send));
    tearDown(() => ResourceView.pageFactory = null);

    Future<ShellController> open(WidgetTester tester, _Api api,
        {String subject = 'page', String title = 'The page'}) async {
      final shell = ShellController(drive: 'drive');
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData(extensions: const [AppColors.light]),
        home: ShellScope(
          controller: shell,
          child: ResourceView(
              api: api, drive: 'drive', subject: subject, title: title),
        ),
      ));
      await tester.pump();
      await tester.pump();
      return shell;
    }

    void call(String method, List<Object?> args) =>
        page.send(jsonEncode({'id': 7, 'method': method, 'args': args}));

    Future<void> close(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    }

    testWidgets('the page starting a meeting makes the app lead it',
        (tester) async {
      final api = _Api();
      final shell = await open(tester, api);
      expect(api.announced.last.session, isNull);
      expect(page.scripts, contains('window.atomicEmbed?.setMeeting(null)'));

      call('meetingStarted', ['m1']);
      await tester.pump();
      expect(shell.lead.meetingIn('drive'), 'm1');
      // The entry carries it and the page hears it.
      expect(api.announced.last.session, 'm1');
      expect(api.announced.last.resource, 'page');
      expect(page.scripts.last, contains('__atomicReply(7,true'));
      expect(page.scripts, contains('window.atomicEmbed?.setMeeting("m1")'));

      call('meetingEnded', ['m1']);
      await tester.pump();
      expect(shell.lead.leading, isFalse);
      expect(api.announced.last.session, isNull);
      expect(page.scripts.last, contains('__atomicReply(7,true'));
      await close(tester);
    });

    testWidgets('a lead from before a restart is announced at once',
        (tester) async {
      final api = _Api();
      final shell = ShellController(drive: 'drive')..lead.start('drive', 'm1');
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData(extensions: const [AppColors.light]),
        home: ShellScope(
          controller: shell,
          child: ResourceView(api: api, drive: 'drive', subject: 'page'),
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(api.announced.first.session, 'm1');
      expect(page.scripts, contains('window.atomicEmbed?.setMeeting("m1")'));
      await close(tester);
    });

    testWidgets('a meeting led on another drive is not announced here',
        (tester) async {
      final api = _Api();
      final shell = ShellController(drive: 'drive')
        ..lead.start('elsewhere', 'm1');
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData(extensions: const [AppColors.light]),
        home: ShellScope(
          controller: shell,
          child: ResourceView(api: api, drive: 'drive', subject: 'page'),
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(api.announced.first.session, isNull);
      expect(page.scripts, contains('window.atomicEmbed?.setMeeting(null)'));
      await close(tester);
    });

    testWidgets('the leader\'s page is trailed in the meeting once',
        (tester) async {
      final api = _Api();
      final shell = await open(tester, api);
      expect(api.sent, isEmpty);

      call('meetingStarted', ['m1']);
      await tester.pump();
      expect(api.sent.single, (
        room: 'm1',
        text: 'Viewing [The page](page)',
      ));

      // The page being announced again (the app came back) is not a new visit.
      shell.lead.start('drive', 'm1');
      await tester.pump();
      call('presence', [
        {'typing': 'room'}
      ]);
      await tester.pump();
      expect(api.sent, hasLength(1));
      await close(tester);
    });

    testWidgets('a page nobody leads from is not trailed', (tester) async {
      final api = _Api();
      await open(tester, api);
      await tester.pump(const Duration(seconds: 6));
      expect(api.sent, isEmpty);
      await close(tester);
    });

    testWidgets('a live meeting shows a strip; Join follows and opens it',
        (tester) async {
      final api = _Api(others: [_leader()], listed: {'meeting'});
      final shell = await open(tester, api);
      await tester.pump();
      expect(find.byKey(const Key('live-meeting-banner')), findsOneWidget);
      expect(find.text('Live meeting · Name of lead'), findsOneWidget);
      expect(find.text('Join'), findsOneWidget);

      await tester.tap(find.byKey(const Key('live-meeting-join')));
      await tester.pump();
      expect(shell.follow.agent, 'lead');
      expect(shell.follow.session, 's-lead');
      // The meeting page replaces this one (and so does the leader's after it).
      await tester.pump(const Duration(milliseconds: 500));
      await close(tester);
    });

    testWidgets('no strip for a meeting that is not listed', (tester) async {
      final api = _Api(others: [_leader()], listed: const {});
      await open(tester, api);
      await tester.pump();
      expect(find.byKey(const Key('live-meeting-banner')), findsNothing);
      await close(tester);
    });

    testWidgets('no strip for a meeting we lead', (tester) async {
      final api = _Api(others: [_leader()], listed: {'meeting'});
      final shell = await open(tester, api);
      await tester.pump();
      expect(find.byKey(const Key('live-meeting-banner')), findsOneWidget);
      shell.lead.start('drive', 'mine');
      await tester.pump();
      expect(find.byKey(const Key('live-meeting-banner')), findsNothing);
      await close(tester);
    });
  });

  group('on the home', () {
    testWidgets('the strip reads the drive itself and Join asks the host',
        (tester) async {
      final api = _Api(others: [_leader()], listed: {'meeting'});
      final follow = FollowController();
      LiveMeeting? joined;
      await tester.pumpWidget(MaterialApp(
        theme: ThemeData(extensions: const [AppColors.light]),
        home: Scaffold(
          body: LiveMeetingBanner(
              api: api,
              drive: 'drive',
              lead: MeetingLead(),
              follow: follow,
              onJoin: (live) => joined = live),
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(find.text('Live meeting · Name of lead'), findsOneWidget);
      await tester.tap(find.byKey(const Key('live-meeting-banner')));
      expect(joined?.meeting, 'meeting');
      expect(joined?.leader.sessionId, 's-lead');

      // Following the leader already: the strip offers to open it instead.
      follow.follow('lead');
      await tester.pump();
      expect(find.text('Open'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    });
  });
}
