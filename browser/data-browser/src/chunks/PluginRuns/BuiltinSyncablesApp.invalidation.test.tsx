// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { core } from '@tomic/lib';
import { AppExecutionRegistry } from '../AppPage/AppExecutionRuntime';
import { BuiltinSyncablesApp } from './BuiltinSyncablesApp';
import type { AppFrameProfile } from '../AppPage/AppFrame';

const state = vi.hoisted(() => ({
  actor: { subject: 'atomic:agent:person' },
  revision: 1,
  contextGate: undefined as Promise<void> | undefined,
  contextFailure: undefined as Error | undefined,
  loads: 0,
  preparationGate: undefined as Promise<void> | undefined,
  subscriptions: new Set<() => void>(),
  profile: undefined as AppFrameProfile | undefined,
  unmounted: vi.fn(),
  runs: undefined as AppExecutionRegistry | undefined,
}));
const resource = {
  get: (property: string) =>
    property === core.properties.name ? 'Source' : undefined,
  getSubjects: () => [],
  canWrite: async () => [true],
  set: async () => undefined,
  save: async () => undefined,
};
const store = {
  getAgent: () => state.actor,
  getServerUrl: () => 'https://node.example',
  getResource: async () => resource,
  subscribe: () => () => undefined,
};
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => store,
  useCurrentAgent: () => [state.actor],
  useServerURL: () => ['https://node.example'],
}));
vi.mock('../AppPage/AppExecutionRuntime', async original => ({
  ...(await original<typeof import('../AppPage/AppExecutionRuntime')>()),
  useAppExecutions: () => state.runs,
}));
vi.mock('../AppPage/AppFrame', async () => {
  const { useEffect } = await import('react');

  return {
    AppFrame: ({ profile }: { profile: AppFrameProfile }) => {
      state.profile = profile;
      useEffect(() => () => state.unmounted(), [profile]);

      return (
        <div data-testid='sync-frame'>{String(profile.context?.revision)}</div>
      );
    },
  };
});
vi.mock('@helpers/integrationProxy', () => ({
  getIntegrationProxy: () => 'https://proxy.example',
  useIntegrationProxy: () => 'https://proxy.example',
}));
vi.mock('@helpers/proxyConnections', () => ({ ProxyConnections: class {} }));
vi.mock('@components/AtomicLink', () => ({ AtomicLink: () => null }));
vi.mock('../../routes/ShowRoute', () => ({
  ShowRoute: { useSearch: () => undefined },
}));
vi.mock('./syncablePlatform', async original => ({
  ...(await original<typeof import('./syncablePlatform')>()),
  findSyncablePlatform: async () => 'atomic:installation',
}));
vi.mock('./syncableDocument', () => ({
  fetchSyncableDocument: async () => ({
    document: {
      openapi: '3.0.3',
      info: { title: 'Fixture', version: '1' },
      servers: [{ url: 'https://api.example' }],
      paths: {},
      components: { crudResources: {} },
    },
  }),
}));
vi.mock('./syncableApiSchema', () => ({
  syncableApiSchema: async () => ({ classes: {}, properties: {} }),
}));
vi.mock('./syncableFlatAdoption', () => ({
  collectSyncableFlatAdoption: async () => {
    await state.preparationGate;

    return { aliases: [], blocks: [], warnings: [], rules: [] };
  },
  unsupportedLegacyFlatBlocks: () => [],
}));
vi.mock('./builtinSyncablesProfile', () => ({
  assertSyncAppDrive: () => undefined,
  assertSyncAppContext: (context: { revision: number }) => {
    if (context.revision !== state.revision)
      throw new Error('The Sync filter source entity changed');
  },
  syncAppOriginEntityKeys: () => [],
  subscribeSyncAppContext: (_context: unknown, cancel: () => void) => {
    state.subscriptions.add(cancel);

    return () => state.subscriptions.delete(cancel);
  },
  syncAppContext: async () => {
    state.loads++;
    const revision = state.revision;
    await state.contextGate;
    if (state.contextFailure) throw state.contextFailure;

    return {
      subject: 'atomic:source',
      drive: 'atomic:drive',
      revision,
      kind: 'collection',
      resource: 'event',
      sourceKey: 'canonical-key',
      platform: 'calendar-service',
      proxyOrigin: 'https://proxy.example',
      proxyTransport: 'host',
      rule: {
        subject: 'atomic:rule',
        key: 'rule-key',
        resource: 'event',
        definition: {},
      },
      schema: {
        classes: {},
        properties: { 'syncable-mirror-status': 'atomic:status' },
      },
    };
  },
  canonicalSyncAppContext: (context: unknown) => context,
  syncProxyTransport: () => ({}),
}));
beforeEach(() => {
  state.revision = 1;
  state.contextGate = undefined;
  state.contextFailure = undefined;
  state.loads = 0;
  state.preparationGate = undefined;
  state.subscriptions.clear();
  state.profile = undefined;
  state.unmounted.mockClear();
  state.runs = new AppExecutionRegistry();
});
afterEach(() => {
  cleanup();
  state.runs?.clear();
});

it('unmounts stale controls, cancels preparing work and reloads the current source', async () => {
  render(
    <BuiltinSyncablesApp
      drive='atomic:drive'
      table='atomic:source'
      ruleSubject='atomic:rule'
    />,
  );
  expect((await screen.findByTestId('sync-frame')).textContent).toBe('1');
  let releaseWorker!: () => void;
  state.preparationGate = new Promise(resolve => {
    releaseWorker = resolve;
  });
  await act(async () => {
    await state.profile!.execution!('start');
  });
  const key = JSON.stringify(['atomic:drive', 'atomic:source', 'atomic:rule']);
  expect(state.runs!.isRunning(key)).toBe(true);
  let releaseControls!: () => void;
  state.contextGate = new Promise(resolve => {
    releaseControls = resolve;
  });
  await act(async () => {
    state.revision = 2;
    for (const invalidate of [...state.subscriptions]) invalidate();
  });
  expect(screen.queryByTestId('sync-frame')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Opening Sync');
  expect(state.unmounted).toHaveBeenCalledOnce();
  expect(state.runs!.isRunning(key)).toBe(false);
  await act(async () => {
    releaseControls();
    releaseWorker();
  });
  await waitFor(() =>
    expect(screen.getByTestId('sync-frame').textContent).toBe('2'),
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(state.runs!.getSnapshot()).toEqual([]);
});

it('keeps current controls mounted for status-only cancellation', async () => {
  render(
    <BuiltinSyncablesApp
      drive='atomic:drive'
      table='atomic:source'
      ruleSubject='atomic:rule'
    />,
  );
  await screen.findByTestId('sync-frame');
  await act(async () => {
    for (const invalidate of [...state.subscriptions]) invalidate();
  });
  expect(screen.getByTestId('sync-frame').textContent).toBe('1');
  expect(state.unmounted).not.toHaveBeenCalled();
});

it('shows a failed replacement once and clears its error when another source is opened', async () => {
  const mounted = render(
    <BuiltinSyncablesApp
      drive='atomic:drive'
      table='atomic:source'
      ruleSubject='atomic:rule'
    />,
  );
  await screen.findByTestId('sync-frame');
  await act(async () => {
    state.contextFailure = new Error(
      'The saved Sync filter source identity changed',
    );
    state.revision = 2;
    for (const invalidate of [...state.subscriptions]) invalidate();
  });
  expect((await screen.findByRole('alert')).textContent).toContain(
    'source identity changed',
  );
  expect(screen.queryByTestId('sync-frame')).toBeNull();
  expect(state.loads).toBe(2);
  state.contextFailure = undefined;
  mounted.rerender(
    <BuiltinSyncablesApp
      drive='atomic:drive'
      table='atomic:source'
      ruleSubject='atomic:other-rule'
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId('sync-frame').textContent).toBe('2'),
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(state.loads).toBe(3);
});
