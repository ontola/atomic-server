import 'dart:async';

import 'package:atomic_app/atomic/store_changes.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('changed and destroyed subjects reach the screens in one batch',
      () async {
    const window = Duration(milliseconds: 10);
    Future<void> settle() => Future<void>.delayed(window * 3);
    final batches = <List<String>>[];
    final changes = StoreChanges(
      poll: () => Completer<Map<String, dynamic>?>().future,
      onChanged: batches.add,
      batchWindow: window,
    )..start();

    changes
      ..add({'kind': 'changed', 'subject': 'did:ad:page1'})
      ..add({'kind': 'changed', 'subject': 'did:ad:page1'})
      ..add({'kind': 'destroyed', 'subject': 'did:ad:gone'})
      ..add({'kind': 'query_membership', 'subject': 'q'})
      ..add({'kind': 'changed', 'subject': ''});
    expect(batches, isEmpty);

    await settle();
    expect(batches, [
      ['did:ad:page1', 'did:ad:gone']
    ]);

    changes.add({'kind': 'changed', 'subject': 'did:ad:page2'});
    await settle();
    expect(batches.last, ['did:ad:page2']);

    changes
      ..stop()
      ..add({'kind': 'changed', 'subject': 'did:ad:late'});
    await settle();
    expect(batches, hasLength(2));
  });

  test('events the store sends are read until stopped', () async {
    final events = StreamController<Map<String, dynamic>?>();
    final queue = StreamIterator(events.stream);
    final got = Completer<List<String>>();
    final changes = StoreChanges(
      poll: () async => await queue.moveNext() ? queue.current : null,
      onChanged: got.complete,
      batchWindow: Duration.zero,
    )..start();

    events.add({'kind': 'changed', 'subject': 'did:ad:chatlog'});
    expect(await got.future, ['did:ad:chatlog']);
    changes.stop();
    await events.close();
  });
}
