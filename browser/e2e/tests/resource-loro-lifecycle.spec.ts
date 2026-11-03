import type { Resource } from '@tomic/lib';
import { test, expect } from './fixtures';
import { before } from './test-utils';

declare global {
  interface Window {
    __resourceLoroLifecycle?: {
      abandoned: WeakRef<Resource>[];
      held: Resource;
      document: NonNullable<ReturnType<Resource['getLoroDoc']>>;
    };
  }
}

test.beforeEach(before);

// Exercise the production browser's web/WASM build, rather than a separately
// imported Node Loro module. A leaked observer formerly kept every temporary
// Resource and its document alive after an incoming-state merge discarded it.
test('releases abandoned hydrated Resources while retained documents stay usable', async ({
  page,
}) => {
  await page.waitForFunction(() => {
    const drive = window.store?.getDrive();

    return !!drive && !!window.store.resources.get(drive)?.getLoroDoc();
  });

  const created = await page.evaluate(() => {
    const store = window.store;
    const live = store.resources.get(store.getDrive()!);
    if (!live) throw new Error('The fresh drive did not load');
    // The constructor comes from the running app; the import above is types
    // only, so the test cannot instantiate another Loro module accidentally.
    const ResourceClass = live.constructor as typeof Resource;
    const name = 'https://atomicdata.dev/properties/name';
    const source = new ResourceClass('https://example.com/lifecycle-source');
    const sourceDoc = source.getLoroDoc();
    if (!sourceDoc) throw new Error('The browser Loro module did not load');
    sourceDoc.getMap('properties').set(name, 'Synthetic checklist item');
    sourceDoc.commit();
    const snapshot = sourceDoc.export({ mode: 'snapshot' });

    const abandoned: WeakRef<Resource>[] = [];

    for (let index = 0; index < 40; index++) {
      const resource = new ResourceClass(
        `https://example.com/lifecycle-temporary-${index}`,
      );
      const imported = resource.importLoroUpdate(snapshot, true);
      if (
        !imported.complete ||
        resource.get(name) !== 'Synthetic checklist item'
      )
        throw new Error('A temporary Resource did not hydrate its snapshot');
      abandoned.push(new WeakRef(resource));
    }

    const held = new ResourceClass('https://example.com/lifecycle-retained');
    held.importLoroUpdate(snapshot, true);
    window.__resourceLoroLifecycle = {
      abandoned,
      held,
      document: held.getLoroDoc()!,
    };

    return abandoned.length;
  });
  expect(created).toBe(40);

  // WeakRef targets stay alive through the current JS job. Let snapshot
  // hydration microtasks finish before asking Chromium to collect them.
  await page.evaluate(
    () => new Promise<void>(resolve => setTimeout(resolve, 0)),
  );
  const cdp = await page.context().newCDPSession(page);

  try {
    await expect
      .poll(async () => {
        await cdp.send('HeapProfiler.collectGarbage');

        return page.evaluate(
          () =>
            window.__resourceLoroLifecycle!.abandoned.filter(reference =>
              reference.deref(),
            ).length,
        );
      })
      .toBe(0);

    const retained = await page.evaluate(() => {
      const fixture = window.__resourceLoroLifecycle!;
      const name = 'https://atomicdata.dev/properties/name';
      const nameBefore = fixture.held.get(name);
      fixture.document.getMap('properties').set(name, 'Still usable after GC');
      fixture.document.commit();

      return {
        before: nameBefore,
        after: fixture.document.getMap('properties').get(name),
        sameDocument: fixture.document === fixture.held.getLoroDoc(),
      };
    });
    expect(retained).toEqual({
      before: 'Synthetic checklist item',
      after: 'Still usable after GC',
      sameDocument: true,
    });
    await page.evaluate(() => {
      delete window.__resourceLoroLifecycle;
    });
  } finally {
    await cdp.detach();
  }
});
