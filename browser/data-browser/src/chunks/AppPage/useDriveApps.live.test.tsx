// @vitest-environment jsdom
// @wc-ignore-file
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StoreContext } from '@tomic/react';
import { Resource, Store, commits, core } from '@tomic/lib';
import { appsForClass, useDriveApps } from './useDriveApps';

/**
 * #1846: the "+ Add view" menu read the drive's apps once, when the table page
 * mounted. An app installed in another tab, or synced in a moment after
 * navigating, stayed missing until a reload.
 */
const DRIVE = 'atomic:resource:drive';
const APP_CLASS = 'atomic:resource:class-app';
const RENDERS = 'atomic:resource:prop-renders';
const INVOICES = 'atomic:resource:class-invoice';
const EVENTS = 'atomic:resource:class-event';
const LEDGER = 'atomic:resource:ledger';
const CALENDAR = 'atomic:resource:calendar';

vi.mock('@chunks/PluginRuns/runScript', () => ({
  useAppClass: () => APP_CLASS,
}));

vi.mock('@tomic/lib', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/lib')>()),
  findSchema: async () => ({ properties: { renders: RENDERS } }),
}));

const appJsonAd = (subject: string, name: string, renders: string[]) =>
  JSON.stringify({
    '@id': subject,
    [core.properties.parent]: DRIVE,
    [core.properties.isA]: [APP_CLASS],
    [core.properties.name]: name,
    [RENDERS]: renders,
    [commits.properties.createdAt]: 1000,
  });

/** A store whose app query knows only the ledger, as it did at mount. */
function storeWithLedger() {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setDrive(DRIVE);
  store.finishDriveSync(DRIVE, 1, Date.now());

  store.setClientDb({
    isReady: true,
    waitForReady: async () => true,
    waitForInit: async () => true,
    query: async () => ({
      subjects: [LEDGER],
      resources: [appJsonAd(LEDGER, 'Ledger', [INVOICES])],
      count: 1,
    }),
    flush: async () => undefined,
    putResourceWithSnapshot: async () => undefined,
    removeResource: async () => undefined,
  } as unknown as Parameters<Store['setClientDb']>[0]);

  return store;
}

/** What a sync or another tab's commit does: a resource lands in the store. */
async function arrive(
  store: Store,
  subject: string,
  name: string,
  renders: string[],
) {
  const fresh = new Resource(subject);
  await fresh.set(core.properties.isA, [APP_CLASS], false);
  await fresh.set(core.properties.name, name, false);
  await fresh.set(RENDERS, renders, false);
  // A change carries a commit the store has not seen; same-commit copies are
  // dropped as replays.
  fresh.setLastCommitValue(`did:ad:commit:${name}-${renders.join('+')}`);
  store.addResource(fresh);
}

const wrapper = (store: Store) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      StoreContext.Provider,
      { value: store },
      children,
    );
  };

const names = (apps: { name: string }[]) => apps.map(a => a.name).sort();

describe('the drive apps a table offers stay live', () => {
  it('includes an app that arrives after the hook mounted', async () => {
    const store = storeWithLedger();
    const { result } = renderHook(() => useDriveApps(DRIVE), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(names(result.current)).toEqual(['Ledger']));

    await act(() => arrive(store, CALENDAR, 'Calendar', [EVENTS]));

    await waitFor(() =>
      expect(names(result.current)).toEqual(['Calendar', 'Ledger']),
    );
    expect(names(appsForClass(result.current, EVENTS))).toEqual(['Calendar']);
  });

  it('offers an app on a table once its renders changes to that class', async () => {
    const store = storeWithLedger();
    const { result } = renderHook(() => useDriveApps(DRIVE), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(names(result.current)).toEqual(['Ledger']));
    expect(appsForClass(result.current, EVENTS)).toEqual([]);

    await act(() => arrive(store, LEDGER, 'Ledger', [INVOICES, EVENTS]));

    await waitFor(() =>
      expect(names(appsForClass(result.current, EVENTS))).toEqual(['Ledger']),
    );
  });

  it('drops an app that is removed', async () => {
    const store = storeWithLedger();
    const { result } = renderHook(() => useDriveApps(DRIVE), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(names(result.current)).toEqual(['Ledger']));

    act(() => store.removeResource(LEDGER));

    await waitFor(() => expect(result.current).toEqual([]));
  });
});
