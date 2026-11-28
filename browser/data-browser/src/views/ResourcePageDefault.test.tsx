// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import type { ReactElement } from 'react';
import { core, type Resource } from '@tomic/react';
import { buildTheme } from '../styling';
import { ResourcePageDefault } from './ResourcePageDefault';
const h = vi.hoisted(() => ({
  localId: 'ordinary:page',
  actions: vi.fn<(...args: unknown[]) => ReactElement | null>(),
}));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useCreatedBy: () => undefined,
  useCreatedAt: () => undefined,
  useCanWrite: () => false,
  useValue: () => [h.localId],
}));
vi.mock('../chunks/PluginRuns/SyncableRecordActions', () => ({
  SyncableRecordActions: h.actions,
}));
vi.mock('@tomic/resource-ui/components/AllProps', () => ({
  default: () => <div data-testid='properties'>Properties</div>,
}));
vi.mock('../components/ClassDetail', () => ({ ClassDetail: () => null }));
vi.mock('../components/CommitDetail', () => ({ CommitDetail: () => null }));
vi.mock('@tomic/resource-ui/components/EditableTitle', () => ({
  EditableTitle: () => <h1>Stored resource</h1>,
}));
vi.mock('@tomic/resource-ui/components/ResourceDecorations', () => ({
  ResourceCoverImage: () => null,
}));
vi.mock('@tomic/resource-ui/components/forms/ValueForm/ValueForm', () => ({
  ValueForm: () => null,
}));
vi.mock('../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => vi.fn(),
}));
const resource = {
  subject: 'atomic:record',
  get: (property: string) =>
    property === core.properties.localId ? h.localId : undefined,
} as Resource<never>;
const show = () =>
  render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <ResourcePageDefault resource={resource} />
    </ThemeProvider>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  h.localId = 'ordinary:page';
  h.actions.mockImplementation(() => null);
});
afterEach(cleanup);
it('leaves ordinary resources free of Syncables discovery', () => {
  show();
  expect(screen.getByTestId('properties')).toBeTruthy();
  expect(h.actions).not.toHaveBeenCalled();
});
it.each(['syncables:node:stored', 'syncables:github-issue:retained'])(
  'mounts native actions before properties for %s without relying on the parent',
  async localId => {
    h.localId = localId;
    h.actions.mockImplementation(() => (
      <div data-testid='native-actions'>Related collections</div>
    ));
    show();
    const actions = await screen.findByTestId('native-actions');
    expect(
      actions.compareDocumentPosition(screen.getByTestId('properties')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(h.actions.mock.calls[0][0]).toMatchObject({ resource });
  },
);
