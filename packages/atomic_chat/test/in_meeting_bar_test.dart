import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'assistant_screens_test.dart' show app;

void main() {
  testWidgets('the meeting strip shows while following, and stops it',
      (tester) async {
    final lead = MeetingLead();
    final follow = FollowController();
    final opened = <String>[];
    await tester.pumpWidget(app(Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: InMeetingBar(
            call: null, lead: lead, follow: follow, onOpen: opened.add),
      ),
    )));
    expect(find.byKey(const Key('in-meeting-bar')), findsNothing);

    follow.follow('did:ad:agent:ann',
        session: 's1', meeting: 'did:ad:meeting', name: 'Ann');
    await tester.pump();
    expect(find.text('Following Ann'), findsOneWidget);

    await tester.tap(find.byKey(const Key('in-meeting-bar')));
    expect(opened, ['did:ad:meeting']);

    await tester.tap(find.byKey(const Key('in-meeting-stop-following')));
    await tester.pump();
    expect(follow.agent, isNull);
    expect(find.byKey(const Key('in-meeting-bar')), findsNothing);
  });

  test('a meeting counts its leader as there, wherever they are', () {
    const leader = PresenceItem(
        sessionId: 's1',
        agent: 'did:ad:agent:ann',
        resource: 'did:ad:doc',
        session: 'did:ad:meeting',
        updatedAt: 1,
        allowFollow: true);
    expect(viewersOf([leader], 'did:ad:meeting'), isEmpty);
    expect(viewersOf([leader], 'did:ad:meeting', inMeeting: true), [leader]);
  });
}
