// @wc-ignore-file
import { test, expect } from './fixtures';
import { before, FRONTEND_URL, waitForSynced } from './test-utils';

test.beforeEach(async ({ page }, testInfo) => {
  // This graph test uses local data and must also work without a font CDN.
  await page.route('https://fonts.googleapis.com/**', route =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  await before({ page }, testInfo);
});

test('ontology graph saves keyboard and drag positions without a previous drag', async ({
  page,
}, testInfo) => {
  const fixture = await page.evaluate(async () => {
    const { core, dataBrowser } = window.atomicE2E!.tomicLib;
    const store = window.store;
    const ontology = await store.newResource({
      parent: store.getDrive(),
      isA: core.classes.ontology,
      propVals: {
        [core.properties.name]: 'Checklist schema',
        [core.properties.description]:
          'An invented checklist ontology for graph interaction.',
        [core.properties.shortname]: 'checklist-schema',
        [core.properties.classes]: [],
        [core.properties.properties]: [],
      },
    });
    await ontology.save();
    const note = await store.newResource({
      parent: ontology.subject,
      isA: core.classes.class,
      propVals: {
        [core.properties.name]: 'Checklist note',
        [core.properties.description]: 'A note containing checklist items.',
        [core.properties.shortname]: 'checklist-note',
      },
    });
    await note.save();
    const relation = await store.newResource({
      parent: ontology.subject,
      isA: core.classes.property,
      propVals: {
        [core.properties.name]: 'Note',
        [core.properties.description]: 'The note containing this item.',
        [core.properties.shortname]: 'note',
        [core.properties.datatype]:
          'https://atomicdata.dev/datatypes/atomicURL',
        [core.properties.classtype]: note.subject,
      },
    });
    await relation.save();
    const item = await store.newResource({
      parent: ontology.subject,
      isA: core.classes.class,
      propVals: {
        [core.properties.name]: 'Checklist item',
        [core.properties.description]: 'An item belonging to a note.',
        [core.properties.shortname]: 'checklist-item',
        [core.properties.recommends]: [relation.subject],
      },
    });
    await item.save();
    await ontology.set(core.properties.classes, [note.subject, item.subject]);
    await ontology.set(core.properties.properties, [relation.subject]);
    await ontology.save();

    return {
      ontology: ontology.subject,
      item: item.subject,
      positions: dataBrowser.properties.customNodePositioning,
    };
  });
  await waitForSynced(page);
  await page.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(fixture.ontology)}`,
  );
  const node = page
    .locator('.react-flow__node')
    .filter({ hasText: 'Checklist item' });
  await expect(node).toBeVisible();
  await node.click();
  // React Flow sends a position change with dragging:false for keyboard moves.
  // There has been no pointer drag, so the old handler threw positionAbsolute.
  await node.press('ArrowRight');
  const position = () =>
    page.evaluate(
      async ({ ontology, positions, item }) =>
        (
          (await window.store.getResource(ontology)).get(positions) as
            | Record<string, [number, number]>
            | undefined
        )?.[item],
      fixture,
    );
  await expect.poll(position).toEqual([expect.any(Number), expect.any(Number)]);
  const keyboardPosition = await position();
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 60,
    box.y + box.height / 2 + 40,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect.poll(position).not.toEqual(keyboardPosition);
  const draggedPosition = await position();
  await waitForSynced(page);
  await page.reload();
  await expect(node).toBeVisible();
  expect(await position()).toEqual(draggedPosition);
  await expect(
    page.getByText(/Cannot read properties.*positionAbsolute/),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('ontology-graph.png'),
    fullPage: true,
  });
});
