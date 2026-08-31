import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:atomiccanvas_flutter/atomic/session.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const secureStorageChannel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(secureStorageChannel, (call) async => null);
  });

  test('remembers the canvas being drawn, and forgets it when they leave',
      () async {
    expect(await AtomicSession.loadOpenCanvas(), isNull);

    await AtomicSession.saveOpenCanvas('did:ad:canvas-1');
    expect(await AtomicSession.loadOpenCanvas(), 'did:ad:canvas-1');

    await AtomicSession.saveOpenCanvas('did:ad:canvas-2');
    expect(await AtomicSession.loadOpenCanvas(), 'did:ad:canvas-2');

    await AtomicSession.clearOpenCanvas();
    expect(await AtomicSession.loadOpenCanvas(), isNull);
  });

  test('an empty subject is not remembered — a new canvas has no id yet',
      () async {
    await AtomicSession.saveOpenCanvas('');
    expect(await AtomicSession.loadOpenCanvas(), isNull);
  });

  test('signing out forgets the open canvas with the rest of the session',
      () async {
    await AtomicSession.saveOpenCanvas('did:ad:canvas-1');
    await AtomicSession.clear();
    expect(await AtomicSession.loadOpenCanvas(), isNull);
  });
}


  test('remembers the canvas being drawn, and forgets it when they leave',
      () async {
    expect(await AtomicSession.loadOpenCanvas(), isNull);

    await AtomicSession.saveOpenCanvas('did:ad:canvas-1');
    expect(await AtomicSession.loadOpenCanvas(), 'did:ad:canvas-1');

    await AtomicSession.saveOpenCanvas('did:ad:canvas-2');
    expect(await AtomicSession.loadOpenCanvas(), 'did:ad:canvas-2');

    await AtomicSession.clearOpenCanvas();
    expect(await AtomicSession.loadOpenCanvas(), isNull);
  });

  test('an empty subject is not remembered — a new canvas has no id yet',
      () async {
    await AtomicSession.saveOpenCanvas('');
    expect(await AtomicSession.loadOpenCanvas(), isNull);
  });

  test('signing out forgets the open canvas with the rest of the session',
      () async {
    await AtomicSession.saveOpenCanvas('did:ad:canvas-1');
    await AtomicSession.clear();
    expect(await AtomicSession.loadOpenCanvas(), isNull);
  });
}
