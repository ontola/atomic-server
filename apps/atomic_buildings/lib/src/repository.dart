import 'package:atomic_store/atomic_store.dart';

import 'geometry.dart';
import 'terms.g.dart';

/// The task/v1 vocabulary every AtomicServer embeds; `status` is a tag link.
abstract final class Task {
  static const status = 'https://atomicdata.dev/task/v1/status';
  static const body = 'https://atomicdata.dev/task/v1/body';
  static const todo = 'https://atomicdata.dev/task/v1/todo';
  static const done = 'https://atomicdata.dev/task/v1/done';
}

/// Values of `bldg-origin`, `bldg-review-state`, `bldg-media-kind` and the
/// enums of the ontology that the app writes (the server does not check them).
abstract final class Origin {
  static const user = 'user', ai = 'ai', import = 'import';
}

abstract final class Review {
  static const proposed = 'proposed',
      confirmed = 'confirmed',
      rejected = 'rejected';
}

abstract final class MediaKind {
  static const photo = 'photo',
      scan = 'scan',
      pdf = 'pdf',
      floorplan = 'floorplan',
      note = 'note';
}

/// Reads of a resource that the UI shares with the repository.
extension BuildingResource on Resource {
  String? get reviewState => getString(Bldg.reviewState);
  bool get isProposed => reviewState == Review.proposed;
  bool get isRejected => reviewState == Review.rejected;
  bool get isOpen => !getLinks(Task.status).contains(Task.done);

  /// The Geometry of an Element, or null when it has none or it is invalid.
  Geometry? get geometry {
    final kind = getString(Bldg.geometryKind);
    final json = getJson(Bldg.geometry);
    if (kind == null || json == null) return null;
    try {
      return Geometry.fromJson(kind, json);
    } on GeometryException {
      return null;
    }
  }

  /// A Space's outline, or null.
  List<Pt>? get boundary {
    try {
      return polygonFromJson(getJson(Bldg.boundary), 'boundary');
    } on GeometryException {
      return null;
    }
  }
}

/// The digital twin on a [Store]. Every resource except a Home has the Home
/// as its `parent` (the permission anchor); containment is a `bldg-*` link.
class BuildingRepository {
  BuildingRepository(this.store);
  final Store store;

  Future<Resource> _create(
    String? parent,
    String cls,
    Map<String, Object> props, {
    String? issue,
  }) async {
    final r = store.newResource(
      parent: parent,
      isA: [cls, if (issue != null) issue],
      props: props,
    );
    await r.save();
    return r;
  }

  static Map<String, Object> _review(
          String origin, double? confidence, Resource? run) =>
      {
        Bldg.origin: origin,
        if (run != null) Bldg.createdByRun: LinkValue(run.subject),
        Bldg.reviewState:
            origin == Origin.user ? Review.confirmed : Review.proposed,
        if (confidence != null) Bldg.confidence: confidence,
      };

  // ---- create ----

  /// A Home in the store's drive, with its one Building (a Storey requires
  /// one in the ontology, and the v1 app has a single building per Home).
  Future<Resource> createHome(String name) async {
    final home = await _create(
        null, BuildingClass.home, {Bldg.units: 'metric', Props.name: name});
    await _create(home.subject, BuildingClass.building, {Props.name: name});
    return home;
  }

  Future<Resource> createStorey(
    Resource home,
    String name, {
    double elevation = 0,
    double height = 2.6,
    int level = 0,
  }) async {
    final building = (await home.children())
        .firstWhere((c) => c.isA(BuildingClass.building));
    return _create(home.subject, BuildingClass.storey, {
      Props.name: name,
      Bldg.building: LinkValue(building.subject),
      Bldg.elevation: elevation,
      Bldg.height: height,
      Bldg.level: level,
    });
  }

  Future<Resource> createSpace(
    Resource storey,
    String name,
    String usage,
    List<Pt> boundary, {
    String origin = Origin.user,
    double? confidence,
    double? height,
    Resource? run,
  }) =>
      _create(storey.parent, BuildingClass.space, {
        if (height != null) Bldg.height: height,
        Props.name: name,
        Bldg.storey: LinkValue(storey.subject),
        Bldg.usage: usage,
        Bldg.boundary: JsonValue.encode(polygonToJson(boundary)),
        ..._review(origin, confidence, run),
      });

  Future<Resource> createElement(
    Resource storey,
    String name,
    String ifcClass,
    Geometry geometry, {
    Resource? hostedBy,
    String origin = Origin.user,
    double? confidence,
    Resource? run,
  }) =>
      _create(storey.parent, BuildingClass.element, {
        Props.name: name,
        Bldg.storey: LinkValue(storey.subject),
        Bldg.ifcClass: ifcClass,
        Bldg.geometryKind: geometry.kind,
        Bldg.geometry: JsonValue.encode(geometry.toJson()),
        if (hostedBy != null) Bldg.hostedBy: LinkValue(hostedBy.subject),
        ..._review(origin, confidence, run),
      });

  /// Something the user gave: [file] is the subject of its File resource,
  /// which can come later (a note has none).
  Future<Resource> addSource(
    Resource home,
    String name,
    String mediaKind, {
    String? file,
    DateTime? capturedAt,
    String status = 'new',
    String? description,
  }) =>
      _create(home.subject, BuildingClass.source, {
        Props.name: name,
        Bldg.mediaKind: mediaKind,
        Bldg.sourceStatus: status,
        Bldg.capturedAt: TimestampValue(
            (capturedAt ?? DateTime.now()).millisecondsSinceEpoch),
        if (file != null) Bldg.sourceFile: LinkValue(file),
        if (description != null) Props.description: description,
      });

  Future<Resource> addEvidence(
    Resource home,
    Resource source,
    Resource supports, {
    Object? locator,
    double? confidence,
    Resource? run,
  }) =>
      _create(home.subject, BuildingClass.evidence, {
        if (run != null) Bldg.createdByRun: LinkValue(run.subject),
        Bldg.source: LinkValue(source.subject),
        Bldg.supports: LinkValue(supports.subject),
        if (locator != null) Bldg.locator: JsonValue.encode(locator),
        if (confidence != null) Bldg.confidence: confidence,
      });

  /// One finished pass of [model] over [inputs] (status `completed`).
  Future<Resource> addAnalysisRun(
    Resource home,
    String name,
    String model, {
    List<Resource> inputs = const [],
    String? summary,
  }) =>
      _create(home.subject, BuildingClass.analysisRun, {
        Props.name: name,
        Bldg.model: model,
        Bldg.runStatus: 'completed',
        Bldg.startedAt: TimestampValue(DateTime.now().millisecondsSinceEpoch),
        if (inputs.isNotEmpty) Bldg.inputs: [for (final i in inputs) i.subject],
        if (summary != null) Props.description: summary,
      });

  Future<Resource> createListing(
    Resource home,
    String title, {
    String? description,
    double? askingPrice,
    String currency = 'EUR',
  }) =>
      _create(home.subject, BuildingClass.listing, {
        Props.name: title,
        Bldg.home: LinkValue(home.subject),
        Bldg.listingStatus: 'draft',
        if (description != null) Props.description: description,
        if (askingPrice != null) Bldg.askingPrice: askingPrice,
        Bldg.currency: currency,
      });

  /// A Question is an issue-v1 and a building-question-v1 at once, so task
  /// views show it. [kind] is confirm, choose, measure, upload or text.
  Future<Resource> createQuestion(
    Resource home,
    String text,
    String kind, {
    Resource? about,
    String? why,
    List<String>? options,
    String? wants,
  }) =>
      _create(
        home.subject,
        BuildingClass.question,
        issue: IssueClass.issue,
        {
          Props.name: text,
          Bldg.questionKind: kind,
          Task.status: [Task.todo],
          if (about != null) Bldg.about: LinkValue(about.subject),
          if (why != null) Bldg.why: why,
          if (options != null) Bldg.options: JsonValue.strings(options),
          if (wants != null) Bldg.wants: wants,
        },
      );

  // ---- answer and review ----

  /// Stores [answer], closes the issue (status done) and records Evidence for
  /// what the question is about. Evidence needs a Source, so a text answer
  /// becomes a `note` Source; [sources] the person added are used as given.
  Future<Resource> answerQuestion(
    Resource question,
    String answer, {
    List<Resource> sources = const [],
  }) async {
    final home = await store.getResource(question.parent!);
    final about = question.getLink(Bldg.about);
    final supports = about == null ? question : await store.getResource(about);
    // The question is saved first: a watch that is busy reloading misses the
    // events of later saves, and the inbox must see this one.
    question.set(Bldg.answer, answer);
    if (sources.isNotEmpty) {
      question.set(Bldg.answerSources, [for (final s in sources) s.subject]);
    }
    question.set(Task.status, [Task.done]);
    await question.save();
    final used = sources.isEmpty
        ? [await addSource(home, answer, MediaKind.note)]
        : sources;
    for (final s in used) {
      await addEvidence(home, s, supports, confidence: 1);
    }
    return question;
  }

  Future<void> _review_(Resource r, String state) {
    r.set(Bldg.reviewState, state);
    return r.save();
  }

  Future<void> confirm(Resource r) => _review_(r, Review.confirmed);
  Future<void> reject(Resource r) => _review_(r, Review.rejected);

  // ---- read ----

  Stream<List<Resource>> _all(String home, String cls,
          [bool Function(Resource)? where]) =>
      store
          .watchChildren(home, isA: cls)
          .map((l) => where == null ? l : l.where(where).toList());

  Stream<List<Resource>> watchHomes() =>
      store.watchChildren(store.drive!, isA: BuildingClass.home);
  Stream<List<Resource>> watchStoreys(Resource home) =>
      _all(home.subject, BuildingClass.storey);
  Stream<List<Resource>> watchSources(Resource home) =>
      _all(home.subject, BuildingClass.source);
  Stream<List<Resource>> watchQuestions(Resource home) =>
      _all(home.subject, BuildingClass.question);
  Stream<List<Resource>> watchOpenQuestions(Resource home) =>
      _all(home.subject, BuildingClass.question, (q) => q.isOpen);

  Stream<List<Resource>> watchSpaces(Resource storey) => _all(storey.parent!,
      BuildingClass.space, (s) => s.getLink(Bldg.storey) == storey.subject);
  Stream<List<Resource>> watchElements(Resource storey) => _all(storey.parent!,
      BuildingClass.element, (e) => e.getLink(Bldg.storey) == storey.subject);

  /// The Evidence that supports [item], each with its Source.
  Future<List<({Resource evidence, Resource source})>> evidenceFor(
      Resource item) async {
    final all = await (await store.getResource(item.parent!)).children();
    return [
      for (final e in all)
        if (e.isA(BuildingClass.evidence) &&
            e.getLink(Bldg.supports) == item.subject)
          (
            evidence: e,
            source: await store.getResource(e.getLink(Bldg.source)!)
          ),
    ];
  }
}
