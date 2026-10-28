import 'package:atomic_chat/atomic_chat.dart';
import 'package:atomic_flutter/atomic_flutter.dart' show AtomicAiModel;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'unimplemented_api.dart';

Map<String, dynamic> _text(String t) => {
      'choices': [
        {
          'delta': {'content': t}
        }
      ]
    };

/// The chunk that ends a stream: no choices, only what the request used.
Map<String, dynamic> _usage(int input, int output, [num? cost]) => {
      'choices': <Object>[],
      'usage': {
        'prompt_tokens': input,
        'completion_tokens': output,
        if (cost != null) 'cost': cost,
      },
    };

const _models = [
  {'id': 'a/small', 'label': 'Small', 'max_prompt': 0.5, 'max_completion': 3},
  {'id': 'b/big', 'label': 'Big', 'max_prompt': 10, 'max_completion': 30},
];

class _Api extends UnimplementedApi {
  _Api(this.ai);
  final HostedAi ai;
  final saved = <String>[];

  @override
  Future<HostedAi?> hostedAi() async => ai;
  @override
  Future<List<ChatMessage>> messages(String chat) async => const [];
  @override
  Future<List<ChatEntry>> chatEntries(String chat) async => const [];
  @override
  Future<String> newChat(String name) async => 'did:ad:chat';
  @override
  Future<void> addMessage(String chat, String role, String text) async {}
  @override
  Future<void> addEntry(String chat, String role, List<ChatPart> parts) async =>
      saved.add(role);
  @override
  Future<void> renameResource(String subject, String name) async {}
}

class _SwitchApi extends _Api {
  _SwitchApi(super.ai);
  bool own = false;

  @override
  bool get canSwitchAiSource => true;
  @override
  Future<bool> usesOwnAi() async => own;
  @override
  Future<void> setUsesOwnAi(BuildContext context, bool value) async =>
      own = value;
}

/// An AI that answers every question with [chunks]; [asked] gets the model
/// and chat of each request.
HostedAi _ai(
  List<({String model, String? chat})> asked,
  List<Map<String, dynamic>> chunks, {
  Map<String, dynamic> status = const {},
  Future<List<AtomicAiModel>?> Function()? loadModels,
}) =>
    HostedAi(
      loadModels: loadModels,
      status: {
        'enabled': true,
        'consent': true,
        'model': 'a/small',
        ...status,
      },
      chatCompletions: (messages, model, tools, chat) {
        if ((messages.first['content'] as String).contains('titles')) {
          return Stream.value(_text('Title'));
        }
        asked.add((model: model, chat: chat));
        return Stream.fromIterable(chunks);
      },
      enable: () async => {},
    );

Future<void> _open(WidgetTester tester, _Api api, {String? subject}) async {
  await tester.pumpWidget(MaterialApp(
    theme: ThemeData(extensions: [AppColors.light]),
    home: ChatScreen(api: api, subject: subject, title: 'Chat'),
  ));
  await tester.pumpAndSettle();
}

Future<void> _ask(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField), text);
  await tester.pump();
  await tester.tap(find.byTooltip('Send'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('model choice', () {
    test('the status lists the models; the first is the default', () {
      final ai = _ai([], const [], status: {'models': _models});
      expect(ai.models.map((m) => m.id), ['a/small', 'b/big']);
      expect(ai.canChoose, isTrue);
      expect(ai.model, 'a/small');
      expect(ai.modelLabel, 'Small');
    });

    test('without models only the default can be used', () {
      final ai = _ai([], const []);
      expect(ai.models, isEmpty);
      expect(ai.canChoose, isFalse);
      expect(ai.model, 'a/small');
      expect(ai.modelLabel, 'a/small');
    });

    test('a stored choice is used and a choice is stored', () async {
      SharedPreferences.setMockInitialValues({HostedAi.modelKey: 'b/big'});
      final ai = _ai([], const [], status: {'models': _models});
      expect(ai.model, 'a/small');
      await ai.restoreChoice();
      expect(ai.model, 'b/big');
      expect(ai.modelLabel, 'Big');
      await ai.choose('a/small');
      expect(await HostedAi.storedModel(), 'a/small');
      await ai.choose('not/allowed');
      expect(ai.model, 'a/small');
      expect(await HostedAi.storedModel(), 'a/small');
    });

    test(
        'a stored model the account no longer allows falls back to the '
        'default', () async {
      SharedPreferences.setMockInitialValues({HostedAi.modelKey: 'gone/model'});
      final ai = _ai([], const [], status: {'models': _models});
      await ai.restoreChoice();
      expect(ai.model, 'a/small');
    });

    test('a stored choice is ignored when the portal lists no models',
        () async {
      SharedPreferences.setMockInitialValues({HostedAi.modelKey: 'b/big'});
      final ai = _ai([], const []);
      await ai.restoreChoice();
      expect(ai.model, 'a/small');
    });

    testWidgets('the header names the model and the subtitle picks another',
        (tester) async {
      final asked = <({String model, String? chat})>[];
      final ai = _ai(asked, [_text('Hi')], status: {'models': _models});
      await _open(tester, _Api(ai), subject: 'did:ad:chat');
      expect(find.text('Small'), findsOneWidget);
      expect(find.text('AI assistant'), findsNothing);

      await tester.tap(find.byKey(const Key('chat-header-subtitle')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('chat-ai-model')));
      await tester.pumpAndSettle();
      expect(find.text(r'$10 in, $30 out per 1M tokens'), findsOneWidget);
      await tester.tap(find.byKey(const Key('ai-model-b/big')));
      await tester.pumpAndSettle();
      expect(find.text('Big'), findsOneWidget);
      expect(await HostedAi.storedModel(), 'b/big');

      await _ask(tester, 'Hello');
      expect(asked.single.model, 'b/big');
    });

    test('with all_models any id is accepted, also a stored one', () async {
      SharedPreferences.setMockInitialValues({
        HostedAi.modelKey: 'x/other',
        HostedAi.modelLabelKey: 'Other',
      });
      final ai = _ai([], const [], status: {
        'all_models': true,
        'models': [_models.first],
      });
      expect(ai.canChoose, isTrue);
      await ai.restoreChoice();
      expect(ai.model, 'x/other');
      expect(ai.modelLabel, 'Other');
      await ai.choose('y/new', label: 'New');
      expect(ai.model, 'y/new');
      expect(ai.modelLabel, 'New');
      expect(await HostedAi.storedModel(), 'y/new');
      await ai.choose('');
      expect(ai.model, 'y/new');
      await ai.choose('z/noname');
      expect(ai.modelLabel, 'z/noname');
    });

    test('without all_models an id outside the list is refused', () async {
      SharedPreferences.setMockInitialValues({HostedAi.modelKey: 'x/other'});
      final ai = _ai([], const [], status: {'models': _models});
      await ai.restoreChoice();
      expect(ai.model, 'a/small');
      await ai.choose('x/other');
      expect(ai.model, 'a/small');
      expect(await HostedAi.storedModel(), 'x/other');
      final off = _ai([], const [], status: {
        'all_models': false,
        'models': [_models.first],
      });
      expect(off.canChoose, isFalse);
    });

    testWidgets('All models searches the full list and picks from it',
        (tester) async {
      final asked = <({String model, String? chat})>[];
      final ai = _ai(asked, [_text('Hi')],
          status: {
            'all_models': true,
            'models': [_models.first],
          },
          loadModels: () async => const [
                AtomicAiModel(
                    id: 'a/small',
                    label: 'Small',
                    maxPrompt: 0.5,
                    maxCompletion: 3),
                AtomicAiModel(id: 'meta/llama-3', label: 'Llama 3'),
                AtomicAiModel(
                    id: 'zed/model-z',
                    label: 'Zed',
                    maxPrompt: 1,
                    maxCompletion: 2),
              ]);
      await _open(tester, _Api(ai), subject: 'did:ad:chat');
      await tester.tap(find.byKey(const Key('chat-header-subtitle')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('chat-ai-model')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('ai-model-all')));
      await tester.pumpAndSettle();
      expect(find.text('Llama 3'), findsOneWidget);
      expect(find.text('Zed'), findsOneWidget);
      expect(find.textContaining(r'$1 in, $2 out'), findsOneWidget);

      await tester.enterText(
          find.byKey(const Key('ai-model-search')), 'MODEL-z');
      await tester.pumpAndSettle();
      expect(find.text('Zed'), findsOneWidget);
      expect(find.text('Llama 3'), findsNothing);
      await tester.enterText(find.byKey(const Key('ai-model-search')), 'llama');
      await tester.pumpAndSettle();
      expect(find.text('Zed'), findsNothing);

      await tester.tap(find.byKey(const Key('ai-model-meta/llama-3')));
      await tester.pumpAndSettle();
      expect(find.text('Llama 3'), findsOneWidget);
      expect(await HostedAi.storedModel(), 'meta/llama-3');
      await _ask(tester, 'Hello');
      expect(asked.single.model, 'meta/llama-3');
    });

    testWidgets('no All models row without all_models', (tester) async {
      final ai = _ai([], const [], status: {'models': _models});
      await _open(tester, _Api(ai), subject: 'did:ad:chat');
      await tester.tap(find.byKey(const Key('chat-header-subtitle')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('chat-ai-model')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('ai-model-all')), findsNothing);
    });

    testWidgets('without a choice the subtitle stays AI assistant',
        (tester) async {
      await _open(tester, _Api(_ai([], const [])), subject: 'did:ad:chat');
      expect(find.text('AI assistant'), findsOneWidget);
    });
  });

  group('usage', () {
    test('the usage chunk becomes an event, the cost in micros', () async {
      final ai = _ai([], [_text('Hi'), _usage(120, 30, 0.00042)]);
      final events = await ai.run([
        ChatEntry.text((id: 'q', role: 'user', text: 'Hi', createdAt: 1))
      ]).toList();
      final used = events.whereType<AiUsage>().single;
      expect(used.promptTokens, 120);
      expect(used.completionTokens, 30);
      expect(used.costMicros, 420);
      expect(events.whereType<AiTextDelta>().single.text, 'Hi');
    });

    test('a chunk without a cost, or without numbers, says what it can',
        () async {
      expect(AiUsage.fromJson({'prompt_tokens': 5})!.costMicros, isNull);
      expect(AiUsage.fromJson({}), isNull);
    });

    test('the chat is passed to the provider', () async {
      final seen = <String?>[];
      final ai = HostedAi(
        status: {'enabled': true, 'consent': true, 'model': 'm'},
        chatCompletions: (messages, model, tools, chat) {
          seen.add(chat);
          return Stream.value(_text('Hi'));
        },
        enable: () async => {},
      );
      await ai.run(
          [ChatEntry.text((id: 'q', role: 'user', text: 'Hi', createdAt: 1))],
          chat: () => 'did:ad:chat').toList();
      expect(seen, ['did:ad:chat']);
    });

    test('the totals add up per chat and use the web metadata names', () async {
      var total = await ChatUsageStore.add(
          'c', const ChatUsage(inputTokensUsed: 10, outputTokensUsed: 2));
      total = await ChatUsageStore.add(
          'c',
          const ChatUsage(
              inputTokensUsed: 5, outputTokensUsed: 1, costMicros: 300));
      expect(total.toJson(),
          {'inputTokensUsed': 15, 'outputTokensUsed': 3, 'costMicros': 300});
      expect((await ChatUsageStore.load('c')).line,
          'Tokens: 15 in, 3 out · 0.3 credits');
      expect((await ChatUsageStore.load('other')).isEmpty, isTrue);
    });

    test('credits read as whole, fractions or one', () {
      expect(formatCredits(420), '0.42 credits');
      expect(formatCredits(1000), '1 credit');
      expect(formatCredits(12600), '13 credits');
    });

    testWidgets('an answer\'s usage is stored and shown under the chat',
        (tester) async {
      SharedPreferences.setMockInitialValues({ChatUsageStore.showKey: true});
      final asked = <({String model, String? chat})>[];
      final api = _Api(_ai(asked, [_text('Hi'), _usage(120, 30, 0.00042)]));
      await _open(tester, api);
      expect(find.byKey(const Key('chat-usage-line')), findsNothing);

      await _ask(tester, 'Hello');
      expect(
          find.text('Tokens: 120 in, 30 out · 0.42 credits'), findsOneWidget);
      // The first question made the chat; the request carried its subject.
      expect(asked.single.chat, 'did:ad:chat');
      expect((await ChatUsageStore.load('did:ad:chat')).inputTokensUsed, 120);

      await _ask(tester, 'Again');
      expect(
          find.text('Tokens: 240 in, 60 out · 0.84 credits'), findsOneWidget);
      expect(asked.last.chat, 'did:ad:chat');
    });

    testWidgets('the line is off by default; the AI sheet has the total',
        (tester) async {
      final api = _Api(_ai([], [_text('Hi'), _usage(120, 30)]));
      await _open(tester, api);
      await _ask(tester, 'Hello');
      expect(find.byKey(const Key('chat-usage-line')), findsNothing);
      // It was still counted.
      expect((await ChatUsageStore.load('did:ad:chat')).outputTokensUsed, 30);

      await tester.tap(find.byKey(const Key('chat-ai-button')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('chat-ai-sheet')), findsOneWidget);
      expect(find.text('Tokens: 120 in, 30 out'), findsOneWidget);
    });

    testWidgets('the top bar AI button opens the sheet with the switcher',
        (tester) async {
      final api = _SwitchApi(_ai([], const [],
          status: {'models': _models, 'remaining_micros': 12600}));
      await _open(tester, api, subject: 'did:ad:chat');
      await tester.tap(find.byKey(const Key('chat-ai-button')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('chat-ai-included')), findsOneWidget);
      expect(find.byKey(const Key('chat-ai-own')), findsOneWidget);
      expect(
          find.descendant(
              of: find.byKey(const Key('chat-ai-model')),
              matching: find.text('Small')),
          findsOneWidget);
      expect(find.text('13 credits'), findsOneWidget);
      expect(find.text('Nothing used yet'), findsOneWidget);

      await tester.tap(find.byKey(const Key('chat-ai-own')));
      await tester.pumpAndSettle();
      expect(api.own, isTrue);
      expect(find.byKey(const Key('chat-ai-sheet')), findsOneWidget);
    });

    testWidgets('an opened chat shows what it used before', (tester) async {
      await ChatUsageStore.add('did:ad:chat',
          const ChatUsage(inputTokensUsed: 7, outputTokensUsed: 3));
      await _open(tester, _Api(_ai([], const [])), subject: 'did:ad:chat');
      await tester.tap(find.byKey(const Key('chat-ai-button')));
      await tester.pumpAndSettle();
      expect(find.text('Tokens: 7 in, 3 out'), findsOneWidget);
    });
  });
}
