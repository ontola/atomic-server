import 'package:atomic_store/testing.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_flutter/atomic_flutter.dart' as ui;
import 'package:atomic_store_flutter/atomic_store_flutter.dart';
import 'package:atomic_store_flutter/testing.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const drive = 'did:ad:test:home';
final provider = Uri.parse('https://accounts.example');
const session = '{"origin":"https://accounts.example","token":"t"}';

Future<FakeNode> openPanel(WidgetTester tester,
    {Uri? accountProvider,
    String? label,
    ui.AtomicAccountSessionStore? store}) async {
  tester.binding.defaultBinaryMessenger
      .setMockMethodCallHandler(SystemChannels.platform, (call) async => null);
  addTearDown(() => tester.binding.defaultBinaryMessenger
      .setMockMethodCallHandler(SystemChannels.platform, null));
  await tester.binding.setSurfaceSize(const Size(600, 2400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final node = FakeNode(Store(backend: InMemoryBackend(), drive: drive));
  await tester.runAsync(() => node.identity.create('Alice'));
  await tester.pumpWidget(MaterialApp(
      home: Scaffold(
          appBar: AppBar(actions: [
    AtomicAccountButton(
        node: node,
        accountProvider: accountProvider,
        accountProviderLabel: label,
        accountSession: store)
  ]))));
  await tester.tap(find.byType(AtomicAccountButton));
  await tester
      .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  await tester.pumpAndSettle();
  return node;
}

void main() {
  testWidgets('without a provider there is no account sign-in', (tester) async {
    await openPanel(tester);
    expect(find.text('Sign in with a secret key'), findsOneWidget);
    expect(find.textContaining('accounts.example'), findsNothing);
    expect(find.byKey(const ValueKey('user-signin-account')), findsNothing);
    expect(
        AtomicNodeSettings(FakeNode(Store(backend: InMemoryBackend())))
            .signInWithAccount,
        isNull);
  });

  testWidgets('with a provider the row is named after its host',
      (tester) async {
    await openPanel(tester,
        accountProvider: provider, store: ui.MemoryAccountSessionStore());
    expect(find.text('Sign in with accounts.example'), findsOneWidget);
    expect(find.text('Sign in with a secret key'), findsOneWidget);
  });

  testWidgets('a label names the provider instead of its host', (tester) async {
    await openPanel(tester,
        accountProvider: provider,
        label: 'Acme',
        store: ui.MemoryAccountSessionStore());
    expect(find.text('Sign in with Acme'), findsOneWidget);
    expect(find.textContaining('accounts.example'), findsNothing);
  });

  testWidgets('the linked account is shown, and sign-out unlinks it',
      (tester) async {
    final store = ui.MemoryAccountSessionStore();
    await store.save(session);
    await openPanel(tester, accountProvider: provider, store: store);
    expect(find.text('Linked to accounts.example'), findsOneWidget);
    // The provider cannot be reached in a test: its host is what is shown.
    expect(find.text('accounts.example'), findsOneWidget);

    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    expect(await tester.runAsync(store.read), isNull);
  });

  group('SecureAccountSessionStore', () {
    test('keeps the session across instances, and clear removes it', () async {
      FlutterSecureStorage.setMockInitialValues({});
      await SecureAccountSessionStore().save(session);
      expect(await SecureAccountSessionStore().read(), session);
      await SecureAccountSessionStore().clear();
      expect(await SecureAccountSessionStore().read(), isNull);
    });

    test('falls back to this run when the keychain refuses', () async {
      final store = SecureAccountSessionStore(storage: _Broken());
      await store.save(session);
      expect(await store.read(), session);
      await store.clear();
      expect(await store.read(), isNull);
    });
  });
}

class _Broken extends FlutterSecureStorage {
  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) =>
      throw PlatformException(code: 'keychain');
  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) =>
      throw PlatformException(code: 'keychain');
  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) =>
      throw PlatformException(code: 'keychain');
}
