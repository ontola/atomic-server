// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAccountProviders } from './accountProviders';
import { engageAccountService, hasManagedApi } from './api';
import { getAccountServiceUrl } from './cloudSync';
import { getManagedAccount, noteManagedSessionChanged } from './session';

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_MANAGED_PORTAL_URL', '');
  vi.stubEnv('VITE_DEFAULT_ACCOUNT_PORTAL', '');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ google: true }));
  noteManagedSessionChanged();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('knows the default service without contacting it', async () => {
  expect(getAccountServiceUrl()).toBe('https://atomic.place');
  expect(hasManagedApi()).toBe(false);

  // What page load asks for: nothing may leave the browser.
  expect(await getManagedAccount()).toBeNull();
  expect((await getAccountProviders()).google).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('contacts the service once a flow engages it', async () => {
  engageAccountService(getAccountServiceUrl());

  expect(hasManagedApi()).toBe(true);
  expect((await getAccountProviders()).google).toBe(true);
  expect(fetchMock.mock.calls[0][0]).toBe(
    'https://atomic.place/api/auth/providers',
  );
});
