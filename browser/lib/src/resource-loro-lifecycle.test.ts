import { describe, expect, it, vi } from 'vitest';
import { queryObjects } from 'node:v8';
import { Resource } from './resource.js';
import type { Store } from './store.js';
import { core } from './ontologies/core.js';
import { LoroLoader } from './loro-loader.js';

const NAME = core.properties.name;
const SUBJECT = 'https://example.com/loro-lifecycle';

function trackedResource() {
  const markDirty = vi.fn();
  const resource = new Resource(SUBJECT);
  resource.setStore({
    canCommit: true,
    getServerUrl: () => 'https://example.com',
    outbox: { hasPending: () => false, markDirty },
    isOwnedSubject: () => true,
    isLocalOnlySubject: () => false,
  } as unknown as Store);

  return { resource, markDirty };
}

function replacementSnapshot(): Uint8Array {
  const doc = new LoroLoader.Loro.LoroDoc();
  doc.getMap('properties').set(NAME, 'Server state');
  doc.commit();

  return doc.export({ mode: 'snapshot' });
}

describe('Resource Loro lifecycle', () => {
  it('allows abandoned hydrated Resources to be garbage collected', async () => {
    const before = queryObjects(Resource, { format: 'count' });

    // A query/fetch can materialize an incoming Resource, merge its snapshot
    // into an existing one, then discard it without an explicit reset.
    function hydrateTemporaryResources(snapshot: Uint8Array) {
      for (let i = 0; i < 20; i++) {
        const resource = new Resource(`https://example.com/temporary-${i}`);
        resource.importLoroUpdate(snapshot, true);
        resource.getLoroDoc();
      }
    }

    hydrateTemporaryResources(replacementSnapshot());
    // queryObjects performs a full GC. Cross a job boundary first so a
    // dereferenced WeakRef's per-job keepalive cannot mask collection.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(queryObjects(Resource, { format: 'count' })).toBe(before);
  });

  it('stops a cleared document from queuing edits for its replacement', () => {
    const { resource, markDirty } = trackedResource();
    const retired = resource.getLoroDoc()!;
    resource.clearUnsafe();

    // Editors can retain the previously returned public document. It remains
    // usable, but its commits no longer belong to this Resource's live state.
    retired.getMap('properties').set(NAME, 'Retired editor');
    retired.commit();
    expect(retired.getMap('properties').get(NAME)).toBe('Retired editor');
    expect(markDirty).not.toHaveBeenCalled();

    const current = resource.getLoroDoc()!;
    expect(current).not.toBe(retired);
    current.getMap('properties').set(NAME, 'Current editor');
    current.commit();
    expect(markDirty).toHaveBeenCalledExactlyOnceWith(SUBJECT);
  });

  it('detaches the retired document after an authoritative snapshot replacement', () => {
    const { resource, markDirty } = trackedResource();
    const retired = resource.getLoroDoc()!;
    expect(resource.importLoroUpdate(replacementSnapshot(), true)).toEqual({
      complete: true,
    });
    expect(resource.get(NAME)).toBe('Server state');
    markDirty.mockClear();

    retired.getMap('properties').set(NAME, 'Stale editor update');
    retired.commit();
    expect(markDirty).not.toHaveBeenCalled();
    expect(resource.get(NAME)).toBe('Server state');

    resource.getLoroDoc()!.getMap('properties').set(NAME, 'New editor update');
    resource.getLoroDoc()!.commit();
    expect(markDirty).toHaveBeenCalledExactlyOnceWith(SUBJECT);
  });
});
