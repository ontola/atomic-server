import 'dart:async';
import 'dart:ui';

import 'package:atomic_chat/atomic_chat.dart' show HomeLayout, HomeSection;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Every test runs on a phone (393 x 851, as a Pixel), unless it sets its own
/// size: the test default of 800 x 600 is wide enough for the shell's tablet
/// layout ([ShellLayout.split]), and these tests are about the phone's.
/// The tablet layouts have their own tests (`tablet_layout_test.dart`).
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  setUp(() {
    // The panels start closed in the app; most tests are about their rows,
    // so they start open and without the compact accordion. The panel tests
    // say otherwise. Drives and Notifications start off; the app's own
    // defaults have their test in home_sections_test.
    HomeLayout.fresh = const HomeLayout(
        hidden: {HomeSection.drives, HomeSection.notifications});
    HomeLayout.accordionOverride = false;
    // A layout one test saved does not carry into the next.
    SharedPreferences.setMockInitialValues({});
    final view = TestWidgetsFlutterBinding.ensureInitialized()
        .platformDispatcher
        .views
        .first;
    view.physicalSize = const Size(1080, 2340);
    view.devicePixelRatio = 1080 / 393;
  });
  await testMain();
}
