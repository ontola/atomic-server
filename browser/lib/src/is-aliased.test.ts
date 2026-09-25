import { beforeAll, describe, it } from 'vitest';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { LoroLoader } from './loro-loader.js';
import { Resource } from './resource.js';

/**
 * A view that renders a collection needs to tell apart the two reasons the
 * collection can grow: one of its own drafts materialising, or a resource
 * arriving from a peer or another tab. The table got this wrong in one
 * direction — it assumed all growth was its own — and rows from a paired node
 * were in the store, complete, and never drawn.
 */

beforeAll(async () => {
  await LoroLoader.initializeLoro();
});

async function makeStore(): Promise<Store> {
  const store = new Store({ serverUrl: 'https://example.com' });
  const keys = await Agent.generateKeyPair();
  store.setAgent(
    new Agent(
      new JSCryptoProvider(keys.privateKey),
      `did:ad:agent:${keys.publicKey}`,
    ),
  );

  return store;
}

describe('isAliased tells a materialised draft from a stranger', () => {
  it('is false for a placeholder that has not been persisted', async ({
    expect,
  }) => {
    const store = await makeStore();

    expect(store.isAliased('_new:draftA')).toBe(false);
  });

  it('is true once the placeholder has been aliased to a real subject', async ({
    expect,
  }) => {
    const store = await makeStore();
    const real = 'did:ad:realSubjectForTheDraftAAAAAAAAAAAAAAAAAAAA==';
    const resource = new Resource(real);
    resource.setStore(store);

    store.addResource(resource, { alias: '_new:draftA' });

    expect(store.isAliased('_new:draftA')).toBe(true);
  });

  it('is false for a subject that simply arrived from elsewhere', async ({
    expect,
  }) => {
    const store = await makeStore();
    const fromPeer = 'did:ad:rowThatArrivedFromAPeerAAAAAAAAAAAAAAAAAA==';
    const resource = new Resource(fromPeer);
    resource.setStore(store);

    // No alias: nothing in this session stood in for it. This is the case the
    // table has to notice, because it is the one that must raise the row count.
    store.addResource(resource);

    expect(store.isAliased(fromPeer)).toBe(false);
  });
});
