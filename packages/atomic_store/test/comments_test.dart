import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:test/test.dart';

void main() {
  test('mentions are read from and written as the web markup', () {
    final text = 'Zie ${Comment.mention('did:ad:a', 'Ada')} en '
        '[@ id="did:ad:b" label="Bo"], ${Comment.mention('did:ad:a', 'Ada')}';
    expect(Comment.mentionsIn(text), ['did:ad:a', 'did:ad:b']);
    expect(Comment.plain(text), 'Zie @Ada en @Bo, @Ada');
  });

  test('comments per drive, replies, edits and deletes in memory', () async {
    final backend = InMemoryBackend();
    final store = Store(backend: backend);
    final c = store.comments!;
    final team = (await store.createDrive('Fractie')).subject;
    final open = (await store.createDrive('Raad')).subject;
    final doc = await backend.createResource({
      Props.name: const StringValue('Voorstel'),
      Props.parent: LinkValue(open),
    });
    final first = await c.postComment(doc, 'Openbaar');
    await c.postComment(doc, 'Alleen fractie', drive: team, replyTo: first);
    final all = await c.readComments(about: doc);
    expect(all.map((x) => x.text), ['Openbaar', 'Alleen fractie']);
    expect(all.first.drive, open);
    expect(all.first.mine, isTrue);
    expect(all.last.replyTo, first);
    expect((await c.readComments(drive: team)).single.text, 'Alleen fractie');

    await c.editComment(first, 'Aangepast');
    expect((await c.readComments(about: doc)).first.editedAt, isNotNull);
    await c.deleteComment(first);
    expect((await c.readComments(about: doc)).length, 1);
  });

  test('a comment from the bridge JSON', () {
    final c = Comment.fromJson({
      'id': 'p#k',
      'page': 'p',
      'drive': 'd',
      'about': 'x',
      'author': 'a',
      'mine': true,
      'text': 't',
      'c': 1000,
      'reply_to': 'p#j',
      'edited': 2000,
      'mentions': ['m'],
    });
    expect(c.createdAt.millisecondsSinceEpoch, 1000);
    expect(c.editedAt!.millisecondsSinceEpoch, 2000);
    expect(c.replyTo, 'p#j');
    expect(c.mentions, ['m']);
  });

  test('a comment placed on a PDF keeps its spot', () async {
    final backend = InMemoryBackend();
    final c = Store(backend: backend).comments!;
    const spot = PdfSpot(3, 120.25, 300);
    expect(spot.anchor, 'page=3&viewrect=120.3,300.0,0,0');
    final id = await c.postComment('did:ad:doc', 'Hier', anchor: spot.anchor);
    await c.editComment(id, 'Precies hier');
    final read = (await c.readComments(about: 'did:ad:doc')).single;
    expect(PdfSpot.parse(read.anchor), const PdfSpot(3, 120.3, 300));
    expect(PdfSpot.parse('page=2'), const PdfSpot(2, 0, 0));
    expect(PdfSpot.parse('t=10'), isNull);
  });
}
