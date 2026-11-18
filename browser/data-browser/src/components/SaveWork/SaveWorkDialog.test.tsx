// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';

const state = vi.hoisted(() => ({
  cookie: true,
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({ toast: { success: state.toast } }));
vi.mock('../../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => state.navigate,
}));
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

it('without a portal offers connecting a device and never the sign-in', () => {
  const onDone = renderContent(null);

  expect(screen.queryByText('panel')).toBeNull();
  act(() => screen.getByText('Connect a device').click());
  expect(onDone).toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalledWith('/app/sync');
});

it('with a portal shows the same sign-in panel everywhere else uses', () => {
  renderContent('https://portal.example');

  expect(screen.getByText('panel')).toBeTruthy();
  expect(screen.queryByText('Connect a device')).toBeNull();
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
