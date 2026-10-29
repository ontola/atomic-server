import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_buildings/src/agent_account.dart';
import 'package:atomic_buildings/src/building_assistant_api.dart';
import 'package:atomic_buildings/src/building_tools.dart';
import 'package:atomic_buildings/src/device_picker.dart';
import 'package:atomic_buildings/src/geometry.dart';
import 'package:atomic_buildings/src/repository.dart';
import 'package:atomic_buildings/src/room_scanner.dart';
import 'package:atomic_buildings/src/roomplan.dart';
import 'package:atomic_buildings/src/terms.g.dart';
import 'package:atomic_buildings/ui/building_chat_page.dart';
import 'package:atomic_buildings/ui/home_page.dart';
import 'package:atomic_chat/atomic_chat.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:ed25519_edwards/ed25519_edwards.dart' as ed;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'chat_helpers.dart';
import 'room_align_test.dart' show Frame, rect, scan;
import 'roomplan_test.dart' show FakeScanner, roomJson;

/// A completion chunk with text.
Map<String, dynamic> text(String t) => {
      'choices': [
        {
          'delta': {'content': t}
        }
      ]
    };

/// A completion chunk with a whole tool call.
Map<String, dynamic> call(String name, Map<String, Object?> args) => {
      'choices': [
        {
          'delta': {
            'tool_calls': [
              {
                'index': 0,
                'id': 'call_$name',
                'type': 'function',
                'function': {'name': name, 'arguments': jsonEncode(args)},
              }
            ]
          }
        }
      ]
    };

/// A scripted account AI: each request gets the next step; [requests] holds
/// what it was sent. A step that throws makes the request fail.
class ScriptedAi {
  ScriptedAi(this.steps, {this.images = true});
  final List<Stream<Map<String, dynamic>> Function()> steps;
  final bool images;
  final requests = <List<Map<String, dynamic>>>[];
  final toolNames = <List<String>>[];

  HostedAi ai() => HostedAi(
        status: {'enabled': true, 'consent': true, 'model': 'scripted'},
        acceptsImages: images,
        completions: (messages, model, tools) {
          // The chat's title request is not one of the answers.
          if ((messages.first['content'] as String).contains('titles')) {
            return Stream.value(text('A title'));
          }
          requests.add([
            for (final m in messages)
              jsonDecode(jsonEncode(m)) as Map<String, dynamic>,
          ]);
          toolNames.add([
            for (final t in tools ?? const []) t['function']['name'] as String,
          ]);
          return steps[requests.length - 1]();
        },
        enable: () async => {},
      );
}

Stream<Map<String, dynamic>> Function() say(String t) =>
    () => Stream.value(text(t));
Stream<Map<String, dynamic>> Function() calls(
        String name, Map<String, Object?> args) =>
    () => Stream.value(call(name, args));

final png = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');

void main() {
  late InMemoryBackend backend;
  late BuildingRepository repo;
  late Resource home;

  setUp(() async {
    backend = InMemoryBackend({
      'did:ad:drive': {Props.name: const StringValue('Drive')},
    });
    addTearDown(backend.dispose);
    repo = BuildingRepository(Store(backend: backend, drive: 'did:ad:drive'));
    home = await repo.createHome('Villa');
  });

  BuildingAssistantApi apiFor(HostedAi? Function() ai) =>
      BuildingAssistantApi(repo, home, BuildingTools(repo, home),
          account: () async => ai());

  group('the chat of a home', () {
    test('is one chat under the Home, opened with a question', () async {
      final api = apiFor(() => null);
      final chat = await api.ensureChat();
      expect(await api.ensureChat(), chat);
      final resource = await repo.store.getResource(chat);
      expect(resource.parent, home.subject);
      expect(resource.isA(aiChatClass), true);
      final entries = await api.chatEntries(chat);
      expect(entries.single.role, 'assistant');
      expect(entries.single.text, chatGreeting);
      expect(entries.single.text, contains('one real measurement'));
      // Found again by another api over the same store.
      expect(await apiFor(() => null).ensureChat(), chat);
    });

    test('messages with tool calls are kept and read back', () async {
      final api = apiFor(() => null);
      final chat = await api.ensureChat();
      await api.addEntry(chat, 'user', const [TextPart('Hello')]);
      await api.addEntry(chat, 'assistant', [
        const TextPart('Looking'),
        const ToolPart(
            toolCallId: 'c1',
            toolName: 'list_building',
            state: ToolState.outputAvailable,
            input: {},
            output: {'ok': true}),
      ]);
      final entries = await api.chatEntries(chat);
      expect(entries.map((e) => e.role), ['assistant', 'user', 'assistant']);
      expect(entries.last.parts.last, isA<ToolPart>());
      expect((await api.messages(chat)).map((m) => m.text),
          [chatGreeting, 'Hello', 'Looking']);
      expect(entries.map((e) => e.id).toSet(), hasLength(3));
    });

    test('the AI is the account\'s, and none without an account', () async {
      expect(await apiFor(() => null).hostedAi(), isNull);
      final ai = await apiFor(ScriptedAi([]).ai).hostedAi();
      expect(ai, isA<BuildingAi>());
      expect(ai!.available, true);
      expect(ai.acceptsImages, true);
    });

    test('what the chat screen does not need says so', () {
      final api = apiFor(() => null);
      expect(() => api.conversations(), throwsUnsupportedError);
      expect(() => api.activity(5), throwsUnsupportedError);
      expect(() => api.webUrl('x'), throwsUnsupportedError);
      expect(api.canConnectAccount, false);
    });
  });

  group('attachments', () {
    test('each becomes a Source of the right kind; no bytes are kept',
        () async {
      final api = apiFor(() => null);
      final chat = await api.ensureChat();
      await api.addEntry(chat, 'user', [
        const TextPart('Here is the front'),
        FilePart.bytes(png, mediaType: 'image/png', filename: 'front.png'),
        FilePart.bytes(Uint8List(2048),
            mediaType: 'application/pdf', filename: 'Floor plan ground.pdf'),
        FilePart.bytes(Uint8List(10),
            mediaType: 'application/pdf', filename: 'energy label.pdf'),
        FilePart.bytes(utf8.encode('rooms: 3'),
            mediaType: 'text/plain', filename: 'notes.txt'),
      ]);
      final sources = [
        for (final r in await home.children())
          if (r.isA(BuildingClass.source)) r,
      ];
      final byName = {for (final s in sources) s.name!: s};
      expect(byName.keys, {
        'front.png',
        'Floor plan ground.pdf',
        'energy label.pdf',
        'notes.txt'
      });
      expect(byName['front.png']!.getString(Bldg.mediaKind), MediaKind.photo);
      expect(byName['Floor plan ground.pdf']!.getString(Bldg.mediaKind),
          MediaKind.floorplan);
      expect(
          byName['energy label.pdf']!.getString(Bldg.mediaKind), MediaKind.pdf);
      expect(byName['notes.txt']!.getString(Bldg.mediaKind), MediaKind.note);
      expect(byName['Floor plan ground.pdf']!.getString(Props.description),
          'application/pdf, 2 KB. The file itself is not stored yet.');
      for (final s in sources) {
        expect(s.parent, home.subject);
        expect(s.getLink(Bldg.sourceFile), isNull);
      }
      // The message points at the Sources and holds no data.
      final stored = (await api.chatEntries(chat)).last.parts;
      expect([
        for (final p in stored.whereType<FilePart>()) p.url
      ], [
        for (final n in [
          'front.png',
          'Floor plan ground.pdf',
          'energy label.pdf',
          'notes.txt'
        ])
          'source:${byName[n]!.subject}'
      ]);
    });

    test('only the person\'s own messages make Sources', () async {
      final api = apiFor(() => null);
      final chat = await api.ensureChat();
      await api.addEntry(chat, 'assistant', [
        FilePart.bytes(png, mediaType: 'image/png', filename: 'x.png'),
      ]);
      expect([
        for (final r in await home.children())
          if (r.isA(BuildingClass.source)) r
      ], isEmpty);
    });

    test('the picker keeps PDFs and guesses media types', () {
      const picker = DeviceAttachmentPicker();
      PickedFile file(String n, String t) =>
          PickedFile(name: n, mediaType: t, bytes: Uint8List(3));
      expect(picker.keeps(file('a.pdf', 'application/pdf')), true);
      expect(picker.keeps(file('a.png', 'image/png')), false);
      expect(attachmentProblem(file('a.pdf', 'application/pdf'), images: true),
          contains("Can't read"));
      expect(
          attachmentProblem(file('a.pdf', 'application/pdf'),
              images: true, picker: picker),
          isNull);
      expect(mediaTypeOf('Plan.PDF'), 'application/pdf');
      expect(mediaTypeOf('IMG_1.HEIC'), 'image/heic');
      expect(mediaTypeOf('x.dwg'), 'application/octet-stream');
      expect(guessMediaKind('grondplan.png', 'image/png'), MediaKind.floorplan);
    });
  });

  group('an answer', () {
    test(
        'runs with the building prompt, state and tools; changes are '
        'proposals of one run', () async {
      final script = ScriptedAi([
        calls('add_wall', {
          'start': [0, 0],
          'end': [4, 0],
          'name': 'South'
        }),
        say('I proposed a south wall; please confirm it.'),
      ]);
      final api = apiFor(script.ai);
      final tools = BuildingTools(repo, home);
      final ai = BuildingAi((await apiFor(script.ai).hostedAi())!, tools);
      final events = await ai.run([
        const ChatEntry(
            id: '1',
            role: 'user',
            createdAt: 0,
            parts: [TextPart('The south wall is 4 m')]),
      ], tools: tools.tools).toList();
      expect(api, isNotNull);

      final system = script.requests.first.where((m) => m['role'] == 'system');
      expect(system.map((m) => m['content']).join('\n'),
          allOf(contains('digitize one house'), contains('scaleFixed')));
      expect(script.toolNames.first, contains('add_wall'));
      expect(events.whereType<AiToolFinished>().single.part.output,
          containsPair('ok', true));
      expect(events.whereType<AiTextDelta>().map((e) => e.text).join(),
          contains('south wall'));

      final wall = [
        for (final r in await home.children())
          if (r.isA(BuildingClass.element)) r,
      ].single;
      expect(wall.reviewState, Review.proposed);
      expect(wall.getString(Bldg.origin), Origin.ai);
      final run =
          (await repo.store.getResource(wall.getLink(Bldg.createdByRun)!));
      expect(run.getString(Bldg.model), 'scripted');
    });

    test(
        'a bad tool call reaches the model as an error and the answer '
        'goes on', () async {
      final script = ScriptedAi([
        calls('add_space', {'name': 'X', 'usage': 'living', 'boundary': []}),
        say('Sorry, let me ask you instead.'),
      ]);
      final tools = BuildingTools(repo, home);
      final ai = BuildingAi((await apiFor(script.ai).hostedAi())!, tools);
      await ai.run([
        const ChatEntry(
            id: '1', role: 'user', createdAt: 0, parts: [TextPart('hi')]),
      ], tools: tools.tools).toList();
      final toolMessage = script.requests[1].last;
      expect(toolMessage['role'], 'tool');
      expect(toolMessage['content'], contains('"ok":false'));
      expect(toolMessage['content'], contains('boundary'));
      expect([
        for (final r in await home.children())
          if (r.isA(BuildingClass.space)) r
      ], isEmpty);
    });

    test(
        'an image the model refuses is said so, the answer is repeated '
        'without it', () async {
      final script = ScriptedAi([
        () => Stream.error(StateError('This model does not accept images')),
        say('Tell me what is in the photo.'),
        say('Thanks.'),
      ]);
      final api = apiFor(script.ai);
      final chat = await api.ensureChat();
      final tools = BuildingTools(repo, home);
      final ai = BuildingAi((await api.hostedAi())!, tools);
      final photo =
          FilePart.bytes(png, mediaType: 'image/png', filename: 'kitchen.png');
      final user = ChatEntry(
          id: 'u1',
          role: 'user',
          createdAt: 0,
          parts: [const TextPart('The kitchen'), photo]);
      await api.addEntry(chat, 'user', user.parts);

      final events = await ai.run([user], tools: tools.tools).toList();
      expect(events.whereType<AiNotice>().single.text,
          BuildingAi.imagesRefusedNotice);
      expect(events.whereType<AiTextDelta>().single.text,
          'Tell me what is in the photo.');
      // First request had the image, the repeat has a note and the Source.
      String body(int i) => jsonEncode(script.requests[i].last);
      expect(body(0), contains('image_url'));
      expect(body(1), isNot(contains('image_url')));
      expect(body(1), contains('You cannot see it'));
      expect(body(1), contains('Stored as sources'));
      // The photo is a Source all the same.
      expect([
        for (final r in await home.children())
          if (r.isA(BuildingClass.source)) r
      ], hasLength(1));

      // From then on images are not sent at all.
      await ai.run([user], tools: tools.tools).toList();
      expect(jsonEncode(script.requests[2].last), isNot(contains('image_url')));
    });

    test('a failure that is not about images is not repeated', () async {
      final script = ScriptedAi([() => Stream.error(StateError('No credits'))]);
      final tools = BuildingTools(repo, home);
      final ai = BuildingAi((await apiFor(script.ai).hostedAi())!, tools);
      await expectLater(
          ai.run([
            const ChatEntry(
                id: '1', role: 'user', createdAt: 0, parts: [TextPart('hi')]),
          ]).toList(),
          throwsStateError);
      expect(script.requests, hasLength(1));
    });
  });

  group('the agent account', () {
    test('signs with the agent key', () {
      final seed = Uint8List.fromList(List.generate(32, (i) => i + 1));
      final secret = base64Url.encode(utf8.encode(jsonEncode({
        'subject': 'did:ad:agent:abc',
        'privateKey': base64Url.encode(seed),
      })));
      final key = AgentKey.fromSecret(secret);
      expect(key.subject, 'did:ad:agent:abc');
      final signature = key.sign('challenge 123');
      final pub = ed.public(ed.newKeyFromSeed(seed));
      final bytes = base64Url.decode(base64Url.normalize(signature));
      expect(bytes, hasLength(64));
      expect(
          ed.verify(
              pub, utf8.encode('challenge 123'), Uint8List.fromList(bytes)),
          true);
    });

    test('no AI when signed out', () async {
      expect(await AgentAccount(() => null).hostedAi(), isNull);
    });
  });

  group('connect_rooms', () {
    late BuildingTools tools;
    late Resource storey, kitchen;
    final a = scan(rect(0, 0, 4, 3), [(0, 1, 0.9)]);
    final bCorners = [
      const Pt(0, -3),
      const Pt(4, -3),
      const Pt(4, 0),
      const Pt(0, 0)
    ];

    setUp(() async {
      tools = BuildingTools(repo, home)..beginTurn('m');
      storey = await repo.createStorey(home, 'Ground');
      await importScannedRoomChecked(repo, storey, a);
      kitchen = [
        for (final r in await home.children())
          if (r.isA(BuildingClass.space)) r
      ].single;
    });

    Future<Map<String, Object?>> connect(Map<String, dynamic> input) async =>
        (await tools.tools
            .firstWhere((t) => t.name == 'connect_rooms')
            .execute(input))! as Map<String, Object?>;

    Future<int> spaces() async => [
          for (final r in await home.children())
            if (r.isA(BuildingClass.space)) r
        ].length;

    test(
        'places a confident room against the existing one and says how '
        'sure it is', () async {
      final b = scan(bCorners, [(2, 3.0, 0.9)], frame: const Frame(1.0, 5, 2));
      final id = tools.holdScan(b, storey, 'no match');
      expect((await tools.snapshot())['pendingScans'], hasLength(1));
      final result =
          await connect({'new_room': id, 'existing_room': kitchen.subject});
      expect(result['ok'], true);
      expect(result['needsDecision'], isNull);
      expect(result['confidence'] as double, greaterThan(0.6));
      expect(result['imported'], greaterThan(0));
      expect(await spaces(), 2);
      expect((await tools.snapshot())['pendingScans'], isEmpty);
    });

    test('with nothing to match it asks, and the person\'s choice imports',
        () async {
      final noDoor = scan(bCorners, const [], frame: const Frame(0.5, 9, 9));
      final id = tools.holdScan(noDoor, storey, 'No door matches');
      final asked =
          await connect({'new_room': id, 'existing_room': kitchen.subject});
      expect(asked['ok'], true);
      expect(asked['needsDecision'], true);
      expect(asked['next'], contains('ask'));
      expect(
          [for (final o in asked['options']! as List) (o as Map)['placement']],
          contains('as_scanned'));
      expect(await spaces(), 1);

      final bad = await connect({
        'new_room': id,
        'existing_room': kitchen.subject,
        'placement': 'alt_7',
      });
      expect(bad['ok'], false);
      final done = await connect({
        'new_room': id,
        'existing_room': kitchen.subject,
        'placement': 'as_scanned',
      });
      expect(done['imported'], greaterThan(0));
      expect(await spaces(), 2);
    });

    test('rejects what it cannot use', () async {
      expect(
          (await connect({
            'new_room': 'scan-9',
            'existing_room': kitchen.subject
          }))['error'],
          contains('no pending scan'));
      final id = tools.holdScan(scan(bCorners, const []), storey, 'x');
      expect(
          (await connect(
              {'new_room': id, 'existing_room': 'did:ad:none'}))['ok'],
          false);
      expect(
          (await connect({
            'new_room': id,
            'existing_room': kitchen.subject,
            'via_door': kitchen.subject
          }))['ok'],
          false);
    });
  });

  group('the chat screen', () {
    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump();
      }
    }

    Future<void> finish(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      backend.dispose();
      await tester.pump();
    }

    Future<void> scanFromComposer(WidgetTester tester) async {
      await tester.tap(find.byKey(const Key('chat-attach')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('attach-extra-Scan room')));
      await settle(tester);
    }

    testWidgets(
        'is the only main screen: the opening question, the menu '
        'with Plan, Sources and Questions, the account action', (tester) async {
      final script = ScriptedAi([say('ok')]);
      await tester.pumpWidget(chatApp(HomePage(repo, home,
          scanner: FakeScanner(null, supported: false),
          actions: const [Icon(Icons.account_circle_outlined)],
          chat: BuildingChat(ai: () async => script.ai()))));
      await settle(tester);
      expect(find.byType(NavigationBar), findsNothing);
      expect(find.textContaining('one real measurement'), findsOneWidget);
      expect(find.byIcon(Icons.account_circle_outlined), findsOneWidget);

      await tester.tap(find.byKey(const Key('chat-attach')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('attach-extra-Scan room')), findsNothing);
      expect(find.byKey(const Key('attach-photos')), findsOneWidget);
      expect(find.byKey(const Key('attach-file')), findsOneWidget);
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Plan, sources and questions'));
      await tester.pumpAndSettle();
      expect(find.text('Plan'), findsOneWidget);
      expect(find.text('Sources'), findsOneWidget);
      await tester.tap(find.text('Sources'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Add note'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.textContaining('one real measurement'), findsOneWidget);
      await finish(tester);
    });

    testWidgets(
        'a message goes to the model with the tools and the answer '
        'is shown', (tester) async {
      final script = ScriptedAi([say('Thanks, I will note that.')]);
      await tester.pumpWidget(chatApp(HomePage(repo, home,
          scanner: FakeScanner(null, supported: false),
          chat: BuildingChat(ai: () async => script.ai()))));
      await settle(tester);
      await tester.enterText(find.byType(TextField).last, 'The door is 90 cm');
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await settle(tester);
      expect(find.text('Thanks, I will note that.'), findsOneWidget);
      expect(script.toolNames.first,
          containsAll(['list_building', 'add_space', 'connect_rooms']));
      expect(jsonEncode(script.requests.first), contains('The door is 90 cm'));
      await finish(tester);
    });

    testWidgets(
        'Scan room in the composer imports the scan and the chat '
        'says what was proposed', (tester) async {
      final script = ScriptedAi([]);
      await tester.pumpWidget(chatApp(HomePage(repo, home,
          scanner: FakeScanner(ScannedRoom.parse(roomJson())),
          chat: BuildingChat(ai: () async => script.ai()))));
      await settle(tester);
      await scanFromComposer(tester);

      final children = await tester.runAsync(() => home.children()) ?? [];
      expect(children.where((r) => r.isA(BuildingClass.space)), hasLength(1));
      expect(children.where((r) => r.getString(Bldg.mediaKind) == 'scan'),
          hasLength(1));
      expect(
          find.textContaining('I imported the scan "Kitchen"'), findsOneWidget);
      expect(find.textContaining('4 walls'), findsOneWidget);
      expect(find.textContaining('about 12.0 m²'), findsOneWidget);
      final question =
          children.firstWhere((r) => r.isA(BuildingClass.question));
      expect(question.name, 'What is the room "Kitchen" used for?');
      expect(question.isOpen, true);
      await finish(tester);
    });

    testWidgets(
        'a scan that cannot be placed waits and the chat asks where '
        'it goes', (tester) async {
      final first = scan(rect(0, 0, 4, 3), [(0, 1, 0.9)]);
      final lost =
          scan(rect(0, 0, 3, 3), const [], frame: const Frame(0.4, 7, 7));
      final scanner = SeqScanner([first, lost]);
      final script = ScriptedAi([]);
      await tester.pumpWidget(chatApp(HomePage(repo, home,
          scanner: scanner, chat: BuildingChat(ai: () async => script.ai()))));
      await settle(tester);
      await scanFromComposer(tester);
      await scanFromComposer(tester);

      final children = await tester.runAsync(() => home.children()) ?? [];
      expect(children.where((r) => r.isA(BuildingClass.space)), hasLength(1));
      expect(find.textContaining('could not place it on the plan'),
          findsOneWidget);
      expect(find.textContaining('Which room does "Scanned room" connect to'),
          findsWidgets);
      expect(
          children.where((r) =>
              r.isA(BuildingClass.question) &&
              r.getString(Bldg.questionKind) == 'text'),
          hasLength(1));
      await finish(tester);
    });
  });
}

class SeqScanner implements RoomScanner {
  SeqScanner(this.rooms);
  final List<ScannedRoom> rooms;
  @override
  Future<bool> isSupported() async => true;
  @override
  Future<ScannedRoom?> scan() async => rooms.removeAt(0);
}
