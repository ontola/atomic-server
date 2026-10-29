import 'package:atomic_buildings/src/building_tools.dart';
import 'package:atomic_buildings/src/geometry.dart';
import 'package:atomic_buildings/src/repository.dart';
import 'package:atomic_buildings/src/terms.g.dart';
import 'package:atomic_chat/atomic_chat.dart' show AiTool;
import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:flutter_test/flutter_test.dart';

const square = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
];

void main() {
  late InMemoryBackend backend;
  late BuildingRepository repo;
  late Resource home;
  late BuildingTools tools;

  setUp(() async {
    backend = InMemoryBackend({
      'did:ad:drive': {Props.name: const StringValue('Drive')},
    });
    addTearDown(backend.dispose);
    repo = BuildingRepository(Store(backend: backend, drive: 'did:ad:drive'));
    home = await repo.createHome('Villa');
    tools = BuildingTools(repo, home)..beginTurn('test-model');
  });

  Future<Map<String, Object?>> call(
      String name, Map<String, dynamic> input) async {
    final AiTool tool = tools.tools.firstWhere((t) => t.name == name);
    return (await tool.execute(input))! as Map<String, Object?>;
  }

  Future<List<Resource>> all(String cls) async => [
        for (final r in await home.children())
          if (r.isA(cls)) r
      ];

  test('every tool has a tight object schema', () {
    expect([
      for (final t in tools.tools) t.name
    ], [
      'list_building',
      'add_space',
      'add_wall',
      'add_opening',
      'ask_question',
      'answer_question',
      'record_evidence',
      'connect_rooms',
    ]);
    for (final t in tools.tools) {
      expect(t.parameters['type'], 'object');
      expect(t.parameters['additionalProperties'], false);
    }
  });

  test('add_space and add_wall make proposals of one run per turn', () async {
    final source = await repo.addSource(home, 'Front photo', MediaKind.photo);
    final space = await call('add_space', {
      'name': 'Living',
      'usage': 'living',
      'boundary': square,
      'source': source.subject,
      'confidence': 0.4,
    });
    expect(space['ok'], true);
    expect(space['areaM2'], 12.0);
    expect(space['reviewState'], 'proposed');
    expect(space['warning'], contains('no real scale'));

    final wall = await call('add_wall', {
      'start': [0, 0],
      'end': [4, 0],
      'thickness': 0.2,
    });
    expect(wall['ok'], true);

    // The storey was made because there was none.
    final storeys = await all(BuildingClass.storey);
    expect(storeys, hasLength(1));
    final s = (await all(BuildingClass.space)).single;
    expect(s.getString(Bldg.origin), Origin.ai);
    expect(s.reviewState, Review.proposed);
    expect(s.getLink(Bldg.storey), storeys.single.subject);
    expect(s.boundary, hasLength(4));
    final w = (await all(BuildingClass.element)).single;
    expect(w.getString(Bldg.origin), Origin.ai);
    expect(w.reviewState, Review.proposed);
    expect(w.geometry, isA<WallAxis>());
    expect((w.geometry! as WallAxis).height, 2.6);

    // One run for the turn; the next turn gets its own.
    final runs = await all(BuildingClass.analysisRun);
    expect(runs, hasLength(1));
    expect(s.getLink(Bldg.createdByRun), runs.single.subject);
    expect(w.getLink(Bldg.createdByRun), runs.single.subject);
    expect(runs.single.getString(Bldg.model), 'test-model');
    expect(runs.single.getLinks(Bldg.inputs), isEmpty);

    // The cited source is Evidence on the space.
    final evidence = await repo.evidenceFor(s);
    expect(evidence.single.source.subject, source.subject);

    await tools.endTurn();
    expect(runs.single.getString(Props.description),
        'Proposed in chat: 1 space(s), 1 wall(s).');
    tools.beginTurn('test-model');
    await call('add_wall', {
      'start': [4, 0],
      'end': [4, 3],
    });
    expect(await all(BuildingClass.analysisRun), hasLength(2));
  });

  test('add_opening hosts a door in a wall and checks it fits', () async {
    final wall = await call('add_wall', {
      'start': [0, 0],
      'end': [4, 0],
    });
    final host = wall['subject']! as String;

    final door = await call('add_opening', {
      'wall': host,
      'kind': 'door',
      'offset': 1,
      'width': 0.9,
      'height': 2.1,
    });
    expect(door['ok'], true);
    final d = await backend.getResource(door['subject']! as String);
    expect(d.props[Bldg.hostedBy], LinkValue(host));
    expect(d.props[Bldg.reviewState], const StringValue('proposed'));
    expect(d.props[Bldg.ifcClass], const StringValue('IfcDoor'));

    final tooFar = await call('add_opening', {
      'wall': host,
      'kind': 'door',
      'offset': 3.5,
      'width': 0.9,
      'height': 2.1,
    });
    expect(tooFar['ok'], false);
    expect(tooFar['error'], contains('past the end of the wall'));

    final windowWithoutSill = await call('add_opening', {
      'wall': host,
      'kind': 'window',
      'offset': 2,
      'width': 1,
      'height': 1,
    });
    expect(windowWithoutSill['error'], contains('sill'));
  });

  test('malformed input comes back as an error and changes nothing', () async {
    final before = (await home.children()).length;
    final bad = <(String, Map<String, dynamic>, String)>[
      (
        'add_space',
        {
          'name': 'X',
          'usage': 'living',
          'boundary': [
            [0, 0],
            [1, 1]
          ]
        },
        'boundary'
      ),
      (
        'add_space',
        {'name': 'X', 'usage': 'castle', 'boundary': square},
        'usage'
      ),
      ('add_space', {'usage': 'living', 'boundary': square}, 'name'),
      ('add_space', {'name': 5, 'usage': 'living', 'boundary': square}, 'name'),
      (
        'add_space',
        {
          'name': 'Flat',
          'usage': 'living',
          'boundary': [
            [0, 0],
            [1, 0],
            [2, 0]
          ],
        },
        'no area'
      ),
      (
        'add_space',
        {
          'name': 'Far',
          'usage': 'living',
          'boundary': [
            [0, 0],
            [9999, 0],
            [0, 4]
          ],
        },
        'within'
      ),
      (
        'add_space',
        {
          'name': 'X',
          'usage': 'living',
          'boundary': square,
          'source': 'did:ad:nothing',
        },
        'not a source'
      ),
      (
        'add_wall',
        {
          'start': [0, 0],
          'end': [0, 0]
        },
        'shorter'
      ),
      (
        'add_wall',
        {
          'start': [0],
          'end': [1, 1]
        },
        'start'
      ),
      (
        'add_wall',
        {
          'start': [0, 0],
          'end': [1, 1],
          'thickness': 5
        },
        'thickness'
      ),
      (
        'add_wall',
        {
          'start': [0, 0],
          'end': [1, 1],
          'storey': 'did:ad:x'
        },
        'Unknown storey'
      ),
      (
        'add_opening',
        {'kind': 'door', 'offset': 0, 'width': 1, 'height': 2},
        'wall'
      ),
      (
        'add_opening',
        {
          'wall': 'did:ad:none',
          'kind': 'door',
          'offset': 0,
          'width': 1,
          'height': 2
        },
        'not a wall'
      ),
      ('ask_question', {'text': 'Q?', 'kind': 'bogus', 'why': 'w'}, 'kind'),
      ('ask_question', {'text': 'Q?', 'kind': 'text'}, 'why'),
      ('ask_question', {'text': 'Q?', 'kind': 'choose', 'why': 'w'}, 'options'),
      (
        'ask_question',
        {
          'text': 'Q?',
          'kind': 'text',
          'why': 'w',
          'options': ['a', 'b']
        },
        'options'
      ),
      (
        'answer_question',
        {'question': 'did:ad:none', 'answer': 'x'},
        'not a question'
      ),
      (
        'record_evidence',
        {'source': 'did:ad:none', 'supports': 'did:ad:none'},
        'not a source'
      ),
    ];
    for (final (name, input, mentions) in bad) {
      final result = await call(name, input);
      expect(result['ok'], false, reason: '$name $input');
      expect(result['error'], contains(mentions), reason: '$name $input');
    }
    // Nothing was written (the storey of a failed call is not made either).
    expect((await home.children()).length, before);
  });

  test(
      'ask_question lands in the Questions tab; answering closes it with '
      'evidence', () async {
    final wall = await call('add_wall', {
      'start': [0, 0],
      'end': [4, 0]
    });
    final asked = await call('ask_question', {
      'text': 'How long is the south wall in metres?',
      'kind': 'measure',
      'why': 'To fix the scale of the plan.',
      'about': wall['subject'],
      'wants': 'metres',
    });
    expect(asked['ok'], true);
    final q = await backend.getResource(asked['subject']! as String);
    expect(q.props[Bldg.questionKind], const StringValue('measure'));
    expect(
        q.props[Bldg.why], const StringValue('To fix the scale of the plan.'));
    expect(q.props[Bldg.about], LinkValue(wall['subject']! as String));
    expect((await tools.snapshot())['openQuestions'], hasLength(1));
    expect((await tools.snapshot())['scaleFixed'], false);

    final noNumber = await call('answer_question',
        {'question': asked['subject'], 'answer': 'quite long'});
    expect(noNumber['ok'], false);

    final answered = await call(
        'answer_question', {'question': asked['subject'], 'answer': '4.2 m'});
    expect(answered['ok'], true);
    final closed = await repo.store.getResource(asked['subject']! as String);
    expect(closed.isOpen, false);
    expect(closed.getString(Bldg.answer), '4.2 m');
    // Evidence on the wall, from a note Source that holds the answer.
    final evidence = await repo
        .evidenceFor(await repo.store.getResource(wall['subject']! as String));
    expect(evidence, hasLength(1));
    expect(evidence.single.source.getString(Bldg.mediaKind), MediaKind.note);
    expect((await tools.snapshot())['scaleFixed'], true);

    final again = await call(
        'answer_question', {'question': asked['subject'], 'answer': '5'});
    expect(again['error'], contains('answered already'));
  });

  test('confirm and choose answers are matched to what was asked', () async {
    final confirm = await call('ask_question',
        {'text': 'Is it load-bearing?', 'kind': 'confirm', 'why': 'w'});
    expect(
        (await call('answer_question', {
          'question': confirm['subject'],
          'answer': 'maybe',
        }))['ok'],
        false);
    final yes = await call(
        'answer_question', {'question': confirm['subject'], 'answer': 'yes'});
    expect(yes['answer'], 'Yes');

    final choose = await call('ask_question', {
      'text': 'What is this room?',
      'kind': 'choose',
      'why': 'w',
      'options': ['Kitchen', 'Bathroom'],
    });
    expect(
        (await call('answer_question', {
          'question': choose['subject'],
          'answer': 'attic',
        }))['error'],
        contains('Kitchen, Bathroom'));
    final picked = await call('answer_question',
        {'question': choose['subject'], 'answer': 'kitchen'});
    expect(picked['answer'], 'Kitchen');
  });

  test('record_evidence ties a source to a proposal; list_building shows it',
      () async {
    final source = await repo.addSource(home, 'Plan', MediaKind.floorplan);
    final wall = await call('add_wall', {
      'start': [0, 0],
      'end': [4, 0]
    });
    final recorded = await call('record_evidence', {
      'source': source.subject,
      'supports': wall['subject'],
      'locator': 'page 1, bottom wall',
    });
    expect(recorded['ok'], true);
    final item = await repo.store.getResource(wall['subject']! as String);
    expect(
        (await repo.evidenceFor(item)).single.source.subject, source.subject);

    final listed = await call('list_building', {});
    expect(listed['ok'], true);
    expect((listed['counts']! as Map)['elements'], 1);
    expect((listed['elements']! as List).single['reviewState'], 'proposed');
    expect((listed['sources']! as List).single['subject'], source.subject);
    expect(await tools.context(), contains(buildingPrompt));
  });
}
