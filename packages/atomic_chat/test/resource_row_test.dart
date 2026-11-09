import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:font_awesome_flutter/font_awesome_flutter.dart';

Widget _host(Widget child) => MaterialApp(
      theme: ThemeData(extensions: const [AppColors.light]),
      home: Scaffold(body: child),
    );

void main() {
  testWidgets('shows the emoji instead of the icon when given', (tester) async {
    await tester.pumpWidget(_host(const ResourceRow(
      icon: Icons.table_chart_outlined,
      emoji: '🦊',
      title: 'Fox',
    )));
    expect(find.text('🦊'), findsOneWidget);
    expect(find.byIcon(Icons.table_chart_outlined), findsNothing);
  });

  testWidgets('shows the class icon without an emoji', (tester) async {
    for (final emoji in [null, '']) {
      await tester.pumpWidget(_host(ResourceRow(
        icon: Icons.table_chart_outlined,
        emoji: emoji,
        title: 'Plain',
      )));
      expect(find.byIcon(Icons.table_chart_outlined), findsOneWidget);
    }
  });

  test('class names map to the web app\'s icons, an unknown one to the atom',
      () {
    const expected = {
      'Folder': FontAwesomeIcons.solidFolder,
      'Drive': driveIcon,
      'Table': FontAwesomeIcons.table,
      'Canvas': FontAwesomeIcons.paintbrush,
      'AI chat': Icons.auto_awesome,
      'ai-chat': Icons.auto_awesome,
      'Conversation': FontAwesomeIcons.solidComment,
      'ChatRoom': FontAwesomeIcons.solidComment,
      'meeting': FontAwesomeIcons.video,
      'Class': FontAwesomeIcons.cube,
      'property': FontAwesomeIcons.hashtag,
      'Document': FontAwesomeIcons.solidFileLines,
      'document-v2': FontAwesomeIcons.solidFileLines,
      '': FontAwesomeIcons.solidFileLines,
      'row': FontAwesomeIcons.atom,
      'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/class/ai-chat':
          Icons.auto_awesome,
    };
    for (final e in expected.entries) {
      expect(iconForClass(e.key), e.value, reason: e.key);
    }
  });

  test('classLabel gives class shortnames and URLs a human label', () {
    expect(classLabel('document-v2'), 'Document');
    expect(classLabel('https://atomicdata.dev/classes/DocumentV2'), 'Document');
    expect(classLabel('table'), 'Table');
    expect(classLabel('Folder'), 'Folder');
    expect(classLabel('drive'), 'Drive');
    expect(classLabel('chatroom'), 'Chat');
    expect(classLabel('meeting'), 'Meeting');
    expect(classLabel('ai-chat'), 'AI chat');
    expect(classLabel('chatlog'), 'AI chat');
    expect(classLabel('canvas'), 'Canvas');
    expect(classLabel('web-page-v3'), 'Web page');
    expect(classLabel('some_thing'), 'Some thing');
    expect(classLabel(''), '');
  });
}
