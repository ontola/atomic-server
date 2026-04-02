import { describe, it } from 'vitest';
import { normalizeLoroChangeTimestampMs, Resource } from './resource.js';
import type { JSONValue } from './value.js';

describe('resource.ts', () => {
  it('push propvals', ({ expect }) => {
    const resource = new Resource('test');
    const testsubject = 'https://example.com/testsubject';
    resource.push(
      'https://atomicdata.dev/properties/subresources',
      [testsubject],
      true,
    );
    resource.push(
      'https://atomicdata.dev/properties/subresources',
      [testsubject],
      true,
    );

    expect(
      resource.get('https://atomicdata.dev/properties/subresources'),
    ).toStrictEqual([testsubject]);

    const testsubject2 = 'https://example.com/testsubject2';

    resource.push(
      'https://atomicdata.dev/properties/subresources',
      [testsubject2, testsubject2],
      true,
    );

    expect(
      resource.get('https://atomicdata.dev/properties/subresources'),
    ).toStrictEqual([testsubject, testsubject2]);

    resource.push('https://atomicdata.dev/properties/subresources', [
      testsubject,
      testsubject,
    ]);

    expect(
      resource.get('https://atomicdata.dev/properties/subresources'),
    ).toStrictEqual([testsubject, testsubject2, testsubject, testsubject]);
  });

  it('merges remote state without dropping local unsaved loro edits', async ({
    expect,
  }) => {
    const subject = 'https://example.com/merge-test';
    const name = 'https://atomicdata.dev/properties/name';
    const description = 'https://atomicdata.dev/properties/description';

    const base = new Resource(subject);
    await base.set(name, 'Base', false);
    const baseSnapshot = (base as any)._loroDoc.export({
      mode: 'snapshot',
    }) as Uint8Array;

    const local = new Resource(subject);
    local.importLoroUpdate(baseSnapshot);
    await local.set(description, 'Local unsaved edit', false);

    const remoteSource = new Resource(subject);
    remoteSource.importLoroUpdate(baseSnapshot);
    await remoteSource.set(name, 'Remote update', false);
    const remoteSnapshot = (remoteSource as any)._loroDoc.export({
      mode: 'snapshot',
    }) as Uint8Array;

    const remote = new Resource(subject);
    remote.importLoroUpdate(remoteSnapshot);

    local.merge(remote);

    expect(local.get(name)).toBe('Remote update');
    expect(local.get(description)).toBe('Local unsaved edit');
    expect(local.hasUnsavedChanges()).toBe(true);
  });

  /**
   * Regression: when JSON-AD arrives carrying a `loroUpdate` property after a
   * resource has a live Loro doc (e.g. after an unsaved local edit, or after
   * the user's own commit returns and a subsequent re-fetch happens), the
   * raw-value apply path used to tear the doc down. The next getLoroDoc()
   * would allocate a FRESH random peer whose ops were concurrent with
   * stored ops — Loro LWW silently dropped them. Now it must keep the
   * existing doc and merge the snapshot in.
   */
  it('normalizes Loro oplog timestamps in seconds or milliseconds', ({
    expect,
  }) => {
    expect(normalizeLoroChangeTimestampMs(1_700_000_000)).toBe(
      1_700_000_000_000,
    );
    expect(normalizeLoroChangeTimestampMs(1_700_000_000_000)).toBe(
      1_700_000_000_000,
    );
    expect(normalizeLoroChangeTimestampMs(0)).toBe(0);
  });

  it('records Loro oplog timestamps in seconds', async ({ expect }) => {
    const resource = new Resource('https://example.com/loro-timestamp');
    await resource.set('https://atomicdata.dev/properties/name', 'test', false);
    const doc = resource.getLoroDoc();
    expect(doc).toBeDefined();
    doc!.commit();

    const timestamps: number[] = [];
    for (const changes of doc!.getAllChanges().values()) {
      for (const change of changes) {
        if (change.timestamp > 0) {
          timestamps.push(change.timestamp);
        }
      }
    }

    expect(timestamps.length).toBeGreaterThan(0);
    for (const ts of timestamps) {
      expect(ts).toBeLessThan(1_000_000_000_000);
    }
  });

  it('keeps the same Loro peer across a loroUpdate hydration', async ({
    expect,
  }) => {
    const subject = 'https://example.com/peer-stability';
    const name = 'https://atomicdata.dev/properties/name';
    const loroUpdate = 'https://atomicdata.dev/properties/loroUpdate';

    const resource = new Resource(subject);
    await resource.set(name, '1', false);
    const peerBefore = (resource as any)._loroDoc.peerIdStr as string;
    const serverSnapshot = (resource as any)._loroDoc.export({
      mode: 'snapshot',
    }) as Uint8Array;

    (resource as any).applyRawValue(loroUpdate, serverSnapshot);

    const peerAfter = (resource as any)._loroDoc.peerIdStr as string;
    expect(peerAfter).toBe(peerBefore);
  });

  /**
   * `replaceListItems` underpins the canvas history-scrub commit: dragging
   * the undo button releases at a historical Version, and we need to swap
   * the live stroke list to that Version's strokes in **one** undo
   * checkpoint, with the same LoroList container identity preserved so
   * concurrent remote writes against the old list still merge correctly.
   */
  it('replaceListItems swaps a list atomically and keeps container identity', async ({
    expect,
  }) => {
    const subject = 'https://example.com/replace-list';
    const prop = 'https://atomicdata.dev/ontology/canvas/strokeData';

    const resource = new Resource(subject);
    resource.pushListItem(prop, { color: 1, width: 2, path: [[0, 0]] });
    resource.pushListItem(prop, { color: 3, width: 4, path: [[1, 1]] });

    const doc = resource.getLoroDoc()!;
    const map = doc.getMap('properties');
    const originalListId = (map.get(prop) as unknown as { id?: string })?.id;

    resource.replaceListItems(prop, [{ color: 9, width: 9, path: [[2, 2]] }]);

    const items = resource.get(prop) as Record<string, unknown>[] | undefined;
    expect(items ?? []).toHaveLength(1);
    expect(items?.[0]?.color).toBe(9);

    // Same LoroList container — identity preserved so any concurrent
    // remote writes against the old container ID still target this one.
    const newListId = (
      doc.getMap('properties').get(prop) as unknown as { id?: string }
    )?.id;
    expect(newListId).toBe(originalListId);
  });

  /**
   * Regression: tapping undo on the canvas showed "Saving…" but the strokes
   * didn't visually update. Cause: `Resource.undo()` modified the Loro doc
   * and cache but never fired `LocalChange`, so React consumers stayed on
   * the pre-undo cache. `undo()` / `redo()` must emit a wildcard
   * `LocalChange` so listeners reload from the cache.
   */
  it('undo and redo emit a LocalChange event so UI re-reads', async ({
    expect,
  }) => {
    const { Resource: ResourceClass, ResourceEvents } =
      await import('./resource.js');
    const r = new ResourceClass('https://example.com/undo-event');
    // Materialise the Loro doc, then create the UndoManager so it observes
    // subsequent ops as undoable checkpoints (mirrors how CanvasPage wires
    // it up: `ensureUndoManager()` runs once the resource is loaded, then
    // user input produces undoable ops).
    r.getLoroDoc();
    r.ensureUndoManager();
    await r.set('https://atomicdata.dev/properties/name', 'two', false);
    // Force the doc to commit the pending op so the UndoManager records a
    // checkpoint. In real use this happens via pushListItem/save.
    r.getLoroDoc()?.commit();

    const undoEvents: unknown[] = [];
    const off = r.on(ResourceEvents.LocalChange, (prop, value) =>
      undoEvents.push({ prop, value }),
    );

    expect(r.undo()).toBe(true);
    expect(undoEvents.length).toBeGreaterThan(0);

    off();

    const redoEvents: unknown[] = [];
    const off2 = r.on(ResourceEvents.LocalChange, (prop, value) =>
      redoEvents.push({ prop, value }),
    );
    expect(r.redo()).toBe(true);
    expect(redoEvents.length).toBeGreaterThan(0);
    off2();
  });

  /**
   * Regression: the resource history page used to read only `getMap('properties')`,
   * so a Document's body content (which loro-prosemirror writes into a separate
   * top-level `doc` container) never showed up — only title/metadata edits did.
   * `getLoroHistory()` must surface every top-level container besides
   * `properties` in `Version.containers`.
   */
  it('captures body container content in version history', async ({
    expect,
  }) => {
    const subject = 'https://example.com/loro-history-doc';
    const name = 'https://atomicdata.dev/properties/name';

    const resource = new Resource(subject);
    await resource.set(name, 'Initial title', false);
    const doc = resource.getLoroDoc()!;
    doc.commit();

    // Simulate what loro-prosemirror does for Document bodies: write to a
    // top-level `doc` map, not the `properties` map.
    const docMap = doc.getMap('doc');
    docMap.set('content', 'Hello world body');
    doc.commit();

    await resource.set(name, 'Updated title', false);
    doc.commit();

    const history = resource.getLoroHistory();
    expect(history.length).toBeGreaterThan(0);

    // Every Version exposes `containers`, and at least one must carry the
    // body content we wrote into `doc`.
    for (const v of history) {
      expect(v.containers).toBeInstanceOf(Map);
    }

    const docContents = history
      .map(v => v.containers.get('doc'))
      .filter((c): c is Record<string, JSONValue> => c !== undefined);

    expect(docContents.length).toBeGreaterThan(0);
    expect(
      docContents.some(
        c => (c as Record<string, unknown>).content === 'Hello world body',
      ),
    ).toBe(true);

    // Sanity: the `properties` root must NOT leak into containers — it's
    // already exposed as propvals and would double-render in the UI.
    for (const v of history) {
      expect(v.containers.has('properties')).toBe(false);
    }
  });
});
