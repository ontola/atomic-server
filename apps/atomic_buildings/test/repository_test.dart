import 'package:atomic_buildings/src/geometry.dart';
import 'package:atomic_buildings/src/repository.dart';
import 'package:atomic_buildings/src/terms.g.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:flutter_test/flutter_test.dart';

const drive = 'did:ad:drive';
const square = [Pt(0, 0), Pt(4, 0), Pt(4, 3), Pt(0, 3)];
const wall =
    WallAxis(start: Pt(0, 0), end: Pt(4, 0), height: 2.6, thickness: 0.2);

void main() {
  late InMemoryBackend backend;
  late BuildingRepository repo;

  setUp(() {
    backend = InMemoryBackend({
      drive: {Props.name: const StringValue('Drive')},
    });
    addTearDown(backend.dispose);
    repo = BuildingRepository(Store(backend: backend, drive: drive));
  });

  test('a home holds everything; containment is a link, never the parent',
      () async {
    final home = await repo.createHome('Villa');
    final storey = await repo.createStorey(home, 'Ground', height: 2.7);
    final space = await repo.createSpace(storey, 'Living', 'living', square);
    final host =
        await repo.createElement(storey, 'North wall', 'IfcWall', wall);
    final door = await repo.createElement(
      storey,
      'Door',
      'IfcDoor',
      const Opening(offset: 1, width: 0.9, height: 2.1),
      hostedBy: host,
    );

    expect(home.parent, drive);
    for (final r in [storey, space, host, door]) {
      expect(r.parent, home.subject);
    }
    final building = (await home.children())
        .singleWhere((c) => c.isA(BuildingClass.building));
    expect(storey.getLink(Bldg.building), building.subject);
    expect(space.getLink(Bldg.storey), storey.subject);
    expect(door.getLink(Bldg.hostedBy), host.subject);
    expect(space.boundary, square);
    expect(host.geometry, isA<WallAxis>());
    expect(host.getString(Bldg.origin), Origin.user);
    expect(host.reviewState, Review.confirmed);
  });

  test('watchStoreys, watchSpaces and watchElements follow the storey',
      () async {
    final home = await repo.createHome('Villa');
    final ground = await repo.createStorey(home, 'Ground');
    final first =
        await repo.createStorey(home, 'First', elevation: 2.8, level: 1);

    await repo.createSpace(
        first, 'Bedroom', 'bedroom', square); // another storey
    final storeys = expectLater(
      repo.watchStoreys(home).map((l) => l.map((r) => r.name).toSet()),
      emitsInOrder([
        {'Ground', 'First'},
        {'Ground', 'First', 'Attic'},
      ]),
    );
    final spaces = expectLater(
      repo.watchSpaces(ground).map((l) => [for (final s in l) s.name]),
      emitsInOrder([
        <String?>[],
        ['Living']
      ]),
    );
    final elements = expectLater(
      repo.watchElements(ground).map((l) => [for (final s in l) s.name]),
      emitsInOrder([
        <String?>[],
        ['Wall']
      ]),
    );
    await repo.createElement(ground, 'Wall', 'IfcWall', wall);
    await pumpEventQueue();
    await repo.createSpace(ground, 'Living', 'living', square);
    await repo.createStorey(home, 'Attic', level: 2);
    await Future.wait([storeys, spaces, elements]);
  });

  test(
      'a question is an issue and a question; answering records evidence and closes it',
      () async {
    final home = await repo.createHome('Villa');
    final storey = await repo.createStorey(home, 'Ground');
    final w = await repo.createElement(storey, 'Wall', 'IfcWall', wall,
        origin: Origin.ai, confidence: 0.6);
    final q = await repo.createQuestion(
        home, 'Is this wall load-bearing?', 'confirm',
        about: w, why: 'Decides if it can be moved');

    expect(q.isA(IssueClass.issue), isTrue);
    expect(q.isA(BuildingClass.question), isTrue);
    expect(q.isOpen, isTrue);
    expect(await repo.watchOpenQuestions(home).first, [q]);

    await repo.answerQuestion(q, 'Yes');

    expect(q.getString(Bldg.answer), 'Yes');
    expect(q.getLinks(Task.status), [Task.done]);
    expect(q.isOpen, isFalse);
    expect(await repo.watchOpenQuestions(home).first, isEmpty);
    final evidence = await repo.evidenceFor(w);
    expect(evidence, hasLength(1));
    expect(evidence.single.evidence.parent, home.subject);
    expect(evidence.single.source.getString(Bldg.mediaKind), MediaKind.note);
    expect(evidence.single.source.name, 'Yes');
  });

  test('an answer with sources links them as evidence and answerSources',
      () async {
    final home = await repo.createHome('Villa');
    final photo = await repo.addSource(home, 'Tape measure', MediaKind.photo,
        file: 'did:ad:f');
    final q = await repo.createQuestion(
        home, 'How wide is the window?', 'measure',
        wants: 'photo');

    await repo.answerQuestion(q, '1.2 m', sources: [photo]);

    expect(q.getLinks(Bldg.answerSources), [photo.subject]);
    expect(await repo.evidenceFor(q),
        hasLength(1)); // no `about`: supports the question
    expect(photo.getLink(Bldg.sourceFile), 'did:ad:f');
  });

  test('confirm and reject set the review state of a proposal', () async {
    final home = await repo.createHome('Villa');
    final storey = await repo.createStorey(home, 'Ground');
    final space = await repo.createSpace(storey, 'Hall', 'hall', square,
        origin: Origin.ai, confidence: 0.4);
    expect(space.isProposed, isTrue);

    await repo.reject(space);
    expect(space.isRejected, isTrue);
    expect(
        (await repo.store.getResource(space.subject, fresh: true)).reviewState,
        Review.rejected);

    await repo.confirm(space);
    expect(space.reviewState, Review.confirmed);
  });

  test('sources, evidence and a listing are plain children of the home',
      () async {
    final home = await repo.createHome('Villa');
    final source = await repo.addSource(home, 'Brochure', MediaKind.pdf);
    final listing =
        await repo.createListing(home, 'For sale', askingPrice: 450000);
    expect(source.getString(Bldg.sourceStatus), 'new');
    expect(listing.getLink(Bldg.home), home.subject);
    expect(listing.getString(Bldg.listingStatus), 'draft');
    expect(await repo.watchSources(home).first, [source]);
  });
}
