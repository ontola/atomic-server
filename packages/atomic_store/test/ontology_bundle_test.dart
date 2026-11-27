import 'dart:convert';

import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:test/test.dart';

const ontology = 'https://atomicdata.dev/shop/v1';
final bundle = jsonEncode([
  {
    '@id': ontology,
    Props.isA: ['https://atomicdata.dev/class/ontology'],
    Props.shortname: 'shop',
  },
  {
    '@id': '$ontology/class/order',
    Props.isA: ['https://atomicdata.dev/classes/Class'],
    Props.parent: ontology,
    Props.shortname: 'order',
  },
]);

void main() {
  test('stores the bundle under its subjects, then reports it unchanged',
      () async {
    final backend = InMemoryBackend();
    final store = Store(backend: backend);

    final first = await store.installOntology(bundle);
    expect(first.created, [ontology, '$ontology/class/order']);
    expect(backend.resources['$ontology/class/order']?[Props.shortname],
        const StringValue('order'));

    final second = await store.installOntology(bundle);
    expect(second.created, isEmpty);
    expect(second.unchanged, hasLength(2));
  });
}
