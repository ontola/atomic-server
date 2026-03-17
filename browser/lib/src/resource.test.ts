import { describe, it } from 'vitest';
import { normalizeLoroChangeTimestampMs, Resource } from './resource.js';

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
      .filter((c): c is Record<string, unknown> => c !== undefined);

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
