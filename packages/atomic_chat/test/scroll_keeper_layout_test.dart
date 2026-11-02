import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// A list that corrects its own offset while it lays out, and the "away
/// from the bottom" state that follows it without a scroll event.
void main() {
  testWidgets(
      'a correction made during layout is in the same frame and updates '
      '"away" without a scroll event', (tester) async {
    final window = ChatWindow<int>(
        readPage: (before, size) async => ChatPage.empty<int>(),
        readAfter: null,
        idOf: (i) => '$i');
    var fix = 0.0;
    final keeper = ChatScrollKeeper(window,
        controller: ChatScrollController(correction: (pixels, min, max) {
          final f = fix;
          fix = 0;
          return f;
        }));
    // The newest row (index 0, at the bottom) grows, like a streaming
    // answer.
    var newest = 100.0;
    late StateSetter set;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: StatefulBuilder(builder: (context, setState) {
          set = setState;
          return ListView.builder(
            reverse: true,
            controller: keeper.controller,
            itemCount: 20,
            itemBuilder: (_, i) =>
                SizedBox(height: i == 0 ? newest : 100, child: Text('i$i')),
          );
        }),
      ),
    ));
    expect(keeper.away.value, isFalse);
    final top = tester.getTopLeft(find.text('i5')).dy;
    var scrolls = 0;
    keeper.controller.addListener(() => scrolls++);
    // The newest row grows by 300 and the offset follows in layout.
    fix = 300;
    set(() => newest = 400);
    await tester.pump();
    expect(keeper.controller.position.pixels, 300);
    // The growth would push older rows up by 300; the correction moves them
    // back down by as much, in this very frame, so they stay put.
    expect(tester.getTopLeft(find.text('i5')).dy, top);
    expect(scrolls, 0, reason: 'a layout correction is not a scroll event');
    expect(keeper.away.value, isTrue);
  });
}
