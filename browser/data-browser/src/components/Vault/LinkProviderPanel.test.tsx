// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';

const state = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('../../helpers/managed/accountProviders', async original => ({
  ...(await original<
    typeof import('../../helpers/managed/accountProviders')
  >()),
  getAccountProviders: async () => ({
    google: true,
    apple: true,
    github: true,
    assisted_recovery: false,
  }),
}));
vi.mock('../../helpers/managed/deviceLink', () => ({
  approvalUrl: (portal: string, code: string) => `${portal}/link?code=${code}`,
  awaitDeviceLink: () => new Promise(() => undefined),
  requestDeviceLink: async () => ({ user_code: 'ABCD-EFGH' }),
}));
vi.mock('../../helpers/openExternal', () => ({
  openExternal: state.openExternal,
}));

import { LinkProviderPanel } from './LinkProviderPanel';

afterEach(cleanup);

const PORTAL = 'https://portal.example';

async function show() {
  await act(async () => {
    render(
      <ThemeProvider theme={buildTheme(false, '#336699', false)}>
        <LinkProviderPanel portalUrl={PORTAL} onLinked={vi.fn()} />
      </ThemeProvider>,
    );
  });
}

it('leads with the same sign-in options as every screen, the code last', async () => {
  await show();

  for (const name of ['Google', 'Apple', 'GitHub', 'Sign in with passkey']) {
    expect(screen.getByRole('button', { name })).toBeTruthy();
  }

  expect(screen.queryByTestId('link-user-code')).toBeNull();

  const options = screen.getAllByRole('button');
  expect(options.at(-1)?.textContent).toBe(
    'Signed in on another device? Use a code',
  );
});

it('shows a code only when asked for, and goes back to the options', async () => {
  await show();

  await act(async () => {
    screen.getByTestId('link-provider-start').click();
  });
  expect(screen.getByTestId('link-user-code').textContent).toBe('ABCD-EFGH');
  expect(screen.queryByRole('button', { name: 'Google' })).toBeNull();

  await act(async () => {
    screen.getByTestId('link-provider-cancel').click();
  });
  expect(screen.queryByTestId('link-user-code')).toBeNull();
  expect(screen.getByRole('button', { name: 'Google' })).toBeTruthy();
});
