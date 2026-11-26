import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store_flutter/atomic_store_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('MemoryAgentSecrets keeps, forgets and archives', () async {
    final s = MemoryAgentSecrets();
    expect(await s.read('k'), isNull);
    await s.write('k', 'one');
    expect(await s.read('k'), 'one');
    await s.archive('k', 'old1');
    await s.archive('k', 'old2');
    expect(s.values['k.old'], 'old1\nold2');
    await s.delete('k');
    expect(await s.read('k'), isNull);
  });

  test('secret key depends on the path only without a keychain group', () {
    expect(AtomicFlutter.agentSecretKey('/a'), 'atomic_agent:/a');
    expect(AtomicFlutter.agentSecretKey('/a', keychainGroup: 'g'),
        AtomicFlutter.agentSecretKey('/b', keychainGroup: 'g'));
    expect(AtomicFlutter.agentSecretKey('/a', keychainGroup: 'g'),
        isNot(AtomicFlutter.agentSecretKey('/a')));
  });

  test('keychainGroup together with a custom secretStore is refused', () {
    expect(
        () => AtomicFlutter.open(
            path: '/x',
            secretStore: MemoryAgentSecrets(),
            keychainGroup: 'g'),
        throwsArgumentError);
  });

  test('the database key is per path, also with a keychain group', () {
    expect(AtomicFlutter.storeKeyName('/a'), 'atomic_store_key:/a');
    expect(AtomicFlutter.storeKeyName('/a'),
        isNot(AtomicFlutter.storeKeyName('/b')));
    expect(AtomicFlutter.storeKeyName('/a'),
        isNot(AtomicFlutter.agentSecretKey('/a')));
  });

  test('a new database key is 32 random bytes as hex and round-trips', () {
    final a = AtomicFlutter.newStoreKey();
    final b = AtomicFlutter.newStoreKey();
    expect(a, matches(RegExp(r'^[0-9a-f]{64}$')));
    expect(a, isNot(b));
    final bytes = AtomicFlutter.storeKeyBytes(a);
    expect(bytes.length, 32);
    expect(bytes.map((x) => x.toRadixString(16).padLeft(2, '0')).join(), a);
  });

  test('a saved database key that is not 32 bytes of hex is refused', () {
    expect(() => AtomicFlutter.storeKeyBytes('abc'),
        throwsA(isA<StoreException>()));
    expect(() => AtomicFlutter.storeKeyBytes('zz' * 32),
        throwsA(isA<StoreException>()));
  });
}
