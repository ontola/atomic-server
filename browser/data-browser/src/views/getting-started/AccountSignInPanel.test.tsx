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
  inTauri: false,
  requested: [] as (string | undefined)[],
  redeem: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('../../helpers/managed/accountProviders', async original => ({
  ...(await original<
    typeof import('../../helpers/managed/accountProviders')
  >()),
  getAccountProviders: async () => state.providers,
}));
vi.mock('../../helpers/managed/deviceLink', async original => ({
  parseAccountReturn: (
    await original<typeof import('../../helpers/managed/deviceLink')>()
  ).parseAccountReturn,
  approvalUrl: (portal: string, code: string) => `${portal}/link?code=${code}`,
  awaitDeviceLink: () => new Promise(() => undefined),
  newReturnVerifier: () => ({ verifier: 'V', challenge: 'C' }),
  redeemDeviceLink: state.redeem,
  requestDeviceLink: async (_p: string, _n?: string, challenge?: string) => {
    state.requested.push(challenge);

    return { user_code: 'ABCD-EFGH', device_code: 'DC' };
  },
}));
vi.mock('../../helpers/tauri', () => ({
  isRunningInTauri: () => state.inTauri,
}));
vi.mock('../../helpers/openExternal', () => ({
  openExternal: state.openExternal,
}));

import {
  AccountSignInPanel,
  AccountSignInViaBrowser,
} from './AccountSignInPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

it('in the desktop app, signing in in the browser is enough', async () => {
  state.inTauri = true;
  state.requested = [];
  const onSignedIn = vi.fn();
  await show(
    <AccountSignInViaBrowser portalUrl={PORTAL} onSignedIn={onSignedIn} />,
  );

  await act(async () => {
    screen.getByRole('button', { name: 'Google' }).click();
  });

  expect(state.requested).toEqual(['C']);
  expect(state.openExternal).toHaveBeenLastCalledWith(
    `${PORTAL}/link?code=ABCD-EFGH&via=google&return=app`,
  );

  // Another request's handoff is not this one's.
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('atomic-deep-link', {
        detail: 'atomic://account-return?code=ZZZZ-ZZZZ&handoff=X',
      }),
    );
  });
  expect(state.redeem).not.toHaveBeenCalled();

  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('atomic-deep-link', {
        detail: 'atomic://account-return?code=ABCD-EFGH&handoff=H1',
      }),
    );
  });
  expect(state.redeem).toHaveBeenCalledWith(PORTAL, 'DC', 'H1', 'V');
  expect(onSignedIn).toHaveBeenCalledOnce();
  state.inTauri = false;
});

it('offers the passkey only where this device has something to sign in with', async () => {
  const device = (passkeyPlatformAuthenticator: boolean) =>
    vi.stubGlobal(
      'PublicKeyCredential',
      Object.assign(function () {}, {
        getClientCapabilities: async () => ({
          passkeyPlatformAuthenticator,
          hybridTransport: false,
        }),
      }),
    );
  const credentials = { create() {}, get() {} };
  vi.stubGlobal('navigator', { ...navigator, credentials });
  vi.stubGlobal('isSecureContext', true);

  device(false);
  await show(<AccountSignInPanel portalUrl={PORTAL} onSignedIn={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull();
  cleanup();

  device(true);
  await show(<AccountSignInPanel portalUrl={PORTAL} onSignedIn={vi.fn()} />);
  expect(screen.getByRole('button', { name: /passkey/i })).toBeTruthy();
});
