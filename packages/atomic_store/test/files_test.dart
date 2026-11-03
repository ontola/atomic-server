import 'dart:typed_data';

import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:test/test.dart';

void main() {
  test('an uploaded file is a File under its parent with its bytes', () async {
    final backend = InMemoryBackend();
    final store = Store(backend: backend);
    final drive = (await store.createDrive('Raad')).subject;
    final bytes = Uint8List.fromList([37, 80, 68, 70]);
    final file = await store.files!
        .uploadFile(drive, 'voorstel.pdf', 'application/pdf', bytes);
    final r = await store.getResource(file);
    expect(r.getLink(Props.parent), drive);
    expect(r.getString(Props.filename), 'voorstel.pdf');
    expect(await store.files!.readFile(file), bytes);
  });
}
