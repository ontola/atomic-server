import { type PropsWithChildren } from 'react';
import {
  ThemeProvider as StyledThemeProvider,
  type DefaultTheme,
} from 'styled-components';
import { defaultUITheme } from '@tomic/ui';
import {
  ResourceUIHostProvider,
  type ResourceUIHost,
} from '@tomic/resource-ui/ResourceUIHost';

export const buildTheme = (darkMode = false, main = '#1b50d8') => ({
  ...defaultUITheme,
  darkMode,
  fontFamilyHeader: 'sans-serif',
  fontSizeH1: 1.5,
  colors: { ...defaultUITheme.colors, main },
});

const unavailable = () => {
  throw new Error('This fixture does not provide the external integration.');
};

const host: ResourceUIHost = {
  settings: {
    drive: '',
    contentLanguage: 'en',
    setContentLanguage: () => {},
    agent: undefined,
  },
  search: {},
  navigate: async () => {},
  navigateWithTransition: async () => {},
  links: {
    constructOpenURL: subject => `/show?subject=${encodeURIComponent(subject)}`,
    pathToURL: path => new URL(path, 'https://example.com').href,
  },
  isRunningInTauri: () => false,
  reportError: error => {
    throw error;
  },
  loadAtomicWasm: async () => unavailable(),
  DriveApps: ({ children }) => children({ apps: [], refresh: () => {} }),
  AppFrame: unavailable,
  WorkspaceControls: unavailable,
  ResourceCard: unavailable,
  errorFallback: ({ error }) => <span>{error.message}</span>,
};

export function ThemeProvider({
  children,
  theme,
  settings,
  host: overrides,
}: PropsWithChildren<{
  theme: object;
  settings?: Partial<ResourceUIHost['settings']>;
  host?: Partial<ResourceUIHost>;
}>) {
  return (
    <ResourceUIHostProvider
      value={{ ...host, ...overrides, settings: { ...host.settings, ...settings } }}
    >
      <StyledThemeProvider theme={theme as DefaultTheme}>
        {children}
      </StyledThemeProvider>
    </ResourceUIHostProvider>
  );
}
