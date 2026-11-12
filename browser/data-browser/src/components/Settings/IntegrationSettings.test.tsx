// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';
import { IntegrationSettings } from './IntegrationSettings';
import { defaultIntegrationProxy } from '@helpers/integrationProxy';
import { defaultPluginCatalogUrl } from '@helpers/pluginCatalogUrl';

vi.mock('@hooks/useIntegrationVisibility', () => ({
  useIntegrationVisibility: () => ({
    showExperimentalPlugins: false,
    ready: true,
    pending: false,
    error: undefined,
    setVisibility: () => undefined,
  }),
}));

vi.mock('./SettingsSection', () => ({
  SettingsSection: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const renderSettings = () =>
  render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <IntegrationSettings />
    </ThemeProvider>,
  );

const proxyInput = () =>
  screen.getByLabelText('Integration proxy URL') as HTMLInputElement;
const resetButtons = () => screen.queryAllByRole('button', { name: 'Reset' });
const listed = () =>
  screen.queryAllByRole('listitem').map(li => li.textContent);

it('shows no Reset while values are the defaults', () => {
  renderSettings();

  expect(proxyInput().value).toBe(defaultIntegrationProxy);
  expect(listed()).toEqual([`${defaultPluginCatalogUrl}Remove`]);
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  expect(resetButtons()).toHaveLength(0);
});

it('shows an inline Reset once the proxy differs, and resets it', () => {
  renderSettings();

  fireEvent.change(proxyInput(), {
    target: { value: 'https://proxy.example.com' },
  });
  expect(resetButtons()).toHaveLength(1);

  fireEvent.click(resetButtons()[0]);
  expect(proxyInput().value).toBe(defaultIntegrationProxy);
  expect(resetButtons()).toHaveLength(0);
});

it('adds and removes marketplaces, and resets the list to the default', () => {
  renderSettings();

  fireEvent.change(screen.getByLabelText('Add marketplace URL'), {
    target: { value: 'https://catalog.example.com/catalog.json' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(listed()).toHaveLength(2);
  expect(resetButtons()).toHaveLength(1);

  fireEvent.click(resetButtons()[0]);
  expect(localStorage.getItem('marketplaces')).toBeNull();
  expect(listed()).toEqual([`${defaultPluginCatalogUrl}Remove`]);
  expect(resetButtons()).toHaveLength(0);
});

it('lets the default be removed', () => {
  renderSettings();

  fireEvent.click(
    screen.getByRole('button', { name: `Remove ${defaultPluginCatalogUrl}` }),
  );
  expect(listed()).toEqual([]);
  expect(resetButtons()).toHaveLength(1);
});
