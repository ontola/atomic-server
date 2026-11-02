import { renderHook, waitFor } from '@testing-library/react';
import { Store, type ClientDbWorker } from '@tomic/lib';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { StoreContext } from './hooks.js';
import { useCollection } from './useCollection.js';

const PRIVATE_DRIVE = 'did:ad:private-drive';
const query = {
  property: 'https://atomicdata.dev/properties/isA',
  value: 'https://atomicdata.dev/classes/Notification',
};

describe('useCollection', () => {
  // The private drive is known a moment after the first render (it is derived
  // from the agent key). A list built for "no drive" fell back to whichever
  // drive was open and was never rebuilt, so the Notifications list stayed
  // empty while another drive was open.
  it('queries the new drive when the drive of the query changes', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    store.setClientDb({
      isReady: true,
      waitForReady: async () => true,
      query: async () => ({ subjects: [], resources: [], count: 0 }),
    } as unknown as ClientDbWorker);
    // Offline: no socket to wait for.
    store.waitForServerConnected = async () => false;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StoreContext.Provider, { value: store }, children);

    const { result, rerender } = renderHook(
      ({ drive }: { drive?: string }) => useCollection({ ...query, drive }),
      { wrapper, initialProps: { drive: undefined } as { drive?: string } },
    );

    expect(result.current.collection.drive).toBeUndefined();

    rerender({ drive: PRIVATE_DRIVE });

    await waitFor(() =>
      expect(result.current.collection.drive).toBe(PRIVATE_DRIVE),
    );
  });
});
