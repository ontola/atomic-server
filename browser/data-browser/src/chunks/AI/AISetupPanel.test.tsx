// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { AISetupPanel } from './AISetupPanel';

vi.mock('@components/Row', () => ({ Column: 'div', Row: 'div' }));
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
