import { describe, it, expect, vi } from 'vitest';
import { Store } from './store.js';
import { Resource } from './resource.js';
import { enableLoro, LoroLoader } from './loro-loader.js';
import { core } from './ontologies/core.js';
import { Datatype } from './datatypes.js';
import { testStore } from './test-store.js';
import type { Commit } from './commit.js';

// #1794: the JSON value editor (`InputJSON`) parses its text and calls
// `set(prop, object)`. The object lands in Loro as a JSON string, and the
// `datatypes` tag that says "parse me" was only written when the save drained.
// Every read in between — the editor's own re-render, the calendar view —
// got the JSON *string* back instead of the object.

const RECURRENCE = 'https://example.com/properties/recurrence';
const NOTE = 'https://example.com/properties/note';

async function addProperty(store: Store, subject: string, datatype: Datatype) {
  const property = new Resource(subject);
  store.addResource(property);
  await property.set(core.properties.datatype, datatype, false);
  await property.set(core.properties.shortname, 'prop', false);
  await property.set(core.properties.description, 'test', false);
}

describe('JSON property values (#1794)', () => {
  it('a validated set() reads back as an object before the save drains', async () => {
    const { store } = await testStore();
    await addProperty(store, RECURRENCE, Datatype.JSON);
    vi.mocked(store.getProperty).mockResolvedValue({
      subject: RECURRENCE,
      datatype: Datatype.JSON,
      shortname: 'recurrence',
      description: 'test',
    });
    const row = await store.newResource({
      propVals: { [core.properties.name]: 'design review' },
      noParent: true,
    });

    await row.set(RECURRENCE, { weekly: true });

    expect(row.get(RECURRENCE)).toEqual({ weekly: true });
  });

  it('an unvalidated set() reads back as an object when the Property is cached', async () => {
    const { store } = await testStore();
    await addProperty(store, RECURRENCE, Datatype.JSON);
    const row = await store.newResource({
      propVals: { [core.properties.name]: 'design review' },
      noParent: true,
    });

    await row.set(RECURRENCE, { weekly: true }, false);

    expect(row.get(RECURRENCE)).toEqual({ weekly: true });
  });

  it('survives save and a fresh read of the committed Loro doc', async () => {
    const { store, postCommitSpy } = await testStore();
    await addProperty(store, RECURRENCE, Datatype.JSON);
    const row = await store.newResource({
      propVals: { [core.properties.name]: 'design review' },
      noParent: true,
    });
    await row.set(RECURRENCE, { weekly: true }, false);
    expect(await row.save()).toBe('persisted');

    // What the server and every other client see: the committed bytes,
    // without the writer's in-memory cache.
    const { LoroDoc } = LoroLoader.Loro;
    const server = new LoroDoc();

    for (const [commit] of postCommitSpy.mock.calls) {
      server.import((commit as Commit).loroUpdate!);
    }

    expect(server.getMap('datatypes').get(RECURRENCE)).toBe('json');
    const received = new Resource('did:ad:received');
    received.importLoroUpdate(server.export({ mode: 'snapshot' }), true);

    expect(received.get(RECURRENCE)).toEqual({ weekly: true });
  });

  it('reads a legacy string-wrapped JSON value as the object it encodes', async () => {
    await enableLoro();
    const { LoroDoc } = LoroLoader.Loro;
    const doc = new LoroDoc();
    // What a double encode leaves behind: the Loro string is itself a JSON
    // string literal whose content is the object.
    doc
      .getMap('properties')
      .set(RECURRENCE, JSON.stringify(JSON.stringify({ weekly: true })));
    doc.getMap('datatypes').set(RECURRENCE, 'json');
    doc.commit();

    const resource = new Resource('did:ad:legacy');
    resource.importLoroUpdate(doc.export({ mode: 'snapshot' }), true);

    expect(resource.get(RECURRENCE)).toEqual({ weekly: true });
  });

  it('reads an untagged legacy object as an object when the Property is JSON', async () => {
    await enableLoro();
    const store = new Store();
    await addProperty(store, RECURRENCE, Datatype.JSON);
    await addProperty(store, NOTE, Datatype.STRING);
    const { LoroDoc } = LoroLoader.Loro;
    const doc = new LoroDoc();
    doc.getMap('properties').set(RECURRENCE, '{"weekly":true}');
    doc.getMap('properties').set(NOTE, '{"weekly":true}');
    doc.commit();

    const resource = new Resource('did:ad:untagged');
    store.addResource(resource);
    resource.importLoroUpdate(doc.export({ mode: 'snapshot' }), true);

    expect(resource.get(RECURRENCE)).toEqual({ weekly: true });
    // A plain string that merely looks like JSON stays a string.
    expect(resource.get(NOTE)).toBe('{"weekly":true}');
  });

  it('keeps a JSON property holding a plain string a string', async () => {
    await enableLoro();
    const { LoroDoc } = LoroLoader.Loro;
    const doc = new LoroDoc();
    doc.getMap('properties').set(RECURRENCE, JSON.stringify('just text'));
    doc.getMap('datatypes').set(RECURRENCE, 'json');
    doc.commit();

    const resource = new Resource('did:ad:plain');
    resource.importLoroUpdate(doc.export({ mode: 'snapshot' }), true);

    expect(resource.get(RECURRENCE)).toBe('"just text"');
  });
});
