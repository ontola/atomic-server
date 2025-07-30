import { describe, it, beforeEach } from 'vitest';
import { Agent, Store, core, commits, JSCryptoProvider } from './index.js';

/** Creates a fresh Store with the given agent, restoring any offline data. */
function freshStore(agent: Agent): Store {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setAgent(agent);
  store.restoreOfflineResources();

  return store;
}

describe('Offline persistence across reloads', () => {
  let agent: Agent;

  beforeEach(async () => {
    localStorage.clear();
    const keys = await Agent.generateKeyPair();
    const provider = new JSCryptoProvider(keys.privateKey);
    agent = new Agent(provider, `did:ad:agent:${keys.publicKey}`);
  });

  it('resource subject stays the same after reload + re-edit', async ({
    expect,
  }) => {
    // Session 1: create drive + doc, save offline
    const store1 = freshStore(agent);
    const drive = await store1.createDrive('Test Drive');
    expect(drive.get(core.properties.write)).toContain(agent.subject);

    const doc = await store1.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'My Doc' },
    });
    await doc.save();
    const subject = doc.subject;
    expect(subject).toMatch(/^did:ad:/);

    // Session 2: reload, edit, save
    const store2 = freshStore(agent);
    const doc2 = store2.getResourceLoading(subject);
    expect(doc2.get(core.properties.name)).toBe('My Doc');

    await doc2.set(core.properties.name, 'Updated', false);
    await doc2.save();
    expect(doc2.subject).toBe(subject);

    // Session 3: reload, verify latest edit persisted
    const store3 = freshStore(agent);
    const doc3 = store3.getResourceLoading(subject);
    expect(doc3.get(core.properties.name)).toBe('Updated');
  });

  it('multiple edits across reloads all persist', async ({ expect }) => {
    const store1 = freshStore(agent);
    const res = await store1.newResource({
      noParent: true,
      propVals: { [core.properties.name]: 'v1' },
    });
    await res.save();
    const subject = res.subject;

    for (const version of ['v2', 'v3', 'v4']) {
      const store = freshStore(agent);
      const r = store.getResourceLoading(subject);
      await r.set(core.properties.name, version, false);
      await r.save();
      expect(r.subject).toBe(subject);
    }

    const storeFinal = freshStore(agent);
    const rFinal = storeFinal.getResourceLoading(subject);
    expect(rFinal.get(core.properties.name)).toBe('v4');
  });

  it('offline save sets createdAt for sorting', async ({ expect }) => {
    const store = freshStore(agent);
    const drive = await store.createDrive('Timestamp Test');

    const child = await store.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'Test' },
    });
    await child.save();

    // createdAt should be set automatically by the offline save path
    const createdAt = child.get(commits.properties.createdAt);
    expect(createdAt).toBeDefined();
    expect(typeof createdAt).toBe('number');
    expect(createdAt).toBeGreaterThan(0);
  });

  it('children are sorted by name', async ({ expect }) => {
    const store = freshStore(agent);
    const drive = await store.createDrive('Sort Test');

    // Create 3 children — they'll be created in this order
    for (const name of ['Charlie', 'Alpha', 'Bravo']) {
      const child = await store.newResource({
        parent: drive.subject,
        propVals: { [core.properties.name]: name },
      });
      await child.save();
    }

    // Query children and sort like Collection does
    const children = store
      .clientSideQuery(
        r => r.get(core.properties.parent) === drive.subject,
      )
      .map(r => r.subject);

    // Sort ascending by name
    children.sort((a, b) => {
      const valA = store.resources.get(a)?.get(core.properties.name);
      const valB = store.resources.get(b)?.get(core.properties.name);

      if (valA == null && valB == null) return 0;
      if (valA == null) return 1;
      if (valB == null) return -1;

      return String(valA).localeCompare(String(valB));
    });

    const namesAsc = children.map(
      s => store.resources.get(s)?.get(core.properties.name),
    );
    expect(namesAsc).toEqual(['Alpha', 'Bravo', 'Charlie']);

    // Sort descending by name
    children.sort((a, b) => {
      const valA = store.resources.get(a)?.get(core.properties.name);
      const valB = store.resources.get(b)?.get(core.properties.name);

      if (valA == null && valB == null) return 0;
      if (valA == null) return 1;
      if (valB == null) return -1;

      return -String(valA).localeCompare(String(valB));
    });

    const namesDesc = children.map(
      s => store.resources.get(s)?.get(core.properties.name),
    );
    expect(namesDesc).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });
});
