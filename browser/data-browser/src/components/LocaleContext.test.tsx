// @vitest-environment jsdom
// @wc-ignore-file
import React, { useEffect } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const loads: Array<{ locale: string; resolve: () => void }> = [];

vi.mock('wuchale/load-utils', () => ({
  loadLocale: (locale: string) =>
    new Promise<void>(resolve => {
      loads.push({ locale, resolve });
    }),
}));

const { LocaleProvider, useLocale } = await import('./LocaleContext');

beforeEach(() => {
  loads.length = 0;
  // An in-memory store: some Node versions leave jsdom's `localStorage`
  // undefined, and the locale choice is all this provider keeps there.
  const items = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
      clear: () => items.clear(),
    },
  });
});

afterEach(cleanup);

/**
 * #1799: `/app/dev-drive` showed a `[i18n-404:658]` toast. The app mounted
 * before its catalog loaded, the dev-drive route's mount effect started
 * creating the agent right away, and the toast it raised a second later was
 * built from that first mount, against the empty catalog. The app then
 * remounted when the catalog arrived (#1645). Nothing under the provider may
 * mount before the catalog is in, and it mounts once.
 */
it('mounts the app once, after the catalog has loaded', async () => {
  const mounts: string[] = [];

  const Child = () => {
    useEffect(() => {
      mounts.push('mount');
    }, []);

    return <p>app</p>;
  };

  const { queryByText } = render(
    <LocaleProvider>
      <Child />
    </LocaleProvider>,
  );

  expect(loads).toHaveLength(1);
  expect(queryByText('app')).toBeNull();
  expect(mounts).toEqual([]);

  await act(async () => loads[0].resolve());

  expect(queryByText('app')).not.toBeNull();
  expect(mounts).toEqual(['mount']);
});

it('keeps the app up while switching locale, then remounts once', async () => {
  const mounts: string[] = [];
  const switchTo: { current: (locale: string) => void } = {
    current: () => undefined,
  };

  const Child = () => {
    const { setLocale } = useLocale();

    useEffect(() => {
      switchTo.current = setLocale;
    }, [setLocale]);

    useEffect(() => {
      mounts.push('mount');
    }, []);

    return <p>app</p>;
  };

  const { queryByText } = render(
    <LocaleProvider>
      <Child />
    </LocaleProvider>,
  );

  await act(async () => loads[0].resolve());
  expect(mounts).toEqual(['mount']);

  act(() => switchTo.current('fr'));

  expect(loads.at(-1)?.locale).toBe('fr');
  expect(queryByText('app')).not.toBeNull();
  expect(mounts).toEqual(['mount']);

  await act(async () => loads.at(-1)!.resolve());

  expect(queryByText('app')).not.toBeNull();
  expect(mounts).toEqual(['mount', 'mount']);
});

it('still renders the app when the catalog fails to load', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.doMock('wuchale/load-utils', () => ({
    loadLocale: () => Promise.reject(new Error('offline')),
  }));
  vi.resetModules();
  const { LocaleProvider: Provider } = await import('./LocaleContext');

  const { findByText } = render(
    <Provider>
      <p>app</p>
    </Provider>,
  );

  expect(await findByText('app')).not.toBeNull();
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});
