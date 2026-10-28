import 'package:atomic_chat/atomic_chat.dart'
    show AiChatSettings, ChatUsageStore, HostedAi, HostedAvailability;
import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:atomic_app/atomic/own_ai.dart';
import 'package:atomic_app/screens/ai_settings_screen.dart';
import 'package:atomic_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Widget _app(Widget home) => MaterialApp(
      theme: ThemeData(
          brightness: Brightness.dark, extensions: const [AppColors.dark]),
      home: home,
    );

const _models = [
  shared.AtomicAiModel(
      id: 'a/small', label: 'Small', maxPrompt: 0.5, maxCompletion: 3),
  shared.AtomicAiModel(id: 'b/big', label: 'Big'),
];

shared.AtomicAiCredits _credits(
        {List<shared.AtomicAiModel> models = _models,
        bool allModels = false,
        int remaining = 6000}) =>
    shared.AtomicAiCredits(
      enabled: true,
      allowanceMicros: 10000,
      remainingMicros: remaining,
      usedMicros: 4000,
      purchasedMicros: 2000,
      model: 'a/small',
      models: models,
      allModels: allModels,
    );

Widget _screen(
        {shared.AtomicAiCredits? credits,
        Future<shared.AtomicAiCredits?> Function()? load,
        Future<List<shared.AtomicAiModel>?> Function()? loadModels,
        Future<List<shared.AtomicAiModel>?> Function()? loadOwnModels,
        Future<shared.AtomicAiUsage?> Function()? usage,
        Uri? portal,
        OwnKeyUsage? keyUsage,
        AiChatSettings? chat}) =>
    _app(AiSettingsScreen(
      chat: chat,
      voiceAvailability: () async => const HostedAvailability.available(),
      loadCredits: load ?? () async => credits ?? _credits(),
      loadUsage: usage,
      loadModels: loadModels,
      loadOwnModels: loadOwnModels,
      loadPortal: () async => portal,
      loadKeyUsage: () async => keyUsage,
    ));

/// A secure storage that keeps what is written in memory.
void _memoryKeychain() {
  final values = <String, String>{};
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
          const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
          (call) async {
    final key = (call.arguments as Map)['key'] as String?;
    switch (call.method) {
      case 'write':
        values[key!] = (call.arguments as Map)['value'] as String;
        return null;
      case 'delete':
        values.remove(key);
        return null;
      default:
        return values[key];
    }
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    _memoryKeychain();
    // OwnAi also keeps the key in memory, which would carry it to the next
    // test.
    await OwnAi.setApiKey(null);
  });

  // Room for the whole page, so the rows are on screen to tap.
  void tall(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  testWidgets('shows credits, the model row and the token switch',
      (tester) async {
    tall(tester);
    await tester.pumpWidget(_screen(portal: Uri.parse('https://p.example')));
    await tester.pumpAndSettle();
    expect(find.text('Included AI'), findsOneWidget);
    expect(find.textContaining('6 of 10 this month · 4 used · 2 purchased'),
        findsOneWidget);
    expect(find.byKey(const Key('ai-buy-credits')), findsOneWidget);
    expect(find.byKey(const Key('ai-model-row')), findsOneWidget);
    expect(find.text('Small'), findsOneWidget);
    expect(tester.widget<Switch>(find.byKey(const Key('ai-show-usage'))).value,
        isFalse);
  });

  testWidgets('opened from a chat: what it used, and Report this chat',
      (tester) async {
    tall(tester);
    var reported = 0;
    await tester.pumpWidget(_screen(
        chat: AiChatSettings(
            usage: 'Tokens: 7 in, 3 out', onReport: () => reported++)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chat-usage')), findsOneWidget);
    expect(find.text('Tokens: 7 in, 3 out'), findsOneWidget);
    await tester.tap(find.byKey(const Key('chat-report')));
    expect(reported, 1);
  });

  testWidgets('no chat section outside a chat; the voice section is there',
      (tester) async {
    tall(tester);
    await tester.pumpWidget(_screen());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chat-usage')), findsNothing);
    expect(find.byKey(const Key('chat-report')), findsNothing);
    expect(find.byKey(const Key('engine-account')), findsOneWidget);
    expect(find.byKey(const Key('engine-device')), findsOneWidget);
    expect(find.byKey(const Key('voice-language-row')), findsOneWidget);
  });

  testWidgets('Buy credits only with a portal', (tester) async {
    await tester.pumpWidget(_screen());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ai-buy-credits')), findsNothing);
  });

  testWidgets('offline keeps the last known balance', (tester) async {
    var fail = false;
    await tester.pumpWidget(_screen(load: () async {
      if (fail) throw StateError('offline');
      return _credits();
    }));
    await tester.pumpAndSettle();
    fail = true;
    await tester.tap(find.byTooltip('Refresh AI credits'));
    await tester.pumpAndSettle();
    expect(find.textContaining('offline, last known'), findsOneWidget);
  });

  testWidgets('a dash before anything is known', (tester) async {
    await tester.pumpWidget(_screen(load: () async => null));
    await tester.pumpAndSettle();
    expect(find.text('—'), findsOneWidget);
  });

  testWidgets('the model row picks a model and remembers it', (tester) async {
    tall(tester);
    await tester.pumpWidget(_screen());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('ai-model-row')));
    await tester.pumpAndSettle();
    expect(find.text(r'$0.5 in, $3 out per 1M tokens'), findsOneWidget);
    await tester.tap(find.byKey(const Key('ai-model-b/big')));
    await tester.pumpAndSettle();
    expect(find.text('Big'), findsOneWidget);
    expect(await HostedAi.storedModel(), 'b/big');
  });

  testWidgets('a stored model the account dropped shows the default',
      (tester) async {
    SharedPreferences.setMockInitialValues({HostedAi.modelKey: 'gone/x'});
    await tester.pumpWidget(_screen());
    await tester.pumpAndSettle();
    expect(find.text('Small'), findsOneWidget);
  });

  testWidgets('all models: the whole list is reachable and remembered',
      (tester) async {
    tall(tester);
    SharedPreferences.setMockInitialValues({
      HostedAi.modelKey: 'x/other',
      HostedAi.modelLabelKey: 'Other',
    });
    await tester.pumpWidget(_screen(
      credits: _credits(models: [_models.first], allModels: true),
      loadModels: () async => const [
        shared.AtomicAiModel(id: 'x/other', label: 'Other'),
        shared.AtomicAiModel(id: 'y/third', label: 'Third'),
      ],
    ));
    await tester.pumpAndSettle();
    expect(find.text('Other'), findsOneWidget);
    await tester.tap(find.byKey(const Key('ai-model-row')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('ai-model-all')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('ai-model-y/third')));
    await tester.pumpAndSettle();
    expect(find.text('Third'), findsOneWidget);
    expect(await HostedAi.storedModel(), 'y/third');
    expect(await HostedAi.storedModelLabel(), 'Third');
  });

  testWidgets('no model row without a choice', (tester) async {
    await tester.pumpWidget(_screen(credits: _credits(models: const [])));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('ai-model-row')), findsNothing);
    expect(find.text('AI usage'), findsOneWidget);
  });

  testWidgets('the token usage switch is off by default and is stored',
      (tester) async {
    tall(tester);
    await tester.pumpWidget(_screen());
    await tester.pumpAndSettle();
    final toggle = find.byKey(const Key('ai-show-usage'));
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(toggle).value, isTrue);
    expect(await ChatUsageStore.shown(), isTrue);
  });

  testWidgets('the usage row opens the usage page', (tester) async {
    tall(tester);
    await tester.pumpWidget(_screen(
        usage: () async => const shared.AtomicAiUsage(models: [
              shared.AtomicAiUsageTotal(
                  id: 'a/small',
                  requests: 3,
                  costMicros: 2500,
                  promptTokens: 900,
                  completionTokens: 40),
            ], chats: [])));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('ai-usage-row')));
    await tester.pumpAndSettle();
    expect(find.text('4 of 10 credits'), findsOneWidget);
    expect(
        find.text('900 in, 40 out · 2.5 credits · 3 requests'), findsOneWidget);
  });

  testWidgets('shows what the own key has spent', (tester) async {
    tall(tester);
    await tester.pumpWidget(_screen(
        keyUsage: const OwnKeyUsage(used: 4.5, thisMonth: 1.2, left: 8.8)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('ai-mode-own')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('ai-key-field')), 'sk-or-1');
    await tester.tap(find.byKey(const Key('ai-key-save')));
    await tester.pumpAndSettle();
    expect(find.text('Key saved · \$1.20 this month · \$8.80 left'),
        findsOneWidget);
  });

  testWidgets('switching to an own OpenRouter key, and back', (tester) async {
    tall(tester);
    await tester.pumpWidget(_screen(
        loadOwnModels: () async =>
            const [shared.AtomicAiModel(id: 'o/model', label: 'Own model')]));
    await tester.pumpAndSettle();
    // No key yet: choosing it asks for one.
    await tester.tap(find.byKey(const Key('ai-mode-own')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('ai-key-field')), 'sk-or-1');
    await tester.tap(find.byKey(const Key('ai-key-save')));
    await tester.pumpAndSettle();
    expect(await OwnAi.enabled(), isTrue);
    expect(find.text('Key saved'), findsOneWidget);
    // The included AI's credits are not shown for the own provider.
    expect(find.byKey(const Key('ai-credits-row')), findsNothing);
    expect(find.text(OwnAi.defaultModel), findsOneWidget);
    await tester.tap(find.byKey(const Key('ai-mode-included')));
    await tester.pumpAndSettle();
    expect(await OwnAi.enabled(), isFalse);
    expect(find.byKey(const Key('ai-credits-row')), findsOneWidget);
  });

  test('the own provider streams OpenRouter chunks with the key', () async {
    late http.Request seen;
    final client = MockClient.streaming((request, body) async {
      seen = request as http.Request;
      return http.StreamedResponse(
          Stream.value(('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
                  'data: [DONE]\n\n')
              .codeUnits),
          200);
    });
    final chunks = await OwnAi.completions(
            'sk-or-1',
            [
              {'role': 'user', 'content': 'x'}
            ],
            'm/x',
            null,
            client: client)
        .toList();
    expect(chunks.single['choices'], isNotEmpty);
    expect(seen.url.host, 'openrouter.ai');
    expect(seen.headers['Authorization'], 'Bearer sk-or-1');
  });
}
