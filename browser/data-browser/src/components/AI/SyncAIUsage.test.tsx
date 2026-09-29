// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AISettingsContext,
  type AISettingsContextType,
} from './AISettingsContext';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';
import { SyncAIUsage } from './SyncAIUsage';
import type { HostedAIStatus } from '@helpers/managed/ai';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const status = (over: Partial<HostedAIStatus> = {}): HostedAIStatus => ({
  enabled: true,
  consent: true,
  model: 'test',
  paid: true,
  allowance_micros: 5_000_000,
  used_micros: 3_100_000,
  remaining_micros: 1_900_000,
  purchases_enabled: true,
  resets_at: 1790812800,
  ...over,
});

function renderUsage(
  ctx: { enableAI: boolean; hostedAI?: HostedAIStatus },
  portalUrl: string | null = 'https://portal.example',
) {
  return render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8', false)}>
      <AISettingsContext.Provider value={ctx as AISettingsContextType}>
        <SyncAIUsage portalUrl={portalUrl} />
      </AISettingsContext.Provider>
    </ThemeProvider>,
  );
}

it('shows the percent used and the order button when purchases are enabled', () => {
  vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '1');
  renderUsage({ enableAI: true, hostedAI: status() });
  expect(screen.getAllByText('62% of AI credits used').length).toBeGreaterThan(
    0,
  );
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
    '62',
  );
  expect(
    screen.getByRole('button', { name: 'Order more credits' }),
  ).toBeTruthy();
});

it('has no order button when purchases are disabled', () => {
  vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '1');
  renderUsage({
    enableAI: true,
    hostedAI: status({ purchases_enabled: false }),
  });
  expect(screen.getByTestId('sync-ai-usage')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Order more credits' }),
  ).toBeNull();
});

it('renders nothing when the local AI flag is off', () => {
  vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '1');
  renderUsage({ enableAI: false, hostedAI: status() });
  expect(screen.queryByTestId('sync-ai-usage')).toBeNull();
});

it('renders nothing when hosted AI is disabled or undefined', () => {
  vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '1');
  renderUsage({ enableAI: true, hostedAI: status({ enabled: false }) });
  expect(screen.queryByTestId('sync-ai-usage')).toBeNull();
  cleanup();
  renderUsage({ enableAI: true, hostedAI: undefined });
  expect(screen.queryByTestId('sync-ai-usage')).toBeNull();
});

it('renders nothing without a portal (self-hosted)', () => {
  renderUsage({ enableAI: true, hostedAI: status() }, null);
  expect(screen.queryByTestId('sync-ai-usage')).toBeNull();
});
