import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:test/test.dart';

const home = 'did:ad:test:home';
const council = 'did:ad:test:council';

InMemoryBackend backend() => InMemoryBackend({
      home: {
        Props.isA: const ArrayValue([LinkValue(Classes.drive)]),
        Props.name: const StringValue('Mine'),
      },
      council: {
        Props.isA: const ArrayValue([LinkValue(Classes.drive)]),
        Props.name: const StringValue('Raad'),
      },
    });

void main() {
  test('open makes one Inbox and links it from the drive', () async {
    final store = Store(backend: backend());
    final a = await Inbox.open(store, home);
    final b = await Inbox.open(store, home);
    expect(b.subject, a.subject);
    expect((await store.getResource(home)).getLink(NotifyNs.inbox), a.subject);
  });

  test('follow, refollow and unfollow', () async {
    final store = Store(backend: backend());
    final inbox = await Inbox.open(store, home);
    await inbox.follow(council, FollowLevel.newItems,
        classes: ['https://example.test/Meeting']);
    var f = (await inbox.follows()).single;
    expect(f.about, council);
    expect(f.level, FollowLevel.newItems);
    expect(f.classes, ['https://example.test/Meeting']);

    await inbox.follow(council, FollowLevel.everything);
    f = (await inbox.follows()).single;
    expect(f.level, FollowLevel.everything);
    expect(f.classes, isEmpty);

    await inbox.unfollow(council);
    expect(await inbox.follows(), isEmpty);
  });

  test('settings and push registrations live on the Inbox', () async {
    final store = Store(backend: backend());
    final inbox = await Inbox.open(store, home);
    await inbox.setEmail(' anna@example.test ', EmailFrequency.daily);
    await inbox.setMutedKinds(['changed']);
    await inbox.setLanguage('nl');
    expect(inbox.email, 'anna@example.test');
    expect(inbox.emailFrequency, EmailFrequency.daily);
    expect(inbox.mutedKinds, ['changed']);
    expect(inbox.language, 'nl');

    await inbox.registerPush('https://push.example.test/a', device: 'Tablet');
    await inbox.registerPush('https://push.example.test/a', device: 'Tablet');
    expect(await inbox.pushEndpoints(), ['https://push.example.test/a']);
    await inbox.unregisterPush('https://push.example.test/a');
    expect(await inbox.pushEndpoints(), isEmpty);
  });

  test('announce writes an Announcement with its recipients', () async {
    final store = Store(backend: backend());
    final s = await announce(store,
        parent: council,
        title: 'Nieuwe begroting',
        recipients: ['did:ad:agent:a', 'did:ad:agent:b'],
        about: 'did:ad:test:doc',
        body: 'Graag lezen',
        actionRequired: true);
    final r = await store.getResource(s);
    expect(r.isA(NotifyNs.announcement), isTrue);
    expect(r.getLinks(NotifyNs.recipients), hasLength(2));
    expect(r.getLink(NotifyNs.about), 'did:ad:test:doc');
    expect(r.get(NotifyNs.actionRequired), const BooleanValue(true));
  });

  test('items are newest first and can be marked read', () async {
    final store = Store(backend: backend());
    final inbox = await Inbox.open(store, home);
    for (final (name, at) in [('Oud', 1000), ('Nieuw', 9000)]) {
      await store.newResource(parent: inbox.subject, isA: [
        NotifyNs.notification
      ], props: {
        Props.name: name,
        NotifyNs.occurredAt: TimestampValue(at),
        NotifyNs.notificationKind: const StringValue('created'),
        NotifyNs.notificationCount: const IntegerValue(3),
      }).save();
    }
    final items = await inbox.items();
    expect(items.map((i) => i.title), ['Nieuw', 'Oud']);
    expect(items.first.count, 3);
    expect(items.first.read, isFalse);
    await inbox.markRead(items.first.subject);
    expect((await inbox.items()).first.read, isTrue);
  });
}
