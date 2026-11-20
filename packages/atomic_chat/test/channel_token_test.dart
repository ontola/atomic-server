import 'dart:math';

import 'package:atomic_chat/src/warm_resource_web_view.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('accepts only messages that carry the page token', () {
    const t = 'abc123';
    expect(acceptsChannelMessage(t, '{"token":"abc123","method":"x"}'), isTrue);
    expect(acceptsChannelMessage(t, channelReadyMessage(t)), isTrue);
    expect(acceptsChannelMessage(t, '{"method":"x"}'), isFalse);
    expect(acceptsChannelMessage(t, '{"token":"nope","method":"x"}'), isFalse);
    expect(
        acceptsChannelMessage(t, '{"method":"x","token":"abc123"}'), isFalse);
    expect(acceptsChannelMessage(t, 'not json'), isFalse);
    expect(acceptsChannelMessage('', '{"token":"","method":"x"}'), isFalse);
  });

  // The app's own scripts in the page (reveal, paint, flush answers) post
  // through the raw channel, so they have to add the token themselves: run
  // in a page, this script posts `{"token":"abc123","method":"revealed",..}`,
  // which acceptsChannelMessage takes. Without it, every open waited for the
  // 2 s reveal fallback and every leave for the 2 s flush timeout.
  test('scripts the app runs in the page post with the token', () {
    expect(appMessageScript('abc123', '{method:"revealed",ms:1}'),
        'AtomicFlutter.postMessage(JSON.stringify(Object.assign('
        '{token:"abc123"},{method:"revealed",ms:1})))');
    expect(appMessageScript('', '{method:"x"}'),
        'AtomicFlutter.postMessage(JSON.stringify({method:"x"}))');
  });

  test('the token joins the fragment and is random', () {
    expect(withChannelToken(Uri.parse('http://a/b?x=1'), 't').toString(),
        'http://a/b?x=1#ch=t');
    expect(withChannelToken(Uri.parse('http://a/b#k=v'), 't').fragment,
        'k=v&ch=t');
    final a = newChannelToken(Random(1));
    expect(a, hasLength(32));
    expect(newChannelToken(), isNot(newChannelToken()));
  });
}
