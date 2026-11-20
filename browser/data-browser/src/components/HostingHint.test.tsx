// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../styling';

const state = vi.hoisted(() => ({
  service: 'https://atomic.place' as string | null,
  price: undefined as string | undefined,
  hosted: false,
  session: false,
}));

vi.mock('../helpers/managed/cloudSync', () => ({
  getAccountServiceUrl: () => state.service,
  driveHasCloudEnrollment: async () => state.hosted,
}));
vi.mock('../helpers/managed/api', () => ({
  hasManagedApi: () => state.session,
}));
vi.mock('../helpers/managed/accountProviders', () => ({
  getCloudServerPrice: vi.fn(async () => state.price),
}));
vi.mock('../helpers/openExternal', () => ({ openExternal: vi.fn() }));

import { HostingHint } from './HostingHint';
import { getCloudServerPrice } from '../helpers/managed/accountProviders';

const show = async (drive?: string) => {
  await act(async () => {
    render(
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <HostingHint reason='no-always-on-device' drive={drive} />
      </ThemeProvider>,
    );
  });
};

beforeEach(() => {
  state.service = 'https://atomic.place';
  state.price = undefined;
  state.hosted = false;
  state.session = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('is one line and a link to the service', async () => {
  await show('did:ad:d');

  const link = screen.getByRole('link');

  expect(link.getAttribute('href')).toBe(
    'https://atomic.place/cloud-server?drive=did%3Aad%3Ad',
  );
  expect(screen.getByRole('note').textContent).not.toContain('from');
});

it('adds the price only when the service names one', async () => {
  state.price = '€30/month';
  await show();

  expect(screen.getByRole('note').textContent).toContain('from €30/month');
});

it('renders nothing without a service, and asks nobody', async () => {
  state.service = null;
  await show();

  expect(screen.queryByRole('note')).toBeNull();
  expect(getCloudServerPrice).not.toHaveBeenCalled();
});

it('renders nothing when the drive already has a Cloud Server', async () => {
  state.session = true;
  state.hosted = true;
  await show('did:ad:d');

  expect(screen.queryByRole('note')).toBeNull();
});
