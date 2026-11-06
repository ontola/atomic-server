// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';

const state = vi.hoisted(() => ({
  cookieCapable: false,
  openExternal: vi.fn(),
}));
vi.mock('../../helpers/managed/deviceLink', () => ({
  canHoldProviderCookie: () => state.cookieCapable,
}));
vi.mock('../../helpers/openExternal', () => ({
  openExternal: state.openExternal,
}));
vi.mock('../../helpers/tauri', () => ({ isRunningInTauri: () => false }));
vi.mock('../Vault/LinkProviderPanel', () => ({
  LinkProviderPanel: ({
    portalUrl,
    onLinked,
  }: {
    portalUrl: string;
    onLinked: () => void;
  }) => (
    <section data-testid='link-provider-panel'>
      <input aria-label='Email' data-portal={portalUrl} />
      <button onClick={onLinked}>Approve connection</button>
    </section>
  ),
}));
import { SyncProviderAccount } from './SyncProviderAccount';

const PORTAL = 'https://portal.example';
beforeEach(() => {
  state.cookieCapable = false;
  state.openExternal.mockReset();
});
afterEach(cleanup);

async function show(email: string | null = null, onLinked = vi.fn()) {
  await act(async () => {
    render(
      <ThemeProvider theme={buildTheme(false, '#336699', false)}>
        <SyncProviderAccount
          portalUrl={PORTAL}
          email={email}
          emailRecoveryOn={false}
          onLinked={onLinked}
        />
      </ThemeProvider>,
    );
  });

  return onLinked;
}

it('links an off-site client in place instead of opening portal-only sign-in', async () => {
  const onLinked = await show();
  expect(screen.queryByRole('link', { name: 'Sign in →' })).toBeNull();
  expect(screen.queryByTestId('link-provider-panel')).toBeNull();
  await act(async () => {
    screen.getByRole('button', { name: 'Sign in →' }).click();
  });
  expect(screen.getAllByTestId('link-provider-panel')).toHaveLength(1);
  expect(screen.getByLabelText('Email').getAttribute('data-portal')).toBe(
    PORTAL,
  );
  expect(document.activeElement).toBe(screen.getByLabelText('Email'));
  expect(state.openExternal).not.toHaveBeenCalled();
  await act(async () => {
    screen.getByRole('button', { name: 'Approve connection' }).click();
  });
  expect(onLinked).toHaveBeenCalledOnce();
});

it('keeps portal sign-in for a cookie-capable hosted client', async () => {
  state.cookieCapable = true;
  await show();
  const link = screen.getByRole('link', { name: 'Sign in →' });
  expect(link.getAttribute('href')).toBe(`${PORTAL}/signin`);
  await act(async () => {
    link.click();
  });
  expect(state.openExternal).toHaveBeenCalledWith(`${PORTAL}/signin`);
  expect(screen.queryByTestId('link-provider-panel')).toBeNull();
});

it('opens account management when already signed in, including off-site clients', async () => {
  await show('test@example.org');
  expect(screen.getByTestId('provider-account').textContent).toBe(
    'test@example.org',
  );
  expect(
    screen.getByRole('link', { name: 'Manage account →' }).getAttribute('href'),
  ).toBe(`${PORTAL}/dashboard`);
  expect(screen.queryByRole('button', { name: 'Sign in →' })).toBeNull();
  expect(screen.queryByTestId('link-provider-panel')).toBeNull();
});
