import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'assistant_screens_test.dart' show FakeApi, app;

class _SignUpApi extends FakeApi {
  _SignUpApi({this.canSignUp = true, super.messageList});
  final bool canSignUp;
  final sent = <String>[];
  Object? failWith;
  bool connects = false;
  int connected = 0;
  HostedAi? account;
  int lookups = 0;

  @override
  bool get canSignUpForAi => canSignUp;

  @override
  bool get canConnectAccount => connects;

  @override
  Future<void> connectAccount(BuildContext context) async {
    final failure = failWith;
    if (failure != null) throw failure;
    connected++;
    account = _ai;
  }

  @override
  Future<void> signUpForAi(String email) async {
    final failure = failWith;
    if (failure != null) throw failure;
    sent.add(email);
  }

  @override
  Future<HostedAi?> hostedAi() async {
    lookups++;
    return account;
  }
}

final _ai = HostedAi(
  status: {'enabled': true, 'consent': true, 'model': 'm'},
  stream: (messages, model) => Stream.fromIterable(['Hi']),
  enable: () async => {},
);

void main() {
  testWidgets('no button on a host that cannot sign up', (tester) async {
    await tester.pumpWidget(app(ChatScreen(api: _SignUpApi(canSignUp: false))));
    await tester.pumpAndSettle();
    expect(find.text('AI chat needs an atomic.place account'), findsOneWidget);
    expect(find.byKey(const Key('sign-up-open')), findsNothing);
  });

  testWidgets('an existing chat offers the account below its messages',
      (tester) async {
    final api = _SignUpApi(messageList: [
      (id: 'p#1', role: 'user', text: 'Where to?', createdAt: 1),
    ]);
    await tester.pumpWidget(
        app(ChatScreen(api: api, subject: 'did:ad:chat', title: 'Trip')));
    await tester.pumpAndSettle();
    expect(find.text('Where to?'), findsOneWidget);
    expect(find.textContaining('AI chat needs an atomic.place account'),
        findsOneWidget);
    expect(find.byKey(const Key('sign-up-open')), findsOneWidget);
  });

  testWidgets('button, email, wait, then the chat appears', (tester) async {
    final api = _SignUpApi();
    await tester.pumpWidget(app(ChatScreen(api: api)));
    await tester.pumpAndSettle();

    expect(find.text('Create an atomic.place account'), findsOneWidget);
    await tester.tap(find.byKey(const Key('sign-up-open')));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const Key('sign-up-email')), ' me@example.com ');
    await tester.tap(find.byKey(const Key('sign-up-send')));
    await tester.pumpAndSettle();

    expect(api.sent, ['me@example.com']);
    expect(find.textContaining('Check your email and open the link.'),
        findsOneWidget);
    expect(find.textContaining('Your drives and documents stay as they are.'),
        findsOneWidget);

    // Still no account: polling keeps the notice.
    final before = api.lookups;
    await tester.pump(const Duration(seconds: 4));
    expect(api.lookups, greaterThan(before));
    expect(find.byKey(const Key('sign-up-sent')), findsOneWidget);

    // The link was opened: the next look-up finds the AI.
    api.account = _ai;
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sign-up-sent')), findsNothing);
    expect(find.text('AI chat needs an atomic.place account'), findsNothing);
    expect(find.text('Message'), findsOneWidget);
  });

  testWidgets('looks again when the app resumes', (tester) async {
    final api = _SignUpApi();
    await tester.pumpWidget(app(ChatScreen(api: api)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('sign-up-open')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('sign-up-email')), 'a@b.c');
    await tester.tap(find.byKey(const Key('sign-up-send')));
    await tester.pumpAndSettle();

    api.account = _ai;
    final before = api.lookups;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(api.lookups, greaterThan(before));
    expect(find.text('Message'), findsOneWidget);
  });

  testWidgets('a refusal shows inline and the email stays editable',
      (tester) async {
    final api = _SignUpApi()..failWith = StateError('Enter a valid email.');
    await tester.pumpWidget(app(ChatScreen(api: api)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('sign-up-open')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('sign-up-email')), 'nope');
    await tester.tap(find.byKey(const Key('sign-up-send')));
    await tester.pumpAndSettle();
    expect(find.text('Enter a valid email.'), findsOneWidget);
    expect(find.byKey(const Key('sign-up-email')), findsOneWidget);
    expect(find.byKey(const Key('sign-up-sent')), findsNothing);
  });

  testWidgets('Resend mails again, Change email goes back', (tester) async {
    final api = _SignUpApi();
    await tester.pumpWidget(app(ChatScreen(api: api)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('sign-up-open')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('sign-up-email')), 'a@b.c');
    await tester.tap(find.byKey(const Key('sign-up-send')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('sign-up-resend')));
    await tester.pumpAndSettle();
    expect(api.sent, ['a@b.c', 'a@b.c']);
    await tester.tap(find.byKey(const Key('sign-up-change')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sign-up-email')), findsOneWidget);
    // Leaves no timer behind.
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a host that connects the account replaces the email field',
      (tester) async {
    final api = _SignUpApi()..connects = true;
    await tester.pumpWidget(app(ChatScreen(api: api)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sign-up-open')), findsNothing);

    await tester.tap(find.byKey(const Key('connect-account')));
    await tester.pumpAndSettle();
    expect(api.connected, 1);
    expect(find.text('AI chat needs an atomic.place account'), findsNothing);
  });
}
