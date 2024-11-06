import { core, dataBrowser, Store, type DataBrowser } from '@tomic/lib';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushSync, getContext } from 'svelte';
import { getResource } from '../index.js';
import { ATOMIC_STORE_CONTEXT_KEY, getStoreFromContext } from './store.js';

const resource1Subject = 'https://resource1';

// We need to mock getContext because normally you can't use it outside of a Svelte component scope.
vi.mock('svelte', () => ({
  getContext: vi.fn(),
}));

describe('getResource', () => {
  beforeEach(() => {
    const store = new Store();
    // @ts-expect-error getContext is mocked
    getContext.mockReturnValue({ [ATOMIC_STORE_CONTEXT_KEY]: store });
  });

  it('should get a resource from the store', async () => {
    const cleanup = $effect.root(() => {
      const store = getStoreFromContext();
      store.newResource({
        subject: resource1Subject,
        isA: dataBrowser.classes.folder,
        propVals: {
          [core.properties.name]: 'Resource 1',
        },
      });
      const resource = getResource<DataBrowser.Folder>(resource1Subject);

      expect(resource).not.toBe(undefined);
      expect(resource.subject).toBe(resource1Subject);
      expect(resource.props.name).toBe('Resource 1');
    });

    cleanup();
  });

  it('should update when the resource changes', async () => {
    const cleanup = $effect.root(() => {
      const store = getStoreFromContext();
      console.log(store);
      store.newResource({
        subject: resource1Subject,
        isA: dataBrowser.classes.folder,
      });

      const resource1 = getResource<DataBrowser.Folder>(resource1Subject);
      const resource2 = getResource<DataBrowser.Folder>(resource1Subject);

      expect(resource1.props.name).toBe(undefined);

      resource1.props.name = 'Resource with a name';

      flushSync();

      expect(resource2.props.name).toBe('Resource with a name');
    });

    cleanup();
  });
});
