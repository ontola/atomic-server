// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, afterEach, it, expect } from 'vitest';
import { renderHook, cleanup, act, waitFor } from '@testing-library/react';
import {
  Store,
  StoreContext,
  LoroLoader,
  core,
  dataBrowser,
  Datatype,
} from '@tomic/react';
import { useBlockQuery } from './useBlockQuery';

beforeAll(async () => {
  const web = await import('loro-crdt/web');
  await web.default({
    module_or_path: await readFile(
      createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
    ),
  });
  await LoroLoader.initializeLoro();
});
afterEach(cleanup);

async function setup() {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const [subject, datatype] of [
    [core.properties.parent, Datatype.ATOMIC_URL],
    [core.properties.classtype, Datatype.ATOMIC_URL],
    [core.properties.name, Datatype.STRING],
    [dataBrowser.properties.viewKind, Datatype.STRING],
    [dataBrowser.properties.viewFilters, Datatype.JSON],
    [dataBrowser.properties.viewDerivedColumns, Datatype.JSON],
    [dataBrowser.properties.viewGroupBy, Datatype.ATOMIC_URL],
    [dataBrowser.properties.viewEndProp, Datatype.ATOMIC_URL],
  ]) {
    const property = await store.newResource({ subject, noParent: true });
    await property.set(core.properties.datatype, datatype, false);
    await property.set(core.properties.shortname, 'property', false);
    await property.set(core.properties.description, 'Test metadata', false);
    await store.getProperty(subject);
  }

  const table = await store.newResource({
    subject: 'https://example.com/table',
    noParent: true,
  });
  const view = await store.newResource({
    subject: 'https://example.com/view',
    noParent: true,
  });
  await table.set(core.properties.name, 'Table', false);
  await table.set(core.properties.classtype, 'https://example.com/Row', false);
  await view.set(core.properties.name, 'View', false);
  await view.set(core.properties.parent, table.subject, false);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
  );

  return { store, table, view, wrapper };
}

it('ANDs owned view and block filters without borrowing the view statistics', async () => {
  const state = await setup();
  await state.view.set(
    dataBrowser.properties.viewFilters,
    [{ property: 'title', operator: 'eq', value: 'A' }],
    false,
  );
  const hook = renderHook(
    () =>
      useBlockQuery(state.table.subject, state.view.subject, [
        { property: 'status', operator: 'eq', value: 'Open' },
      ]),
    { wrapper: state.wrapper },
  );
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.filters).toEqual([
    { property: core.properties.isA, value: 'https://example.com/Row' },
    { property: 'title', operator: 'eq', value: 'A' },
    { property: 'status', operator: 'eq', value: 'Open' },
  ]);
});
it('blocks a missing computed filter, malformed block conditions and a newly foreign view', async () => {
  const state = await setup();
  const hook = renderHook(
    ({ query }: { query: unknown }) =>
      useBlockQuery(state.table.subject, state.view.subject, query),
    {
      wrapper: state.wrapper,
      initialProps: {
        query: [{ derived: 'missing', operator: 'gt', value: '2' }] as unknown,
      },
    },
  );
  await waitFor(() =>
    expect(hook.result.current.error).toBe(
      'Saved view configuration is invalid.',
    ),
  );
  expect(hook.result.current.ready).toBe(false);
  hook.rerender({ query: { malformed: true } });
  expect(hook.result.current.ready).toBe(false);
  hook.rerender({ query: [] });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () => {
    await state.view.set(
      core.properties.parent,
      'https://example.com/other-table',
      false,
    );
  });
  await waitFor(() =>
    expect(hook.result.current.error).toBe(
      'Saved view is unavailable in this table.',
    ),
  );
  expect(hook.result.current.ready).toBe(false);
});
it('shares implicit timer duration while respecting explicit empty derived columns', async () => {
  const state = await setup();
  await state.view.set(dataBrowser.properties.viewKind, 'timer', false);
  await state.view.set(dataBrowser.properties.viewGroupBy, 'start', false);
  await state.view.set(dataBrowser.properties.viewEndProp, 'end', false);
  await state.view.set(
    dataBrowser.properties.viewFilters,
    [{ derived: 'duration', operator: 'gte', value: '2' }],
    false,
  );
  const hook = renderHook(
    () => useBlockQuery(state.table.subject, state.view.subject, undefined),
    { wrapper: state.wrapper },
  );
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.expressionFilters[0]).toMatchObject({
    value: 7_200_000,
    expression: { vars: { start: 'start', end: 'end' } },
  });
  await act(async () => {
    await state.view.set(dataBrowser.properties.viewDerivedColumns, [], false);
  });
  await waitFor(() => expect(hook.result.current.ready).toBe(false));
});
