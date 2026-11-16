// @vitest-environment jsdom
// @wc-ignore-file
import { useContext } from 'react';
import { beforeAll, afterEach, afterAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { Store, StoreContext, LoroLoader } from '@tomic/react';
import { buildTheme } from '../../styling';
import { TablePageContext } from './tablePageContext';
import { TableFilterBar } from './TableFilterBar';

beforeAll(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const web = await import('loro-crdt/web');
  await web.default({
    module_or_path: await readFile(
      createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
    ),
  });
  await LoroLoader.initializeLoro();
});
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());
it('keeps a removed computed filter visible and delegates scoped removal through the actual page context', async () => {
  const remove = vi.fn();
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  function Page() {
    const defaults = useContext(TablePageContext);

    return (
      <TablePageContext.Provider
        value={{
          ...defaults,
          filters: [{ derived: 'removed', operator: 'gt', value: '2' }],
          removeFilter: remove,
        }}
      >
        <TableFilterBar columns={[]} derivedColumns={[]} />
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
  const chip = await screen.findByTestId('filter-chip');
  expect(chip.textContent).toContain('Unavailable column');
  fireEvent.click(chip);
  await screen.findByText('This column is unavailable.');
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(remove).toHaveBeenCalledExactlyOnceWith('derived:removed');
});
