// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../styling';
import {
  embedAppearanceOptions,
  embedSettingsSections,
  showAppearanceOption,
  showSettingsSection,
  showWebAI,
  type SettingsSectionId,
} from './settings';
import * as embedMode from '../helpers/embedMode';

const colorPickerState = vi.hoisted(() => ({
  moduleLoads: 0,
  mainColor: '#4C6FA5',
  setMainColor: vi.fn(),
}));

vi.mock('react-colorful', () => {
  colorPickerState.moduleLoads++;

  return {
    HexColorPicker: ({
      color,
      onChange,
    }: {
      color: string;
      onChange: (color: string) => void;
    }) => (
      <input
        aria-label='Custom color'
        value={color}
        onChange={event => onChange(event.target.value)}
      />
    ),
  };
});

vi.mock('@tanstack/react-router', () => ({
  createRoute: (options: object) => ({ ...options, useSearch: () => ({}) }),
}));
vi.mock('../routes/RootRoutes', () => ({ appRoute: {} }));
vi.mock('../helpers/AppSettings', () => ({
  useSettings: () => ({
    darkModeSetting: 'auto',
    setDarkMode: () => undefined,
    colorfulMode: false,
    setColorfulMode: () => undefined,
    hideTemplates: false,
    setHideTemplates: () => undefined,
    showSidebarIcons: true,
    setShowSidebarIcons: () => undefined,
    navbarTop: false,
    setNavbarTop: () => undefined,
    mainColor: colorPickerState.mainColor,
    setMainColor: colorPickerState.setMainColor,
    viewTransitionsEnabled: false,
    setViewTransitionsEnabled: () => undefined,
    sidebarKeyboardDndEnabled: false,
    setSidebarKeyboardDndEnabled: () => undefined,
  }),
}));
vi.mock('@components/LocaleContext', () => ({
  SUPPORTED_LOCALES: ['en'],
  useLocale: () => ({ locale: 'en', setLocale: () => undefined }),
}));
vi.mock('../components/SideBar/usePanelList', () => ({
  Panel: {
    Messages: 'm',
    Favorites: 'f',
    SharedWithMe: 's',
    Ontologies: 'o',
    AIChats: 'a',
  },
  usePanelList: () => ({
    enabledPanels: new Set(),
    enablePanel: () => undefined,
    disablePanel: () => undefined,
  }),
}));
vi.mock('@components/Settings', () => ({
  SettingsGroup: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SettingsSearchProvider: ({ children }: React.PropsWithChildren) => (
    <>{children}</>
  ),
  SettingsSection: ({
    label,
    children,
  }: React.PropsWithChildren<{ label: string }>) => (
    <section aria-label={label}>{children}</section>
  ),
  SettingField: ({
    label,
    children,
  }: React.PropsWithChildren<{ label: string }>) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
  SettingCheckbox: ({
    children,
    hint,
    checked,
    onChange,
  }: React.PropsWithChildren<{
    hint?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
  }>) => (
    <label>
      <input
        type='checkbox'
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      {children}
      {hint && <span>{hint}</span>}
    </label>
  ),
}));
vi.mock('@components/Settings/AccountSettings', () => ({
  AccountSettings: () => <section aria-label='Account & security' />,
}));
vi.mock('@components/Settings/DriveSettings', () => ({
  DriveSettings: () => <section aria-label='Drive' />,
}));
vi.mock('@components/Settings/SyncSettings', () => ({
  SyncSettings: () => null,
}));
vi.mock('@components/Settings/IntegrationSettings', () => ({
  IntegrationSettings: () => <section aria-label='Integration' />,
}));
vi.mock('@components/Settings/NotificationSettings', () => ({
  NotificationSettings: () => <p>notification settings</p>,
}));
vi.mock('@components/Settings/VirtualDriveSettings', () => ({
  VirtualDriveSettings: () => null,
}));
vi.mock('@components/AI/AISettings', () => ({
  default: () => <section aria-label='AI' />,
}));
vi.mock('../helpers/virtualDrive', () => ({
  isVirtualDriveAvailable: () => false,
}));

const { AppSettingsRoute } = await import('../routes/AppSettings');

const renderPage = () => {
  const Page = (AppSettingsRoute as unknown as { component: React.FC })
    .component;

  return render(
    <ThemeProvider theme={buildTheme(false, '#4C6FA5')}>
      <Page />
    </ThemeProvider>,
  );
};

beforeEach(() => {
  localStorage.clear();
  colorPickerState.mainColor = '#4C6FA5';
  colorPickerState.setMainColor.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows every section outside the embed', () => {
  const ids: SettingsSectionId[] = [
    'account',
    'drive',
    'sync',
    'appearance',
    'accessibility',
    'notifications',
    'virtualDrive',
    'ai',
    'integration',
  ];

  for (const id of ids) expect(showSettingsSection(id, false)).toBe(true);

  expect(showAppearanceOption('navbarPosition', false)).toBe(true);
  expect(showAppearanceOption('panels', false)).toBe(true);
});

it('shows only the allow-listed sections and options in the embed', () => {
  expect(showSettingsSection('appearance', true)).toBe(true);

  for (const id of [
    'account',
    'drive',
    'sync',
    'accessibility',
    'notifications',
    'virtualDrive',
    'ai',
    'integration',
  ] as const) {
    expect(showSettingsSection(id, true)).toBe(false);
  }

  expect([...embedSettingsSections]).toEqual(['appearance']);
  expect(showAppearanceOption('theme', true)).toBe(true);
  expect(showAppearanceOption('navbarPosition', true)).toBe(false);
  expect(showAppearanceOption('colorfulMode', true)).toBe(false);
  expect(showAppearanceOption('panels', true)).toBe(false);
  expect(embedAppearanceOptions.has('language')).toBe(true);
  expect(showAppearanceOption('sidebarIcons', true)).toBe(true);
});

it('renders the full page outside the embed', async () => {
  renderPage();

  // Account and Drive load lazily, out of the embed's bundle.
  expect(await screen.findByLabelText('Account & security')).toBeTruthy();
  expect(await screen.findByLabelText('Drive')).toBeTruthy();

  for (const label of [
    'Account & security',
    'Drive',
    'Sync & devices',
    'Appearance',
    'Accessibility',
    'Notifications',
    'AI',
  ]) {
    expect(screen.getByLabelText(label)).toBeTruthy();
  }

  expect(screen.getByLabelText('Integration')).toBeTruthy();
  expect(screen.getByLabelText('Panels & Templates')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  expect(screen.getByLabelText('Search settings')).toBeTruthy();
  expect(screen.getByText('NavBar position')).toBeTruthy();
});

it('renders only Appearance, without the chrome options, in the embed', () => {
  vi.spyOn(embedMode, 'isEmbedded').mockReturnValue(true);
  renderPage();

  expect(screen.getByLabelText('Appearance')).toBeTruthy();
  expect(screen.getByText('Theme')).toBeTruthy();
  expect(screen.getByText('Main color')).toBeTruthy();
  expect(screen.getByText('Language')).toBeTruthy();
  expect(screen.getByText('Hide templates on new resource page')).toBeTruthy();

  for (const label of [
    'Account & security',
    'Drive',
    'Sync & devices',
    'Accessibility',
    'Notifications',
    'AI',
    'Integration',
  ]) {
    expect(screen.queryByLabelText(label)).toBeNull();
  }

  expect(screen.queryByText('NavBar position')).toBeNull();
  expect(screen.queryByText('Colorful mode')).toBeNull();
  expect(screen.queryByText('Show Messages panel')).toBeNull();
  // The app's top bar has the title; one section needs no search.
  expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  expect(screen.queryByLabelText('Search settings')).toBeNull();
});

it('turns the web AI off in the embed only', () => {
  expect(showWebAI(false)).toBe(true);
  expect(showWebAI(true)).toBe(false);
  vi.spyOn(embedMode, 'isEmbedded').mockReturnValue(true);
  expect(showWebAI()).toBe(false);
});

it('offers "Show icons in the sidebar", on by default', () => {
  renderPage();
  expect(screen.getByText('Show icons in the sidebar')).toBeTruthy();
  expect(
    screen.getByText('Show icons and pictures next to items in the sidebar'),
  ).toBeTruthy();
});

it('loads the optional custom color picker on demand and preserves color selection', async () => {
  vi.spyOn(embedMode, 'isEmbedded').mockReturnValue(true);
  renderPage();

  expect(colorPickerState.moduleLoads).toBe(0);
  expect(screen.queryByLabelText('Custom color')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
  const picker = await screen.findByLabelText('Custom color');
  expect(colorPickerState.moduleLoads).toBe(1);
  expect((picker as HTMLInputElement).value).toBe('#4C6FA5');
  fireEvent.change(picker, { target: { value: '#123456' } });
  expect(colorPickerState.setMainColor).toHaveBeenCalledWith('#123456');

  fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
  expect(screen.queryByLabelText('Custom color')).toBeNull();
  cleanup();
  colorPickerState.mainColor = '#123456';
  renderPage();
  expect(
    ((await screen.findByLabelText('Custom color')) as HTMLInputElement).value,
  ).toBe('#123456');
  expect(colorPickerState.moduleLoads).toBe(1);
});
