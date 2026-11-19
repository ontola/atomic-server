// @vitest-environment jsdom
// @wc-ignore-file
import { useContext } from 'react';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { Store, StoreContext, LoroLoader, core, Datatype } from '@tomic/react';
import { buildTheme } from '../../styling';
import { TablePageContext } from './tablePageContext';
import { TableHeading } from './TableHeading';

// Backend property-command dialog/menu stays outside the shared heading.
vi.mock('./TableHeadingMenu', () => ({
  TableHeadingMenu: () => <button>Property commands</button>,
}));
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
it('resolves required property metadata and dispatches shared heading sort by stable identity', async () => {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
  const property = 'https://example.com/quantity';
  const rowClass = 'https://example.com/row';
  const resource = await store.newResource({
    subject: property,
    noParent: true,
  });
  await resource.set(core.properties.name, 'Quantity label', false);
  const cls = await store.newResource({ subject: rowClass, noParent: true });
  await cls.set(core.properties.requires, [property], false);
  const sort = vi.fn();

  function Page() {
    const defaults = useContext(TablePageContext);

    return (
      <TablePageContext.Provider
        value={{
          ...defaults,
          tableClassSubject: rowClass,
          setSortBy: sort,
          sorting: { prop: property, sortDesc: true },
        }}
      >
        <TableHeading
          column={{
            key: property,
            property: {
              subject: property,
              datatype: Datatype.INTEGER,
              shortname: 'quantity',
              description: '',
            },
          }}
        />
      </TablePageContext.Provider>
    );
  }

  render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <Page />
      </ThemeProvider>
    </StoreContext.Provider>,
  );
  const label = await screen.findByRole('button', { name: 'Quantity label*' });
  fireEvent.click(label);
  expect(sort).toHaveBeenCalledExactlyOnceWith(property);
  expect(
    screen.getByRole('button', { name: 'Property commands' }),
  ).toBeTruthy();
});
