// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../styling';
import { CallPage } from './CallPage';

const state = vi.hoisted(() => ({ leave: vi.fn(), adopt: vi.fn() }));

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useStore: () => ({}),
}));
vi.mock('./embedStore', () => ({
  adoptDriveOf: (...args: unknown[]) => state.adopt(...args),
}));
vi.mock('./hostActions', () => ({ leaveCall: () => state.leave() }));
vi.mock('../chunks/Conference/ConferenceRoom', () => ({
  default: ({
    subject,
    onLeave,
    compact,
  }: {
    subject: string;
    onLeave: () => void;
    compact?: boolean;
  }) => (
    <div data-compact={String(!!compact)}>
      <span>room {subject}</span>
      <button onClick={onLeave}>hang up</button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  state.leave.mockReset();
  state.adopt.mockReset();
});

const renderPage = () =>
  render(
    <ThemeProvider theme={buildTheme(false, '#4C6FA5')}>
      <CallPage meeting='did:ad:meeting' />
    </ThemeProvider>,
  );

it('renders only the meeting call, after taking the meeting drive', async () => {
  state.adopt.mockResolvedValue(undefined);
  renderPage();

  expect(await screen.findByText('room did:ad:meeting')).toBeTruthy();
  expect(state.adopt).toHaveBeenCalledWith({}, 'did:ad:meeting');
});

it('tells the app when the call is left', async () => {
  state.adopt.mockResolvedValue(undefined);
  renderPage();

  fireEvent.click(await screen.findByText('hang up'));
  expect(state.leave).toHaveBeenCalledTimes(1);
});

it('is compact in the narrow floating tile and full when expanded', async () => {
  state.adopt.mockResolvedValue(undefined);
  window.innerWidth = 112;
  const { container } = renderPage();

  await screen.findByText('room did:ad:meeting');
  expect(container.querySelector('[data-compact=true]')).toBeTruthy();

  act(() => {
    window.innerWidth = 600;
    window.dispatchEvent(new Event('resize'));
  });
  expect(container.querySelector('[data-compact=false]')).toBeTruthy();
});
