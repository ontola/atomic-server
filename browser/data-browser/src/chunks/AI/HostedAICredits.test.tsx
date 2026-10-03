// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HostedAICredits } from './HostedAICredits';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it('shows fractional charges and separates purchased credits from the resetting allowance', () => {
  vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '1');
  render(
    <HostedAICredits
      portalUrl='https://portal.example'
      status={{
        enabled: true,
        consent: true,
        model: 'test',
        paid: true,
        allowance_micros: 5_000_000,
        used_micros: 1,
        remaining_micros: 9_999_999,
        purchased_remaining_micros: 5_000_000,
        purchases_enabled: true,
        resets_at: 1790812800,
      }}
    />,
  );
  expect(
    screen.getByText('4,999.999 of 5,000 monthly credits left'),
  ).toBeTruthy();
  expect(
    screen.getByText('5,000 purchased credits · carries over'),
  ).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Get more credits' }).getAttribute('href'),
  ).toBe('https://portal.example/dashboard');
});

it('does not offer checkout in a FOSS build even when SaaS enables purchases', () => {
  vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '');
  render(
    <HostedAICredits
      portalUrl='https://portal.example'
      status={{
        enabled: true,
        consent: true,
        model: 'test',
        paid: false,
        allowance_micros: 100_000,
        used_micros: 100_000,
        remaining_micros: 0,
        purchases_enabled: true,
        resets_at: 1790812800,
      }}
    />,
  );
  expect(screen.queryByRole('link', { name: 'Get more credits' })).toBeNull();
});

it('does not offer checkout in a hosted build when purchases are unavailable', () => {
  vi.stubEnv('VITE_ATOMIC_HOSTED_DISTRIBUTION', '1');
  render(
    <HostedAICredits
      portalUrl='https://portal.example'
      status={{
        enabled: true,
        consent: true,
        model: 'test',
        paid: false,
        allowance_micros: 100_000,
        used_micros: 100_000,
        remaining_micros: 0,
        purchases_enabled: false,
        resets_at: 1790812800,
      }}
    />,
  );
  expect(screen.queryByRole('link', { name: 'Get more credits' })).toBeNull();
});
