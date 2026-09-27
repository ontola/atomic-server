// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';

const state = vi.hoisted(() => ({
  providers: {
    google: true,
    apple: true,
    github: false,
    assisted_recovery: false,
  },
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('../../helpers/managed/accountProviders', async original => ({
  ...(await original<
    typeof import('../../helpers/managed/accountProviders')
  >()),
  getAccountProviders: async () => state.providers,
}));
vi.mock('../../helpers/managed/deviceLink', () => ({
  approvalUrl: (portal: string, code: string) => `${portal}/link?code=${code}`,
  awaitDeviceLink: () => new Promise(() => undefined),
  requestDeviceLink: async () => ({ user_code: 'ABCD-EFGH' }),
}));
vi.mock('../../helpers/openExternal', () => ({
  openExternal: state.openExternal,
}));

import {
  AccountSignInPanel,
  AccountSignInViaBrowser,
} from './AccountSignInPanel';

afterEach(cleanup);

const PORTAL = 'https://portal.example';

async function show(ui: React.ReactElement) {
  await act(async () => {
    render(
      <ThemeProvider theme={buildTheme(false, '#336699', false)}>
        {ui}
      </ThemeProvider>,
    );
  });
}

it('offers each provider the account service has, and only those', async () => {
  await show(<AccountSignInPanel portalUrl={PORTAL} onSignedIn={vi.fn()} />);

  const apple = screen.getByRole('link', { name: 'Apple' });
  const start = new URL(apple.getAttribute('href')!);
  expect(start.origin + start.pathname).toBe(`${PORTAL}/api/auth/apple/start`);
  expect(start.searchParams.get('next')).toBe(window.location.href);
  expect(screen.getByRole('link', { name: 'Google' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'GitHub' })).toBeNull();
});

it('opens a provider in the system browser from an app window', async () => {
  state.providers = { ...state.providers, github: true };
  await show(
    <AccountSignInViaBrowser portalUrl={PORTAL} onSignedIn={vi.fn()} />,
  );

  await act(async () => {
    screen.getByRole('button', { name: 'GitHub' }).click();
  });

  expect(state.openExternal).toHaveBeenCalledWith(
    `${PORTAL}/link?code=ABCD-EFGH&via=github`,
  );
});
