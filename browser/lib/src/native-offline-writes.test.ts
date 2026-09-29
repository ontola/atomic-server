import { expect, it } from 'vitest';
import { core } from './index.js';
import { testStore } from './test-store.js';

it('refuses a native save when the node is disconnected and no local DB exists', async () => {
  const { store, posted } = await testStore({ requireOnlineWrites: true });
  const resource = await store.newResource({
    noParent: true,
    propVals: { [core.properties.name]: 'Must reach the node' },
  });
  store.setServerConnected(false);

  await expect(resource.save()).rejects.toThrow(
    'The local node is not connected; this change was not saved.',
  );
  expect(posted).toHaveLength(0);
  expect(store.outbox.hasPending(resource.subject)).toBe(false);
});
