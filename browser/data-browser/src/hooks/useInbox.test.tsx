// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { core, server, Store, StoreContext } from '@tomic/react';
import { useInbox } from './useInbox';

let privateDrive: string | undefined;
vi.mock('./usePrivateDrive', () => ({
  usePrivateDrive: () => ({ privateDrive, loading: false }),
}));

describe('inbox live sync outside the active workspace', () => {
  it('holds the personal drive subscription and releases it on identity change', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    store.setDrive('atomic:project');
    store.setClientDb({
      isReady: true,
      query: async () => ({ subjects: [], resources: [], count: 0 }),
      flush: async () => undefined,
    } as unknown as Parameters<Store['setClientDb']>[0]);
    privateDrive = 'atomic:personal';

    for (const subject of ['atomic:personal', 'atomic:other-person']) {
      store.hydrateResourceFromJsonAd(
        subject,
        JSON.stringify({
          '@id': subject,
          [core.properties.isA]: [server.classes.drive],
        }),
      );
    }

    store.finishDriveSync(privateDrive, 1, Date.now());
    const unsubscribe = vi.fn();
    const subscribe = vi
      .spyOn(store, 'subscribeLive')
      .mockReturnValue(unsubscribe);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(StoreContext.Provider, { value: store }, children);
    const { rerender, unmount } = renderHook(() => useInbox(), { wrapper });

    await waitFor(() =>
      expect(subscribe).toHaveBeenCalledWith('atomic:personal'),
    );
    expect(subscribe).not.toHaveBeenCalledWith('atomic:project');

    privateDrive = 'atomic:other-person';
    store.finishDriveSync(privateDrive, 1, Date.now());
    rerender();
    await waitFor(() => expect(subscribe).toHaveBeenCalledWith(privateDrive));
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    privateDrive = undefined;
    rerender();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
