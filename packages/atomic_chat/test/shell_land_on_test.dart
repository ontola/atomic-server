import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'assistant_screens_test.dart' show FakeApi, app;
import 'resource_view_test.dart' show FakePage;

/// The first run lands on the Welcome document: the shell opens it over the
/// home, and back leaves it for the home.

Widget _shell(FakeApi api, {({String subject, String title})? landOn}) =>
    app(AppShell(
      api: api,
      drive: 'did:ad:welcome-drive',
      warmPool: (_) => null,
      landOn: landOn,
      home: ChatsScreen(drive: 'did:ad:welcome-drive', api: api),
    ));

void main() {
  setUp(() => ResourceView.pageFactory = (send) => FakePage(send));
  tearDown(() => ResourceView.pageFactory = null);

  testWidgets('opens the resource to land on, over the home and notes it',
      (tester) async {
    final api = FakeApi();
    await tester.pumpWidget(_shell(api, landOn: (
      subject: 'did:ad:welcome-doc',
      title: 'Welcome to Atomic',
    )));
    await tester.pumpAndSettle();

    final view = tester.widget<ResourceView>(find.byType(ResourceView));
    expect(view.subject, 'did:ad:welcome-doc');
    expect(view.title, 'Welcome to Atomic');
    expect(view.drive, 'did:ad:welcome-drive');
    expect(api.opened, ['did:ad:welcome-doc']);
    expect(api.openedDrives, ['did:ad:welcome-drive']);

    // The home is under it: back has somewhere to go.
    final shell = tester.widget<ShellScope>(find.byType(ShellScope).first);
    expect(shell.controller.navigatorKey.currentState!.canPop(), isTrue);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('without a landing the home is all there is', (tester) async {
    final api = FakeApi();
    await tester.pumpWidget(_shell(api));
    await tester.pumpAndSettle();

    expect(find.byType(ResourceView), findsNothing);
    expect(api.opened, isEmpty);
  });
}
