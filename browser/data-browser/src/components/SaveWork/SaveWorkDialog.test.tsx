// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';

const state = vi.hoisted(() => ({
  cookie: true,
  toast: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({ toast: { success: state.toast } }));
vi.mock('../../helpers/managed/deviceLink', async original => ({
  ...(await original<typeof import('../../helpers/managed/deviceLink')>()),
  canHoldProviderCookie: () => state.cookie,
}));
vi.mock('../../views/getting-started/AccountSignInPanel', () => ({
  AccountSignInPanel: ({ onSignedIn }: { onSignedIn: () => void }) => (
    <button onClick={onSignedIn}>panel</button>
  ),
  AccountSignInViaBrowser: ({ onSignedIn }: { onSignedIn: () => void }) => (
    <button onClick={onSignedIn}>browser</button>
  ),
}));

import { SAVE_ADOPT_TIMEOUT_MS, SaveWorkContent } from './SaveWorkDialog';
import {
  clearManagedAccountBinding,
  writeManagedAccountBinding,
} from '../../helpers/managed/binding';

const renderContent = (portalUrl: string | null, onDone = vi.fn()) => {
  render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <SaveWorkContent portalUrl={portalUrl} onDone={onDone} />
    </ThemeProvider>,
  );

  return onDone;
};

beforeEach(() => {
  state.cookie = true;
  clearManagedAccountBinding();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

vi.mock('../../hooks/useConnectDeviceProps', () => ({
  useConnectDeviceProps: () => ({
    pairNodeDid: null,
    showPairing: false,
    canTakeCode: false,
    serverName: 'example.com',
    onAddServer: vi.fn(),
  }),
}));

it('without a service shows only the pairing form', () => {
  const onDone = renderContent(null);

  expect(screen.queryByText('panel')).toBeNull();
  expect(screen.getByTestId('connect-device-add')).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
});

it('with a service shows the sign-in with pairing below it', () => {
  renderContent('https://portal.example');

  const panel = screen.getByText('panel');
  const pairing = screen.getByTestId('connect-device-add');

  expect(
    panel.compareDocumentPosition(pairing) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it('names where the email goes when the service is not this site', () => {
  state.cookie = false;
  renderContent('https://portal.example');

  expect(screen.getByTestId('save-work-disclosure').textContent).toBe(
    'Your email and an encrypted backup of your identity go to portal.example.',
  );
});

it('says nothing about it on the service’s own site', () => {
  renderContent('https://portal.example');

  expect(screen.queryByTestId('save-work-disclosure')).toBeNull();
});

it('without a portal closes once a device link makes the identity linked', () => {
  const onDone = renderContent(null);

  act(() => writeManagedAccountBinding('ann@example.com', 'did:ad:agent:abc'));
  expect(onDone).toHaveBeenCalled();
});

it('uses the browser sign-in where the app cannot hold the cookie', () => {
  state.cookie = false;
  renderContent('https://portal.example');

  expect(screen.getByText('browser')).toBeTruthy();
});

it('closes with a toast once the account has adopted this identity', () => {
  const onDone = renderContent('https://portal.example');

  act(() => screen.getByText('panel').click());
  expect(screen.getByTestId('save-work-linking')).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();

  act(() => writeManagedAccountBinding('ann@example.com', 'did:ad:agent:abc'));
  expect(state.toast).toHaveBeenCalledWith('Saved as ann@example.com');
  expect(onDone).toHaveBeenCalled();
});

it('follows a binding another tab wrote (storage event, no in-tab notify)', () => {
  const onDone = renderContent('https://portal.example');

  act(() => screen.getByText('panel').click());
  expect(onDone).not.toHaveBeenCalled();

  act(() => {
    localStorage.setItem(
      'atomic-managed-account-binding',
      JSON.stringify({
        owner_email: 'ann@example.com',
        expected_agent_subject: 'did:ad:agent:abc',
      }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'atomic-managed-account-binding' }),
    );
  });
  expect(onDone).toHaveBeenCalled();
});

it('stops waiting after the timeout and offers a retry', () => {
  vi.useFakeTimers();

  try {
    const onDone = renderContent('https://portal.example');

    act(() => screen.getByText('panel').click());
    expect(screen.getByTestId('save-work-linking')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(SAVE_ADOPT_TIMEOUT_MS + 1);
    });
    expect(screen.getByTestId('save-work-failed')).toBeTruthy();
    expect(screen.queryByTestId('save-work-linking')).toBeNull();

    act(() => screen.getByTestId('save-work-retry').click());
    expect(screen.getByTestId('save-work-linking')).toBeTruthy();

    act(() =>
      writeManagedAccountBinding('ann@example.com', 'did:ad:agent:abc'),
    );
    expect(onDone).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
