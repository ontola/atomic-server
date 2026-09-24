import { expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { core } from './ontologies/core.js';
import type { ClientDbWorker } from './client-db.js';

it('reads a foreign HTTP resource without waiting for the local database to initialize', async () => {
  const store = new Store({
    serverUrl: 'https://app.example.com',
    connect: false,
  });
  let release!: () => void;
  const initializing = new Promise<void>(resolve => {
    release = resolve;
  });
  store.setClientDb({
    isReady: true,
    waitForInit: () => initializing,
    putResourceWithSnapshot: async () => {},
  } as unknown as ClientDbWorker);
  const subject = 'https://old.example.com/drive/private';
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          '@id': subject,
          [core.properties.name]: 'Old drive',
        }),
      ),
  );
  store.injectFetch(fetch);
  const loading = store.getResource(subject);

  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const resource = await loading;
    expect(resource.subject).toBe(subject);
    expect(resource.get(core.properties.name)).toBe('Old drive');
  } finally {
    release();
    await loading;
  }
});
