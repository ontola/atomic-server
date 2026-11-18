import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:test/test.dart';

const drive = 'did:ad:test:drive';
const gremium = 'https://openmeeting.nl/ns/classes/Gremium';
const template = 'https://openmeeting.nl/open?subject={subject}';

class ReadOnlyBackend extends InMemoryBackend {
  ReadOnlyBackend(super.resources);

  @override
  Future<String> createResource(Map<String, Value> props) =>
      Future.error(const StoreException(
          StoreErrorKind.unauthorized, 'No write rights'));

  @override
  Future<void> saveChanges(
          String subject, Map<String, Value> changes, List<String> removed) =>
      Future.error(const StoreException(
          StoreErrorKind.unauthorized, 'No write rights'));
}

Map<String, Map<String, Value>> seed() => {
      drive: {
        Props.isA: const ArrayValue([LinkValue(Classes.drive)]),
        Props.name: const StringValue('Council'),
      },
    };

Future<Resource> register(Store store, {String name = 'OpenMeeting'}) =>
    store.registerApp(
      drive: drive,
      name: name,
      homepage: 'https://openmeeting.nl',
      emoji: '🏛',
      openUrlTemplate: template,
      handlesClasses: [gremium],
    );

void main() {
  test('creates an ExternalApp under the drive', () async {
    final store = Store(backend: InMemoryBackend(seed()));
    final app = await register(store);

    expect(app.isA(Classes.externalApp), isTrue);
    expect(app.parent, drive);
    expect(app.name, 'OpenMeeting');
    expect(app.getString(Props.homepage), 'https://openmeeting.nl');
    expect(app.getString(Props.emoji), '🏛');
    expect(app.getString(Props.openUrlTemplate), template);
    expect(app.getLinks(Props.handlesClasses), [gremium]);
  });

  test('is idempotent: a second call reuses the resource and writes nothing',
      () async {
    final backend = InMemoryBackend(seed());
    final store = Store(backend: backend);
    final first = await register(store);
    backend.calls.clear();
    final second = await register(store);

    expect(second.subject, first.subject);
    expect(await (await store.getResource(drive)).children(), hasLength(1));
    expect(backend.calls.where((c) => c.startsWith('saveChanges')), isEmpty);
    expect(backend.calls.where((c) => c.startsWith('createResource')), isEmpty);
  });

  test('updates the existing registration when the app info changed, '
      'matching the homepage without a trailing slash', () async {
    final store = Store(backend: InMemoryBackend(seed()));
    final first = await register(store);
    final second = await store.registerApp(
      drive: drive,
      name: 'OpenMeeting 2',
      homepage: 'https://openmeeting.nl/',
      handlesClasses: [gremium, 'https://openmeeting.nl/ns/classes/Vergadering'],
    );

    expect(second.subject, first.subject);
    expect(second.name, 'OpenMeeting 2');
    expect(second.get(Props.emoji), isNull);
    expect(second.get(Props.openUrlTemplate), isNull);
    expect(second.getLinks(Props.handlesClasses), hasLength(2));
  });

  test('another app in the same drive gets its own resource', () async {
    final store = Store(backend: InMemoryBackend(seed()));
    final a = await register(store);
    final b = await store.registerApp(
        drive: drive, name: 'Other', homepage: 'https://other.example');

    expect(b.subject, isNot(a.subject));
    expect(await (await store.getResource(drive)).children(), hasLength(2));
  });

  test('without write rights it throws the store exception', () async {
    final store = Store(backend: ReadOnlyBackend(seed()));

    await expectLater(
        register(store),
        throwsA(isA<StoreException>()
            .having((e) => e.kind, 'kind', StoreErrorKind.unauthorized)));
  });
}
