import 'dart:convert';
import 'dart:math' as math;

import 'package:atomic_chat/atomic_chat.dart' show AiTool;
import 'package:atomic_store/atomic_store.dart';

import 'geometry.dart';
import 'repository.dart';
import 'room_align.dart';
import 'roomplan.dart';
import 'terms.g.dart';

/// What the model is told before every answer (ahead of the state of the
/// building, see [BuildingTools.context]). Not shown to the person.
const buildingPrompt = '''
You are the assistant inside AtomicBuildings. You help a real estate agent digitize one house into a digital twin: storeys, spaces (rooms), walls, doors and windows on a 2D plan in metres. You collect the data by talking to the person: you ask short questions, and they answer with text, photos, PDFs or floor plans, or a LiDAR room scan.

Rules:
- Ask one thing at a time, in the language the person writes in. Prefer questions they can answer in a few words.
- Before you draw anything, make sure the plan has a real scale: ask for one real measurement (for example the width of the front door or the length of one wall), unless the state below says scaleFixed is true. Everything drawn before that is relative.
- Never state a measurement, area or count that you cannot support from what the person told you, an attached source or a scan. Say that you do not know, and ask.
- Propose, do not assert. What you add with add_space, add_wall and add_opening is a proposal that the person confirms or rejects later. Say that it is a proposal.
- Cite sources: pass the source subject (from the state below or list_building) when a proposal comes from a photo, plan or note; use record_evidence for other support.
- When you need an answer that you will act on, call ask_question (with the reason in why), then ask it in your reply in plain words. When the person's message answers an open question, call answer_question.
- Tool results are JSON. If one has an error, fix the input or tell the person what went wrong. Never pretend a call worked.
- You can only see a photo or read a file when the message shows it. When you cannot, say so and ask the person to describe it or to give measurements.
- A scanned room that could not be placed with confidence is pending (pendingScans in the state). Ask the person which existing room it connects to and through which door, then call connect_rooms. If that returns needsDecision, describe the options in plain words (with their confidence) and ask which placement to take; then call connect_rooms again with that placement. Never choose for them.
- Coordinates are metres per storey: x to the right, y up on the plan. The origin is any corner you choose first and keep.''';

const _usages = [
  'living',
  'kitchen',
  'bedroom',
  'bathroom',
  'hall',
  'storage',
  'technical',
  'outdoor',
  'other',
];
const _questionKinds = ['confirm', 'choose', 'measure', 'upload', 'text'];
const _openingKinds = {
  'door': 'IfcDoor',
  'window': 'IfcWindow',
  'opening': 'IfcBuildingElementProxy',
};
const _maxListed = 150;
const _maxCoord = 500.0;

/// A tool call the model got wrong; [message] goes back to it.
class ToolError implements Exception {
  const ToolError(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Checked reads of a tool call's JSON input; each throws a [ToolError] that
/// names the field.
class ToolInput {
  ToolInput(this.raw);
  final Map<String, dynamic> raw;

  String? optText(String key, {int max = 300}) {
    final v = raw[key];
    if (v == null) return null;
    if (v is! String) throw ToolError('$key must be a string');
    final t = v.trim();
    if (t.isEmpty) return null;
    if (t.length > max) throw ToolError('$key is longer than $max characters');
    return t;
  }

  String text(String key, {int max = 300}) =>
      optText(key, max: max) ?? (throw ToolError('$key is required'));

  double? optNumber(String key, {required double min, required double max}) {
    final v = raw[key];
    if (v == null) return null;
    if (v is! num || !v.isFinite) throw ToolError('$key must be a number');
    if (v < min || v > max) {
      throw ToolError('$key must be between $min and $max');
    }
    return v.toDouble();
  }

  double number(String key, {required double min, required double max}) =>
      optNumber(key, min: min, max: max) ??
      (throw ToolError('$key is required'));

  String oneOf(String key, Iterable<String> allowed) {
    final v = text(key, max: 40).toLowerCase();
    if (!allowed.contains(v)) {
      throw ToolError('$key must be one of: ${allowed.join(', ')}');
    }
    return v;
  }

  Pt point(String key) {
    final v = raw[key];
    if (v is! List || v.length != 2 || !v.every((n) => n is num)) {
      throw ToolError('$key must be [x, y] in metres');
    }
    return _checked(key, v);
  }

  List<Pt> points(String key, {int min = 3, int max = 64}) {
    final v = raw[key];
    if (v is! List || v.length < min || v.length > max) {
      throw ToolError('$key must be a list of $min to $max [x, y] points');
    }
    return [
      for (final p in v)
        if (p is List && p.length == 2 && p.every((n) => n is num))
          _checked(key, p)
        else
          throw ToolError('every point of $key must be [x, y] in metres'),
    ];
  }

  static Pt _checked(String key, List p) {
    final (x, y) = ((p[0] as num).toDouble(), (p[1] as num).toDouble());
    if (!x.isFinite ||
        !y.isFinite ||
        x.abs() > _maxCoord ||
        y.abs() > _maxCoord) {
      throw ToolError('$key must stay within $_maxCoord m of the origin');
    }
    return Pt(x, y);
  }

  List<String> strings(String key, {required int min, required int max}) {
    final v = raw[key];
    if (v == null && min == 0) return const [];
    if (v is! List || v.length < min || v.length > max) {
      throw ToolError('$key must be a list of $min to $max strings');
    }
    return [
      for (final s in v)
        if (s is String && s.trim().isNotEmpty && s.length <= 80)
          s.trim()
        else
          throw ToolError('every item of $key must be a short string'),
    ];
  }
}

double? _num(Resource r, String property) => switch (r.get(property)) {
      FloatValue(:final value) => value,
      IntegerValue(:final value) => value.toDouble(),
      _ => null,
    };

/// A scanned room waiting for the person to say where it goes.
class PendingScan {
  PendingScan(this.id, this.room, this.storey, this.reason);
  final String id;
  final ScannedRoom room;
  final Resource storey;
  final String reason;
}

/// The tools the model calls to build the twin of [home] through [repo], and
/// the text that tells it where things stand. Everything it adds is
/// `origin = ai`, `reviewState = proposed`, and belongs to the
/// [AnalysisRun] of the current chat turn (made at the first change).
class BuildingTools {
  BuildingTools(this.repo, this.home);
  final BuildingRepository repo;
  final Resource home;

  Store get _store => repo.store;

  // ---- scans waiting for a placement ----

  final _pending = <String, PendingScan>{};
  var _scanCount = 0;

  /// Keeps a scanned room that could not be placed; returns its id for
  /// `connect_rooms`.
  String holdScan(ScannedRoom room, Resource storey, String reason) {
    final id = 'scan-${++_scanCount}';
    _pending[id] = PendingScan(id, room, storey, reason);
    return id;
  }

  // ---- one run per chat turn ----

  Resource? _run;
  String _model = '';
  final _turnSources = <Resource>[];
  final _made = <String, int>{};

  /// A chat turn starts: the next change makes a new AnalysisRun.
  void beginTurn(String model) {
    _run = null;
    _model = model;
    _made.clear();
  }

  /// Sources the person sent in this turn; the run lists them as its inputs.
  void noteSources(List<Resource> sources) {
    _turnSources.addAll(sources);
    lastAttachments = List.unmodifiable(sources);
  }

  /// The Sources made for the person's latest message; the model is told their
  /// subjects.
  List<Resource> lastAttachments = const [];

  /// The turn is over: its run says what it proposed. Never throws.
  Future<void> endTurn() async {
    final run = _run;
    if (run == null) return;
    try {
      run.set(
        Props.description,
        'Proposed in chat: ${[
          for (final e in _made.entries) '${e.value} ${e.key}'
        ].join(', ')}.',
      );
      await run.save();
    } on Object {
      // The run stays as it was made; the proposals are all saved.
    }
  }

  Future<Resource> _runFor() async {
    final run = _run ??= await repo.addAnalysisRun(home, 'Chat turn', _model,
        inputs: List.of(_turnSources));
    _turnSources.clear();
    return run;
  }

  void _count(String what) =>
      _made.update(what, (n) => n + 1, ifAbsent: () => 1);

  // ---- reading the home ----

  Future<Resource> _own(String? subject, String cls, String what) async {
    if (subject == null) throw ToolError('$what is required');
    final r = await _store.getResourceOrNull(subject);
    if (r == null || r.parent != home.subject || !r.isA(cls)) {
      throw ToolError('$subject is not a $what of this home; '
          'take its subject from list_building');
    }
    return r;
  }

  bool _scaleFixed(List<Resource> all) => all.any((r) =>
      r.isA(BuildingClass.source) && r.getString(Bldg.mediaKind) == 'scan' ||
      r.isA(BuildingClass.question) &&
          !r.isOpen &&
          r.getString(Bldg.questionKind) == 'measure');

  Map<String, Object?> _item(Resource r) => {
        'subject': r.subject,
        'name': r.name,
        'reviewState': r.reviewState,
        'origin': r.getString(Bldg.origin),
      };

  /// The state of the home as JSON. [detail] adds every space and element;
  /// without it the lists stop at the storeys, sources and open questions.
  Future<Map<String, Object?>> snapshot({bool detail = true}) async {
    final all = await home.children();
    List<Resource> of(String cls) => [
          for (final r in all)
            if (r.isA(cls) && !r.isRejected) r,
        ];
    final storeys = of(BuildingClass.storey);
    final spaces = of(BuildingClass.space);
    final elements = of(BuildingClass.element);
    final sources = of(BuildingClass.source);
    final questions = of(BuildingClass.question);
    final open = [
      for (final q in questions)
        if (q.isOpen) q
    ];
    List<T> cap<T>(List<T> l, int n) => l.length > n ? l.sublist(0, n) : l;
    return {
      'home': {'subject': home.subject, 'name': home.name},
      'scaleFixed': _scaleFixed(all),
      'counts': {
        'storeys': storeys.length,
        'spaces': spaces.length,
        'elements': elements.length,
        'sources': sources.length,
        'openQuestions': open.length,
      },
      'storeys': [
        for (final s in storeys)
          {
            'subject': s.subject,
            'name': s.name,
            'level': _num(s, Bldg.level)?.round(),
            'height': _num(s, Bldg.height),
          },
      ],
      if (detail) ...{
        'spaces': [
          for (final s in cap(spaces, _maxListed))
            {
              ..._item(s),
              'usage': s.getString(Bldg.usage),
              'storey': s.getLink(Bldg.storey),
              'boundary': s.getJson(Bldg.boundary),
            },
        ],
        'elements': [
          for (final e in cap(elements, _maxListed))
            {
              ..._item(e),
              'ifcClass': e.getString(Bldg.ifcClass),
              'storey': e.getLink(Bldg.storey),
              'hostedBy': e.getLink(Bldg.hostedBy),
              'geometryKind': e.getString(Bldg.geometryKind),
              'geometry': e.getJson(Bldg.geometry),
            },
        ],
        'truncated': spaces.length > _maxListed || elements.length > _maxListed,
      },
      'sources': [
        for (final s in cap(sources, 25))
          {
            'subject': s.subject,
            'name': s.name,
            'mediaKind': s.getString(Bldg.mediaKind),
            'note': s.getString(Props.description),
          },
      ],
      'pendingScans': [
        for (final p in _pending.values)
          {'id': p.id, 'name': p.room.name, 'why': p.reason},
      ],
      'openQuestions': [
        for (final q in cap(open, 15))
          {
            'subject': q.subject,
            'text': q.name,
            'kind': q.getString(Bldg.questionKind),
            'why': q.getString(Bldg.why),
            'about': q.getLink(Bldg.about),
          },
      ],
    };
  }

  /// What goes to the model as its second system message: [buildingPrompt]
  /// and where the home stands.
  Future<String> context() async {
    final state = await snapshot(detail: false);
    return '$buildingPrompt\n\nState of the home (list_building has the '
        'spaces and elements):\n${jsonEncode(state)}';
  }

  // ---- the tools ----

  List<AiTool> get tools => [
        _listBuilding,
        _addSpace,
        _addWall,
        _addOpening,
        _askQuestion,
        _answerQuestion,
        _recordEvidence,
        _connectRooms,
      ];

  /// A tool whose [body] may throw a [ToolError] (or any store or geometry
  /// error); the model gets `{ok: false, error}` instead and the chat goes on.
  AiTool _tool(
          String name,
          String description,
          Map<String, Object?> props,
          List<String> required,
          Future<Map<String, Object?>> Function(ToolInput) body) =>
      AiTool(
        name: name,
        description: description,
        parameters: {
          'type': 'object',
          'properties': props,
          if (required.isNotEmpty) 'required': required,
          'additionalProperties': false,
        },
        execute: (input) async {
          try {
            return {'ok': true, ...await body(ToolInput(input))};
          } on ToolError catch (e) {
            return {'ok': false, 'error': e.message};
          } on GeometryException catch (e) {
            return {'ok': false, 'error': e.message};
          } on StoreException catch (e) {
            return {'ok': false, 'error': 'The store refused it: ${e.message}'};
          } on Object catch (e) {
            return {'ok': false, 'error': 'The tool failed: $e'};
          }
        },
      );

  static const _subject = {
    'type': 'string',
    'description': 'A subject taken from list_building.',
  };
  static const _confidence = {
    'type': 'number',
    'minimum': 0,
    'maximum': 1,
    'description': 'How sure you are (default 0.5). Low when guessing.',
  };
  static const _sourceProp = {
    'type': 'string',
    'description': 'Subject of the Source (photo, plan, note, scan) this '
        'proposal comes from; recorded as evidence. Strongly recommended.',
  };

  AiTool get _listBuilding => _tool(
        'list_building',
        'The state of the home: storeys, spaces, elements (walls, doors, '
            'windows) with their review state, sources, open questions, and '
            'whether the plan has a real scale (scaleFixed).',
        const {},
        const [],
        (_) => snapshot(),
      );

  Future<Resource> _storey(ToolInput a) async {
    final subject = a.optText('storey', max: 500);
    final storeys = [
      for (final r in await home.children())
        if (r.isA(BuildingClass.storey)) r,
    ];
    String names() => storeys.map((s) => '${s.subject} (${s.name})').join(', ');
    if (subject != null) {
      return storeys.where((s) => s.subject == subject).firstOrNull ??
          (throw ToolError('Unknown storey $subject. Storeys: ${names()}'));
    }
    if (storeys.length == 1) return storeys.single;
    if (storeys.isEmpty) return repo.createStorey(home, 'Ground floor');
    throw ToolError('storey is required. Storeys: ${names()}');
  }

  /// Evidence on [item] from the optional `source` of [a].
  Future<String?> _cite(
      ToolInput a, Resource item, double? confidence, Resource run) async {
    final subject = a.optText('source', max: 500);
    if (subject == null) return null;
    final source = await _own(subject, BuildingClass.source, 'source');
    await repo.addEvidence(home, source, item,
        confidence: confidence, run: run);
    return source.subject;
  }

  Future<void> _checkSource(ToolInput a) async {
    final subject = a.optText('source', max: 500);
    if (subject != null) await _own(subject, BuildingClass.source, 'source');
  }

  Map<String, Object?> _proposed(Resource r, [Map<String, Object?>? more]) => {
        'subject': r.subject,
        'reviewState': Review.proposed,
        if (_warnScale)
          'warning': 'The plan has no real scale yet: these coordinates are '
              'relative. Ask for one real measurement.',
        ...?more,
      };

  /// Set while a call runs: whether to warn that the scale is not fixed.
  bool _warnScale = false;

  Future<void> _scaleCheck() async =>
      _warnScale = !_scaleFixed(await home.children());

  AiTool get _addSpace => _tool(
        'add_space',
        'Propose a space (room) on a storey as an outline in metres. It stays '
            'a proposal until the person confirms it.',
        {
          'name': {'type': 'string', 'description': 'For example "Kitchen".'},
          'usage': {'type': 'string', 'enum': _usages},
          'boundary': {
            'type': 'array',
            'minItems': 3,
            'maxItems': 64,
            'items': {
              'type': 'array',
              'items': {'type': 'number'},
              'minItems': 2,
              'maxItems': 2,
            },
            'description': 'Corners [x, y] in metres, in order, not closed.',
          },
          'storey': {
            ..._subject,
            'description': 'Storey subject; optional when there is one.',
          },
          'confidence': _confidence,
          'source': _sourceProp,
        },
        const ['name', 'usage', 'boundary'],
        (a) async {
          final name = a.text('name', max: 80);
          final usage = a.oneOf('usage', _usages);
          final boundary = a.points('boundary');
          final area = polygonArea(boundary);
          if (area < 0.1) {
            throw const ToolError('The outline has no area; check the corners');
          }
          final confidence = a.optNumber('confidence', min: 0, max: 1) ?? 0.5;
          await _checkSource(a);
          final storey = await _storey(a);
          await _scaleCheck();
          final run = await _runFor();
          final space = await repo.createSpace(storey, name, usage, boundary,
              origin: Origin.ai, confidence: confidence, run: run);
          _count('space(s)');
          final cited = await _cite(a, space, confidence, run);
          return _proposed(space, {
            'areaM2': double.parse(area.toStringAsFixed(2)),
            'areaNote': 'computed from the outline you gave',
            'storey': storey.subject,
            if (cited != null) 'source': cited,
          });
        },
      );

  AiTool get _addWall => _tool(
        'add_wall',
        'Propose a wall as a line from start to end in metres. Walls are the '
            'frame that doors and windows are added to.',
        {
          'start': {
            'type': 'array',
            'items': {'type': 'number'},
            'minItems': 2,
            'maxItems': 2,
            'description': '[x, y] in metres.',
          },
          'end': {
            'type': 'array',
            'items': {'type': 'number'},
            'minItems': 2,
            'maxItems': 2,
            'description': '[x, y] in metres.',
          },
          'thickness': {
            'type': 'number',
            'minimum': 0.02,
            'maximum': 1.5,
            'description': 'Metres, default 0.1 (a guess unless known).',
          },
          'height': {
            'type': 'number',
            'minimum': 0.5,
            'maximum': 12,
            'description': 'Metres, default the storey height.',
          },
          'name': {'type': 'string'},
          'storey': {
            ..._subject,
            'description': 'Storey subject; optional when there is one.',
          },
          'confidence': _confidence,
          'source': _sourceProp,
        },
        const ['start', 'end'],
        (a) async {
          final start = a.point('start'), end = a.point('end');
          if (start.distanceTo(end) < 0.05) {
            throw const ToolError('The wall is shorter than 5 cm');
          }
          final thickness =
              a.optNumber('thickness', min: 0.02, max: 1.5) ?? 0.1;
          final confidence = a.optNumber('confidence', min: 0, max: 1) ?? 0.5;
          final name = a.optText('name', max: 80) ?? 'Wall';
          await _checkSource(a);
          final storey = await _storey(a);
          final height = a.optNumber('height', min: 0.5, max: 12) ??
              _num(storey, Bldg.height) ??
              2.6;
          await _scaleCheck();
          final run = await _runFor();
          final wall = await repo.createElement(
              storey,
              name,
              'IfcWall',
              WallAxis(
                  start: start, end: end, height: height, thickness: thickness),
              origin: Origin.ai,
              confidence: confidence,
              run: run);
          _count('wall(s)');
          final cited = await _cite(a, wall, confidence, run);
          return _proposed(wall, {
            'lengthM': double.parse(start.distanceTo(end).toStringAsFixed(2)),
            'storey': storey.subject,
            if (cited != null) 'source': cited,
          });
        },
      );

  AiTool get _addOpening => _tool(
        'add_opening',
        'Propose a door, window or opening in an existing wall, measured '
            'along the wall from its start.',
        {
          'wall': {
            ..._subject,
            'description': 'Subject of the wall Element it is in.',
          },
          'kind': {'type': 'string', 'enum': _openingKinds.keys.toList()},
          'offset': {
            'type': 'number',
            'minimum': 0,
            'description': 'Metres from the wall start to the near edge.',
          },
          'width': {'type': 'number', 'minimum': 0.1, 'maximum': 10},
          'height': {'type': 'number', 'minimum': 0.1, 'maximum': 6},
          'sill': {
            'type': 'number',
            'minimum': 0,
            'description': 'Metres above the floor; required for a window.',
          },
          'name': {'type': 'string'},
          'confidence': _confidence,
          'source': _sourceProp,
        },
        const ['wall', 'kind', 'offset', 'width', 'height'],
        (a) async {
          final wall = await _own(
              a.optText('wall', max: 500), BuildingClass.element, 'wall');
          final axis = wall.geometry;
          if (axis is! WallAxis) {
            throw ToolError('${wall.subject} is not a wall with a line');
          }
          final kind = a.oneOf('kind', _openingKinds.keys);
          final offset = a.number('offset', min: 0, max: 1000);
          final width = a.number('width', min: 0.1, max: 10);
          final height = a.number('height', min: 0.1, max: 6);
          final sill = a.optNumber('sill', min: 0, max: 6);
          if (kind == 'window' && sill == null) {
            throw const ToolError('sill is required for a window');
          }
          if (offset + width > axis.length + 1e-6) {
            throw ToolError('The opening runs past the end of the wall: '
                'offset + width is ${(offset + width).toStringAsFixed(2)} m, '
                'the wall is ${axis.length.toStringAsFixed(2)} m long');
          }
          if ((sill ?? 0) + height > axis.height + 1e-6) {
            throw ToolError('The opening is higher than the wall '
                '(${axis.height} m)');
          }
          final confidence = a.optNumber('confidence', min: 0, max: 1) ?? 0.5;
          await _checkSource(a);
          final storey = await _own(
              wall.getLink(Bldg.storey), BuildingClass.storey, 'storey');
          await _scaleCheck();
          final run = await _runFor();
          final item = await repo.createElement(
              storey,
              a.optText('name', max: 80) ??
                  '${kind[0].toUpperCase()}${kind.substring(1)}',
              _openingKinds[kind]!,
              Opening(
                  offset: offset,
                  width: width,
                  height: height,
                  sill: sill ?? 0),
              hostedBy: wall,
              origin: Origin.ai,
              confidence: confidence,
              run: run);
          _count('opening(s)');
          final cited = await _cite(a, item, confidence, run);
          return _proposed(item, {
            'hostedBy': wall.subject,
            if (cited != null) 'source': cited,
          });
        },
      );

  AiTool get _askQuestion => _tool(
        'ask_question',
        'Record a question for the person; it shows in the Questions tab. '
            'Then ask it in your reply, in plain words.',
        {
          'text': {'type': 'string', 'description': 'The question itself.'},
          'kind': {'type': 'string', 'enum': _questionKinds},
          'why': {
            'type': 'string',
            'description': 'Why you need it, in one sentence.',
          },
          'about': {
            ..._subject,
            'description': 'The resource the answer is about, if any.',
          },
          'options': {
            'type': 'array',
            'items': {'type': 'string'},
            'minItems': 2,
            'maxItems': 8,
            'description': 'The choices; only for kind choose.',
          },
          'wants': {
            'type': 'string',
            'description': 'What to send, for example "metres" or "a photo '
                'of the front".',
          },
        },
        const ['text', 'kind', 'why'],
        (a) async {
          final text = a.text('text');
          final kind = a.oneOf('kind', _questionKinds);
          final why = a.text('why');
          final options =
              a.strings('options', min: kind == 'choose' ? 2 : 0, max: 8);
          if (kind != 'choose' && options.isNotEmpty) {
            throw const ToolError('options are only for kind choose');
          }
          final aboutSubject = a.optText('about', max: 500);
          Resource? about;
          if (aboutSubject != null) {
            about = await _store.getResourceOrNull(aboutSubject);
            if (about == null || about.parent != home.subject) {
              throw ToolError('$aboutSubject is not part of this home');
            }
          }
          final q = await repo.createQuestion(home, text, kind,
              about: about,
              why: why,
              options: options.isEmpty ? null : options,
              wants: a.optText('wants', max: 100));
          return {
            'subject': q.subject,
            'next': 'Now ask this to the person in your reply.',
          };
        },
      );

  AiTool get _answerQuestion => _tool(
        'answer_question',
        'Close an open question with the answer the person just gave, and '
            'record it as evidence. Only when their message really answers it.',
        {
          'question': {
            ..._subject,
            'description': 'Subject of the open question.',
          },
          'answer': {
            'type': 'string',
            'description': 'The answer as the person gave it; for confirm '
                'questions "Yes" or "No"; for choose one of the options.',
          },
          'source': {
            ..._sourceProp,
            'description': 'Subject of a Source that shows the answer (a '
                'photo, say), if the person sent one.',
          },
        },
        const ['question', 'answer'],
        (a) async {
          final q = await _own(a.optText('question', max: 500),
              BuildingClass.question, 'question');
          if (!q.isOpen) {
            throw const ToolError('That question is answered already');
          }
          var answer = a.text('answer', max: 500);
          final kind = q.getString(Bldg.questionKind);
          final options = q.getStrings(Bldg.options);
          if (kind == 'confirm') {
            final yes = RegExp(r'^(yes|y|ja|true)$', caseSensitive: false);
            final no = RegExp(r'^(no|n|nee|false)$', caseSensitive: false);
            answer = yes.hasMatch(answer)
                ? 'Yes'
                : no.hasMatch(answer)
                    ? 'No'
                    : throw const ToolError('A confirm question is answered '
                        'with Yes or No');
          } else if (options.isNotEmpty) {
            final hit = options
                .where((o) => o.toLowerCase() == answer.toLowerCase())
                .firstOrNull;
            if (hit == null) {
              throw ToolError('answer must be one of: ${options.join(', ')}');
            }
            answer = hit;
          } else if (kind == 'measure' && !RegExp(r'\d').hasMatch(answer)) {
            throw const ToolError('A measure answer needs a number');
          }
          final sourceSubject = a.optText('source', max: 500);
          final source = sourceSubject == null
              ? null
              : await _own(sourceSubject, BuildingClass.source, 'source');
          await repo
              .answerQuestion(q, answer, sources: [if (source != null) source]);
          return {'question': q.subject, 'answer': answer};
        },
      );

  AiTool get _recordEvidence => _tool(
        'record_evidence',
        'Record that a Source supports something already in the home (a '
            'space, wall, opening or question).',
        {
          'source': _sourceProp,
          'supports': {
            ..._subject,
            'description': 'The space, element or question it supports.',
          },
          'locator': {
            'type': 'string',
            'description': 'Where in the source, for example "page 2, top '
                'left" or "photo, left wall".',
          },
          'confidence': _confidence,
        },
        const ['source', 'supports'],
        (a) async {
          final source = await _own(
              a.optText('source', max: 500), BuildingClass.source, 'source');
          final supportsSubject = a.optText('supports', max: 500);
          final supports = supportsSubject == null
              ? null
              : await _store.getResourceOrNull(supportsSubject);
          if (supports == null ||
              supports.parent != home.subject ||
              supports.isA(BuildingClass.source)) {
            throw ToolError('${supportsSubject ?? 'supports'} is not a space, '
                'element or question of this home');
          }
          final run = await _runFor();
          final evidence = await repo.addEvidence(home, source, supports,
              locator: a.optText('locator', max: 200),
              confidence: a.optNumber('confidence', min: 0, max: 1) ?? 0.5,
              run: run);
          _count('evidence');
          return {'evidence': evidence.subject};
        },
      );

  static bool _sameOutline(List<Pt> a, List<Pt> b) =>
      a.length == b.length &&
      [for (var i = 0; i < a.length; i++) a[i].distanceTo(b[i]) < 1e-6]
          .every((x) => x);

  Map<String, Object?> _option(String name, Alignment a) => {
        'placement': name,
        'confidence': double.parse(a.confidence.toStringAsFixed(2)),
        'rotationDegrees': (a.rotation * 180 / math.pi).round(),
        'moveMetres': [
          double.parse(a.tx.toStringAsFixed(2)),
          double.parse(a.ty.toStringAsFixed(2)),
        ],
        if (a.matchedAt != null) 'doorAt': a.matchedAt!.toJson(),
      };

  AiTool get _connectRooms => _tool(
        'connect_rooms',
        'Place a pending scanned room (pendingScans) against a room that is '
            'already on the plan, so that a door of the two coincides. When '
            'the placement is confident the room is imported as proposals; '
            'otherwise needsDecision is true and nothing is imported: put the '
            'options to the person and call again with their placement.',
        {
          'new_room': {
            'type': 'string',
            'description': 'The id (or name) of a pending scan.',
          },
          'existing_room': {
            ..._subject,
            'description': 'Subject of the scanned space it connects to.',
          },
          'via_door': {
            ..._subject,
            'description': 'Subject of the door or opening of the existing '
                'room that the two share, when the person said which.',
          },
          'placement': {
            'type': 'string',
            'description': 'The person\'s choice after needsDecision: best, '
                'alt_1, alt_2, ... or as_scanned (keep the scan\'s own '
                'position).',
          },
        },
        const ['new_room', 'existing_room'],
        (a) async {
          final key = a.text('new_room', max: 80);
          final pending = _pending[key] ??
              _pending.values.where((p) => p.room.name == key).firstOrNull ??
              (throw ToolError(_pending.isEmpty
                  ? 'There is no pending scan'
                  : 'Unknown new_room. Pending: ${_pending.keys.join(', ')}'));
          final space = await _own(a.optText('existing_room', max: 500),
              BuildingClass.space, 'existing room');
          if (space.getLink(Bldg.storey) != pending.storey.subject) {
            throw const ToolError('That room is on another storey');
          }
          final outline = space.boundary;
          var room = (await loadPlacedRooms(repo, pending.storey))
              .where((r) => outline != null && _sameOutline(r.outline, outline))
              .firstOrNull;
          if (room == null) {
            throw const ToolError('That room was not placed from a scan, so '
                'there is nothing to connect to');
          }
          final doorSubject = a.optText('via_door', max: 500);
          if (doorSubject != null) {
            final door = await _own(doorSubject, BuildingClass.element, 'door');
            final opening = door.geometry;
            final host = door.getLink(Bldg.hostedBy);
            final wall = host == null
                ? null
                : (await _store.getResourceOrNull(host))?.geometry;
            if (opening is! Opening || wall is! WallAxis) {
              throw const ToolError('via_door is not a door in a wall');
            }
            final len = wall.length;
            final at = opening.offset + opening.width / 2;
            final centre = Pt(
                wall.start.x + (wall.end.x - wall.start.x) / len * at,
                wall.start.y + (wall.end.y - wall.start.y) / len * at);
            final near = [
              for (final o in room.openings)
                if (o.centre.distanceTo(centre) < 0.1) o,
            ];
            if (near.isEmpty) {
              throw const ToolError(
                  'via_door is not a door of that existing room');
            }
            room = PlanRoom(room.walls, near, room.outline);
          }
          final found = alignScannedRoom([room], pending.room);
          final choice = a.optText('placement', max: 20)?.toLowerCase();
          Alignment? use;
          if (choice == null) {
            if (found != null && found.isConfident) {
              use = found;
            } else {
              return {
                'needsDecision': true,
                'reason': found == null
                    ? 'No door of the new room matches a door of that room'
                    : 'Several placements fit about equally well',
                'options': [
                  if (found != null) ...[
                    _option('best', found),
                    for (var i = 0; i < found.alternatives.length; i++)
                      _option('alt_${i + 1}', found.alternatives[i]),
                  ],
                  {
                    'placement': 'as_scanned',
                    'note': 'keep the scan\'s own position, not connected',
                  },
                ],
                'next': 'Tell the person the options in plain words and ask '
                    'which to take, then call connect_rooms again with '
                    'placement.',
              };
            }
          } else if (choice == 'as_scanned') {
            use = Alignment.identity;
          } else if (choice == 'best') {
            use =
                found ?? (throw const ToolError('There is no best placement'));
          } else {
            final n = RegExp(r'^alt_(\d+)$').firstMatch(choice)?.group(1);
            final i = n == null ? -1 : int.parse(n) - 1;
            if (found == null || i < 0 || i >= found.alternatives.length) {
              throw const ToolError(
                  'placement must be best, alt_N (as listed) or as_scanned');
            }
            use = found.alternatives[i];
          }
          final result = await importScannedRoomChecked(
              repo, pending.storey, pending.room,
              alignment: use);
          _pending.remove(pending.id);
          _count('scanned room(s)');
          return {
            'imported': result.created.length,
            'placement': choice ?? 'best',
            'confidence': double.parse(use.confidence.toStringAsFixed(2)),
            'reviewState': Review.proposed,
          };
        },
      );
}
