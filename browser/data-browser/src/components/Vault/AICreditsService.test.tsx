// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostedAIStatus } from '../../helpers/managed/ai';

const settings = vi.hoisted(() => ({ enableAI: true }));
const status = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../AI/AISettingsContext', () => ({
  useAISettings: () => settings,
}));
vi.mock('../../helpers/managed/ai', async importOriginal => ({
  ...(await importOriginal<object>()),
  getHostedAIStatus: async () => status.current,
}));

import { AICreditsService } from './AICreditsService';
import { buildTheme } from '../../styling';

const theme = buildTheme(false, '#1b50d8');

const base: HostedAIStatus = {
  enabled: true,
  consent: true,
  model: 'test',
  paid: false,
  allowance_micros: 100_000,
  used_micros: 25_000,
  remaining_micros: 75_000,
  purchased_remaining_micros: 0,
  purchases_enabled: true,
  resets_at: 1790812800,
};

const show = () =>
  render(
    <ThemeProvider theme={theme}>
      <AICreditsService />
    </ThemeProvider>,
  );

afterEach(() => {
  cleanup();
  settings.enableAI = true;
  vi.unstubAllEnvs();
});

it('shows the share of this month’s credits used, without a subscription', async () => {
  vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '1');
  status.current = base;
  show();

  await waitFor(() =>
    expect(
      screen.getByText(/25% of this month’s 100 credits used/),
    ).toBeTruthy(),
  );
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('25');
  expect(screen.getByRole('button', { name: 'Buy more credits' })).toBeTruthy();
});

it('is not shown when AI is switched off in the app', async () => {
  settings.enableAI = false;
  status.current = base;
  const { container } = show();

  await new Promise(resolve => setTimeout(resolve, 20));
  expect(container.textContent).toBe('');
});

it('is not shown when the account server offers no included AI', async () => {
  status.current = { ...base, enabled: false };
  const { container } = show();

  await new Promise(resolve => setTimeout(resolve, 20));
  expect(container.textContent).toBe('');
});
