import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:test/test.dart';

void main() {
  const strokes = 'https://atomicdata.dev/ontology/canvas/property/strokeData';

  test('list edits undo and redo one edit at a time', () async {
    final backend = InMemoryBackend({
      'did:ad:canvas': {strokes: const JsonValue('[]')},
    });
    final store = Store(backend: backend);
    final r = await store.getResource('did:ad:canvas');
    List<Object?> items() => r.getJson(strokes) as List<Object?>;

    await r.editList(strokes, push: [1, 2]);
    await r.editList(strokes, push: [3]);
    await r.editList(strokes, replace: {0: 7}, delete: [1]);
    expect(items(), [7, 3]);

    expect(await r.undo(), isTrue);
    expect(items(), [1, 2, 3]);
    expect(await r.undo(), isTrue);
    expect(items(), [1, 2]);
    expect(await r.redo(), isTrue);
    expect(items(), [1, 2, 3]);

    await r.editList(strokes, delete: [0]);
    expect(await r.redo(), isFalse, reason: 'a new edit clears redo');
    expect(items(), [2, 3]);
    expect(store.lists, isNotNull);
  });

  test('an index out of bounds is refused and changes nothing', () async {
    final backend = InMemoryBackend({
      'did:ad:canvas': {strokes: const JsonValue('[1]')},
    });
    final r = await Store(backend: backend).getResource('did:ad:canvas');
    expect(
        () => r.editList(strokes, delete: [3]), throwsA(isA<StoreException>()));
    expect(await r.undo(), isFalse);
  });
}
