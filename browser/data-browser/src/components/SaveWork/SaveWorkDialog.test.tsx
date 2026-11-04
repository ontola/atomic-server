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

import { SaveWorkContent } from './SaveWorkDialog';
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
