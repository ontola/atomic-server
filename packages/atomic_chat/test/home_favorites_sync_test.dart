import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'assistant_screens_test.dart' show FakeApi, app;

class _SyncApi extends FakeApi {
  final changes = ChangeNotifier();
  List<RecentResource> favs = [];

  @override
  Listenable? get storeChanges => changes;

  @override
  Future<List<RecentResource>> favorites() async => favs;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('a favorite synced in from another device shows on the home',
      (tester) async {
    final api = _SyncApi();
    await tester.pumpWidget(app(ChatsScreen(drive: 'did:ad:drive', api: api)));
    await tester.pumpAndSettle();
    expect(find.text('Made on the Mac'), findsNothing);

    api.favs = [
      (
        subject: 'did:ad:mac',
        title: 'Made on the Mac',
        className: 'Document',
        classUrl: '',
        openedAt: 0,
        emoji: null,
        picture: null
      ),
    ];
    // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    api.changes.notifyListeners();
    await tester.pumpAndSettle();
    expect(find.text('Made on the Mac'), findsOneWidget);
  });
}
