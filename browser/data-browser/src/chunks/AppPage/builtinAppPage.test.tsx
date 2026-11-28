// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { AppPage } from './index';
import { resolveBuiltinApp } from './builtinApp';
import type { Resource } from '@tomic/lib';

const state = vi.hoisted(() => ({ store: { getDrive: () => 'drive' } }));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => state.store,
  useTitle: () => ['GitHub · michiel'],
}));
vi.mock('./builtinApp', () => ({ resolveBuiltinApp: vi.fn() }));
vi.mock('./AppFrame', () => ({
  AppFrame: ({ app }: { app: string }) => (
    <div data-testid='ordinary-app'>{app}</div>
  ),
}));
vi.mock('@chunks/PluginRuns/BuiltinSyncablesApp', () => ({
  BuiltinSyncablesApp: ({ table }: { table: string }) => (
    <div data-testid='builtin-app'>{table}</div>
  ),
}));
vi.mock('@tomic/ui/components/Loader', () => ({
  LoaderBlock: () => <p>Loading</p>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open() {
  return render(
    <ThemeProvider theme={{ size: () => '8px' } as DefaultTheme}>
      <AppPage resource={{ subject: 'installed-app' } as Resource} />
    </ThemeProvider>,
  );
}

it('opens a registered built-in through the existing Sync app mounting host', async () => {
  vi.mocked(resolveBuiltinApp).mockResolvedValue({
    kind: 'syncables',
    table: 'installed-app',
  });
  open();
  expect((await screen.findByTestId('builtin-app')).textContent).toBe(
    'installed-app',
  );
  expect(screen.queryByTestId('ordinary-app')).toBeNull();
});

it('keeps ordinary App entrypoints on the existing AppFrame path', async () => {
  vi.mocked(resolveBuiltinApp).mockResolvedValue(undefined);
  open();
  expect((await screen.findByTestId('ordinary-app')).textContent).toBe(
    'installed-app',
  );
  expect(screen.queryByTestId('builtin-app')).toBeNull();
});

it('opens a registered principal without mounting an iframe', async () => {
  vi.mocked(resolveBuiltinApp).mockResolvedValue({
    kind: 'syncables',
    table: 'installed-app',
    principal: true,
  });
  open();
  expect(
    await screen.findByText(/Integration installed in this drive/),
  ).toBeDefined();
  expect(screen.queryByTestId('builtin-app')).toBeNull();
  expect(screen.queryByTestId('ordinary-app')).toBeNull();
});

it('refuses an invalid built-in binding before mounting any execution host', async () => {
  vi.mocked(resolveBuiltinApp).mockRejectedValue(
    new Error('Saved source root is outside this app'),
  );
  open();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'outside this app',
  );
  expect(screen.queryByTestId('builtin-app')).toBeNull();
  expect(screen.queryByTestId('ordinary-app')).toBeNull();
});
