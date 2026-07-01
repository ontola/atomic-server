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

  it('getCreatedAt / getCreatedBy read the genesis change, surviving a snapshot round-trip', async ({
    expect,
  }) => {
    const subject = 'https://example.com/created-test';
    const description = 'https://atomicdata.dev/properties/description';
    // `signChanges` writes the signing agent's subject into the genesis Loro
    // change message; mirror that here with an explicit commit message.
    const agentSubject = 'did:ad:agent:testpubkey';
    // Millisecond-precise genesis timestamp (what the runtime stamps via
    // `Date.now()`), so `createdAt` is sub-second precise — not rounded to a
    // whole second by Loro's default auto-record.
    const createdAtMs = 1_700_000_123_456;

    const original = new Resource(subject);
    await original.set(description, 'hello', false);
    original
      .getLoroDoc()!
      .commit({ message: agentSubject, timestamp: createdAtMs });

    expect(original.getCreatedBy()).toBe(agentSubject);
    expect(original.getCreatedAt()).toBe(createdAtMs);

    // Simulate a refresh: hydrate a fresh Resource from the exported snapshot.
    // Creator + timestamp must come back from the oplog alone — no commit fetch.
    const snapshot = original.getLoroDoc()!.export({ mode: 'snapshot' });
    const reloaded = new Resource(subject);
    reloaded.importLoroUpdate(snapshot);

    expect(reloaded.getCreatedBy()).toBe(agentSubject);
    expect(reloaded.getCreatedAt()).toBe(createdAtMs);
  });

  it('getCreatedBy is undefined when the genesis change carries no message', async ({
    expect,
  }) => {
    const resource = new Resource('https://example.com/no-creator');
    await resource.set(
      'https://atomicdata.dev/properties/description',
      'x',
      false,
    );
    resource.getLoroDoc()!.commit();

    expect(resource.getCreatedBy()).toBeUndefined();
  });

  it('getCreatedAt / getCreatedBy prefer the materialized propval over the oplog', async ({
    expect,
  }) => {
    const resource = new Resource('https://example.com/propval-wins');
    await resource.set(
      'https://atomicdata.dev/properties/description',
      'hi',
      false,
    );
    // Oplog genesis carries one creator/time...
    resource
      .getLoroDoc()!
      .commit({ message: 'did:ad:agent:oplog', timestamp: 1_700_000_000_000 });
    // ...but the server/WASM-materialized propvals (as served in JSON-AD) are
    // authoritative and must win.
    await resource.set(
      'https://atomicdata.dev/properties/createdAt',
      1_700_000_999_999,
      false,
    );
    await resource.set(
      'https://atomicdata.dev/properties/createdBy',
      'did:ad:agent:materialized',
      false,
    );

    expect(resource.getCreatedAt()).toBe(1_700_000_999_999);
    expect(resource.getCreatedBy()).toBe('did:ad:agent:materialized');
  });

  it('merges remote state without dropping local unsaved loro edits', async ({
    expect,
  }) => {
    const subject = 'https://example.com/merge-test';
    const name = 'https://atomicdata.dev/properties/name';
    const description = 'https://atomicdata.dev/properties/description';

    const base = new Resource(subject);
    await base.set(name, 'Base', false);
    const baseSnapshot = base.getLoroDoc()!.export({
      mode: 'snapshot',
    });

    const local = new Resource(subject);
    local.importLoroUpdate(baseSnapshot);
    await local.set(description, 'Local unsaved edit', false);

    const remoteSource = new Resource(subject);
    remoteSource.importLoroUpdate(baseSnapshot);
    await remoteSource.set(name, 'Remote update', false);
    const remoteSnapshot = remoteSource.getLoroDoc()!.export({
      mode: 'snapshot',
    });

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
    const doc = resource.getLoroDoc()!;
    const peerBefore = doc.peerIdStr;
    const serverSnapshot = doc.export({ mode: 'snapshot' });

    resource.applyHydratedValues([[loroUpdate, serverSnapshot]]);

    const peerAfter = resource.getLoroDoc()!.peerIdStr;
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
  /**
   * Regression: tap-undo "didn't undo" because each save() wrote bookkeeping
   * commits to the Loro doc (datatype-tag mirroring, `lastCommit` pointer)
   * that the UndoManager faithfully recorded as undo steps. So the user's
   * first undo press silently reverted the *housekeeping* commit instead
   * of their last visible edit — the symptom is "Saving… shows, but the
   * stroke doesn't disappear". The fix tags those system commits with
   * `SYSTEM_COMMIT_ORIGIN` and excludes that prefix from the UndoManager.
   * One user-visible push = one undo step.
   */
  it('one push + save consumes exactly one undo step', async ({ expect }) => {
    const { Resource: ResourceClass } = await import('./resource.js');
    const r = new ResourceClass('https://example.com/one-undo');
    r.getLoroDoc();
    r.ensureUndoManager();

    const prop = 'https://atomicdata.dev/ontology/canvas/strokeData';
    r.pushListItem(prop, { color: 1, width: 2, path: [[0, 0]] });
    r.getLoroDoc()?.commit();

    // Mimic the housekeeping write that real `save()` performs on the
    // server ack — this is the exact call that previously polluted the
    // undo history with a phantom step. `writeDatatypeTags` would also
    // qualify but needs a store to read property definitions; this
    // setLastCommitValue path is enough to exercise the bug and the fix.
    r.setLastCommitValue('did:ad:commit:fake-server-ack');

    expect((r.get(prop) as unknown[]).length).toBe(1);
    expect(r.canUndo()).toBe(true);

    // Single undo press → stroke removed, no further undo available.
    expect(r.undo()).toBe(true);
    expect((r.get(prop) as unknown[] | undefined) ?? []).toHaveLength(0);
    expect(r.canUndo()).toBe(false);
  });

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

  /**
   * Regression: rapid typing across two tabs lost everything past the
   * first character. Root cause: import / merge paths called the old
   * `markLoroSaved`, which captured the doc's CURRENT oplog version.
   * When the sender's own WS echo arrived mid-typing, that snapshot
   * already included the in-progress local edits — so the cursor leapt
   * past unsigned ops, and the next `exportLoroDelta` emitted a 22-byte
   * empty-header frame. Imports must not advance the export cursor.
   */
  it('importLoroUpdate does not advance the export cursor past local edits', async ({
    expect,
  }) => {
    const name = 'https://atomicdata.dev/properties/name';
    const r = new Resource('https://example.com/sync-cursor');
    await r.set(name, 'a', false);
    const doc = r.getLoroDoc()!;
    doc.commit();

    // Mimic the cursor state after a successful sign of "a".
    const lvasAtSign = doc.oplogVersion();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any)._loroVersionAtLastSave = lvasAtSign;

    // User types another char before the echo lands.
    await r.set(name, 'ab', false);
    doc.commit();

    // Server echoes the first commit back. Bytes contain ops the doc
    // already has — Loro merges idempotently and the state is unchanged.
    const echoBytes = doc.export({ mode: 'update', from: lvasAtSign });
    void echoBytes; // not the echo body itself; we exercise the path:
    r.importLoroUpdate(doc.export({ mode: 'snapshot' }));

    // Cursor must still point at the post-sign-of-"a" version, NOT at
    // the doc's current version (which includes the unsigned "b" op).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lvasAfterEcho = (r as any)._loroVersionAtLastSave;
    expect(lvasAfterEcho.encode()).toEqual(lvasAtSign.encode());

    // The next export from that cursor must carry the "b" op, not a
    // header-only no-op.
    const delta = doc.export({ mode: 'update', from: lvasAfterEcho });
    expect(delta.length).toBeGreaterThan(40);
  });
});

describe('Resource.merge Loro options', () => {
  it('replaceLoroDocs makes local state match remote state (drops local-only CRDT ops)', async ({
    expect,
  }) => {
    const subject = 'https://example.com/merge-loro-replace';
    const name = 'https://atomicdata.dev/properties/name';

    const local = new Resource(subject);
    await local.set(name, 'local-only', false);

    const remote = new Resource(subject);
    await remote.set(name, 'server', false);

    local.merge(remote, { replaceLoroDocs: true });

    expect(local.get(name)).toBe('server');
  });

  it('omitKeysFromMerge keeps local state and does not adopt remote state', async ({
    expect,
  }) => {
    const subject = 'https://example.com/merge-loro-omit';
    const name = 'https://atomicdata.dev/properties/name';

    const local = new Resource(subject);
    await local.set(name, 'baseline', false);

    const remote = new Resource(subject);
    await remote.set(name, 'live-with-ai', false);

    local.merge(remote, { omitKeysFromMerge: [name] });

    expect(local.get(name)).toBe('baseline');
  });
});
