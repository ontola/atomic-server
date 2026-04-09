import { describe, it, beforeEach } from 'vitest';
import { Agent, Store, core, JSCryptoProvider } from './index.js';

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
});
