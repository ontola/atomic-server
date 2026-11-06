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
