import 'package:atomic_buildings/src/geometry.dart';
import 'package:atomic_buildings/src/repository.dart';
import 'package:atomic_buildings/ui/home_page.dart';
import 'chat_helpers.dart';
import 'package:atomic_buildings/ui/plan_view.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:atomic_store/testing.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('plan paints the storey; the inbox lists the open question',
      (tester) async {
    const drive = 'did:ad:drive';
    final backend = InMemoryBackend({
      drive: {Props.name: const StringValue('Drive')},
    });
    final repo = BuildingRepository(Store(backend: backend, drive: drive));
    late Resource home;
    await tester.runAsync(() async {
      home = await repo.createHome('Villa');
      final storey = await repo.createStorey(home, 'Ground');
      await repo.createSpace(storey, 'Living', 'living',
          const [Pt(0, 0), Pt(4, 0), Pt(4, 3), Pt(0, 3)]);
      final wall = await repo.createElement(
          storey,
          'North wall',
          'IfcWall',
          const WallAxis(
              start: Pt(0, 3), end: Pt(4, 3), height: 2.6, thickness: 0.2),
          origin: Origin.ai,
          confidence: 0.7);
      await repo.createElement(storey, 'Window', 'IfcWindow',
          const Opening(offset: 1, width: 1.2, height: 1.2, sill: 0.9),
          hostedBy: wall, origin: Origin.ai);
      await repo.createQuestion(
          home, 'Is the north wall load-bearing?', 'confirm',
          about: wall, why: 'Decides if it can be removed');
    });

    // The store's futures run outside fake async; a watch needs a few turns
    // (storeys first, then the plan's own two watches).
    Future<void> settle() async {
      for (var i = 0; i < 4; i++) {
        await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump();
      }
    }

    await tester.pumpWidget(chatApp(HomePage(repo, home, chat: noAccountChat)));
    await settle();
    await openScreen(tester, 'Plan');
    await settle();
    final plan = find
        .byWidgetPredicate((w) => w is CustomPaint && w.painter is PlanPainter);
    expect(plan, findsOneWidget);
    expect(find.byType(CustomPaint), findsWidgets);

    String? written;
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(chatApp(HomePage(repo, home,
        chat: noAccountChat, key: UniqueKey(), writeExport: (name, glb) async {
      written = '$name:${glb.length}';
      return '/docs/$name';
    })));
    await settle();
    await openScreen(tester, 'Plan');
    await tester.tap(find.byTooltip('Export 3D model'));
    await settle();
    expect(written, startsWith('Villa.glb:'));
    expect(find.text('3D model saved to /docs/Villa.glb'), findsOneWidget);

    await tester.pageBack();
    await tester.pumpAndSettle();
    await openScreen(tester, 'Questions');
    await settle();
    expect(find.text('Is the north wall load-bearing?'), findsOneWidget);
    expect(find.text('Decides if it can be removed'), findsOneWidget);

    await tester.tap(find.text('Is the north wall load-bearing?'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes'));
    await settle();
    expect(find.text('Answered (1)'), findsOneWidget);
    await tester.tap(find.text('Answered (1)'));
    await tester.pumpAndSettle();
    expect(find.text('Yes'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    backend.dispose();
    await tester.pump();
  });

  test(
      'a tap on a wall, an opening or a room finds it; elsewhere finds nothing',
      () async {
    final backend = InMemoryBackend({
      'did:ad:drive': {Props.name: const StringValue('Drive')},
    });
    addTearDown(backend.dispose);
    final repo =
        BuildingRepository(Store(backend: backend, drive: 'did:ad:drive'));
    final home = await repo.createHome('Villa');
    final storey = await repo.createStorey(home, 'Ground');
    final room = await repo.createSpace(storey, 'Living', 'living',
        const [Pt(0, 0), Pt(4, 0), Pt(4, 3), Pt(0, 3)]);
    final wall = await repo.createElement(
        storey,
        'Wall',
        'IfcWall',
        const WallAxis(
            start: Pt(0, 0), end: Pt(4, 0), height: 2.6, thickness: 0.2));
    final door = await repo.createElement(storey, 'Door', 'IfcDoor',
        const Opening(offset: 2.5, width: 0.9, height: 2.1),
        hostedBy: wall);

    final plan = Plan([room, wall, door]);
    const size = Size(424, 324); // 100 px per metre plus a 24 px margin
    Offset at(double x, double y) => Offset(24 + x * 100, 300 - y * 100);
    expect(plan.hit(at(0.5, 0), size), wall);
    expect(plan.hit(at(2.9, 0), size), door);
    expect(plan.hit(at(2, 1.5), size), room);
    expect(plan.hit(at(5, 5), size), isNull);
  });
}
