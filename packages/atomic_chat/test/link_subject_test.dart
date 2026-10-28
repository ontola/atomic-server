import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a subject is its own link', () {
    expect(linkSubject('atomic:abc'), 'atomic:abc');
    expect(linkSubject('did:ad:abc'), 'did:ad:abc');
  });

  test("the web app's link to a resource opens that resource", () {
    expect(linkSubject('https://atomic.place/app/show?subject=atomic:abc'),
        'atomic:abc');
    expect(linkSubject('/app/show?subject=did:ad:abc'), 'did:ad:abc');
  });

  test('anything else is not a resource', () {
    expect(linkSubject('#5UDnqor5'), isNull);
    expect(linkSubject('https://example.com/?subject=x'), isNull);
    expect(linkSubject('https://example.com/page'), isNull);
  });
}
