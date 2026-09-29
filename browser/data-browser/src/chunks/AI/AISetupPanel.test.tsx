// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { AISetupPanel } from './AISetupPanel';
import type { HostedAIStatus } from '@helpers/managed/ai';

const hosted = vi.hoisted(() => ({
  status: undefined as HostedAIStatus | undefined,
  enable: vi.fn(),
  managed: false,
}));

beforeEach(() => {
  hosted.status = undefined;
  hosted.managed = false;
  hosted.enable.mockReset();
});

vi.mock('@components/Row', () => ({ Column: 'div', Row: 'div' }));
vi.mock('@helpers/managed/api', () => ({
  hasManagedApi: () => hosted.managed,
}));
vi.mock('@chunks/AI/ModelSelect/ModelSelect', () => ({ default: () => null }));

vi.mock('@components/Dialog', () => ({
  useDialog: ({ onCancel }: { onCancel: () => void }) => [
    { onCancel },
    () => {},
  ],
  Dialog: ({
    children,
    onCancel,
  }: React.PropsWithChildren<{ onCancel: () => void }>) => (
    <div role='dialog'>
      <button onClick={onCancel}>Dismiss</button>
      {children}
    </div>
  ),
  DialogContent: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
}));
vi.mock('@components/AI/AISettingsContext', () => ({
  DEFAULT_CHAT_MODEL: { id: 'test', provider: 'openrouter' },
  useAISettings: () => ({
    hostedAI: hosted.status,
    enableIncludedAI: hosted.enable,
    availableProviders: [],
    isProviderAvailable: () => false,
    defaultChatModel: { id: 'test', provider: 'openrouter' },
  }),
}));
vi.mock('./AgentConfig', () => ({
  useAIAgentConfig: () => ({ agents: [], saveAgents: vi.fn() }),
}));
vi.mock('@components/AI/useIsOllamaUrlValid', () => ({
  useIsOllamaUrlValid: () => ({ checking: false }),
}));
vi.mock('@components/AI/LocalOllamaDiscovery', () => ({
  LocalOllamaDiscovery: () => null,
}));
vi.mock('@components/AI/ProviderStatus', () => ({
  ProviderStatus: () => null,
}));
vi.mock('@components/AI/OpenRouterLoginButton', () => ({
  OpenRouterLoginButton: () => null,
}));
vi.mock('@components/Button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));
vi.mock('@components/OutlinedSection', () => ({
  OutlinedSection: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
}));
vi.mock('@components/forms/InputStyles', () => ({
  InputStyled: 'input',
  InputWrapper: 'div',
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

it('reopens a dismissed setup when chat requests it again', () => {
  const panel = (requestId: number) => (
    <ThemeProvider theme={{ colors: {} } as DefaultTheme}>
      <AISetupPanel requestId={requestId} />
    </ThemeProvider>
  );
  const view = render(panel(0));
  fireEvent.click(view.getByText('Dismiss'));
  expect(view.queryByRole('dialog')).toBeNull();
  view.rerender(panel(1));
  expect(view.queryByRole('dialog')).not.toBeNull();
  fireEvent.click(view.getByText('Dismiss'));
  view.rerender(panel(2));
  expect(view.queryByRole('dialog')).not.toBeNull();
});

it('requires an explicit included-AI choice and keeps failed setup retryable', async () => {
  hosted.status = {
    enabled: true,
    consent: false,
    paid: false,
    model: 'google/gemini-2.5-flash',
    allowance_micros: 100000,
    used_micros: 0,
    remaining_micros: 100000,
    resets_at: 1790812800,
  };
  hosted.enable.mockRejectedValueOnce(
    new Error('Could not enable included AI.'),
  );
  const view = render(
    <ThemeProvider theme={{ colors: {} } as DefaultTheme}>
      <AISetupPanel />
    </ThemeProvider>,
  );
  expect(hosted.enable).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: 'Use included AI' }));
  await waitFor(() =>
    expect(view.getByRole('alert').textContent).toContain('Could not enable'),
  );
  expect(view.getByRole('dialog')).not.toBeNull();
  hosted.enable.mockResolvedValueOnce(undefined);
  fireEvent.click(view.getByRole('button', { name: 'Use included AI' }));
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
  expect(hosted.enable).toHaveBeenCalledTimes(2);
});

it('never opens onboarding for a SaaS instance, even before status has loaded', () => {
  hosted.managed = true;
  const panel = (requestId: number) => (
    <ThemeProvider theme={{ colors: {} } as DefaultTheme}>
      <AISetupPanel requestId={requestId} />
    </ThemeProvider>
  );
  const view = render(panel(0));
  expect(view.queryByRole('dialog')).toBeNull();
  expect(hosted.enable).not.toHaveBeenCalled();
  view.rerender(panel(1));
  expect(view.getByRole('dialog')).not.toBeNull();
});
