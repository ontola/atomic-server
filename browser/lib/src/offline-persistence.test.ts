import { describe, it, beforeEach } from 'vitest';
import { Agent, Store, core, commits, JSCryptoProvider } from './index.js';

/** Creates a fresh Store with the given agent. */
function freshStore(agent: Agent): Store {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setAgent(agent);

  return store;
}

describe('Offline persistence', () => {
  let agent: Agent;

  beforeEach(async () => {
    const keys = await Agent.generateKeyPair();
    const provider = new JSCryptoProvider(keys.privateKey);
    agent = new Agent(provider, `did:ad:agent:${keys.publicKey}`);
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
