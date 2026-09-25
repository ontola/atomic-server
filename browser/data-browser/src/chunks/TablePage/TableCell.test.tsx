// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import {
  Datatype,
  LoroLoader,
  Store,
  StoreContext,
  type Property,
  type Resource,
} from '@tomic/react';
import { FancyTable } from '@chunks/TableEditor';
import { buildTheme } from '../../styling';
import { TableCell } from './TableCell';

vi.mock('@chunks/TableEditor/DndWrapper', () => ({
  DndWrapper: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@chunks/TableEditor/TableHeader', () => ({
  TableHeader: () => <div role='row' />,
}));
// jsdom has no layout, so the grid's height probe would hand react-window a
// zero-height viewport and no row would render.
vi.mock('react-virtualized-auto-sizer', () => ({
  AutoSizer: ({
    renderProp,
  }: {
    renderProp: (props: { height: number }) => React.ReactNode;
  }) => renderProp({ height: 400 }),
}));
vi.mock('./helpers/useColumnLabel', () => ({ useColumnLabel: () => 'Day' }));

const DAY = 'https://example.com/properties/day';
const STORED = '2026-09-25';

const dayProperty: Property = {
  subject: DAY,
  datatype: Datatype.DATE,
  shortname: 'day',
  description: '',
};

beforeAll(async () => {
  // The app's vite config sends every `loro-crdt` import to the `web` build,
  // which fetches its WASM over HTTP. Hand it the file from disk instead;
  // the loader's own init then finds it initialized.
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = (await import('loro-crdt/web')) as unknown as {
    default: (opts: { module_or_path: Uint8Array }) => Promise<unknown>;
  };
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();

  class ResizeObserverStub {
    public observe() {}
    public unobserve() {}
    public disconnect() {}
  }

  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

async function renderDateCell(): Promise<Resource> {
  const store = new Store({ serverUrl: 'https://example.com' });
  // A `_new:` row stays local, so nothing here reaches for a server.
  const row = await store.newResource({
    subject: '_new:day-row',
    noParent: true,
  });
  await row.set(DAY, STORED, false);

  render(
    <StoreContext value={store}>
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <FancyTable
          columns={['title', 'day']}
          itemCount={1}
          columnToKey={String}
          labelledBy='table-title'
          HeadingComponent={() => <></>}
          NewColumnButtonComponent={() => null}
        >
          {() => (
            <TableCell
              rowIndex={0}
              columnIndex={1}
              subject={row.subject}
              property={dayProperty}
            />
          )}
        </FancyTable>
      </ThemeProvider>
    </StoreContext>,
  );

  return row;
}

function dateCell(): HTMLElement {
  const cell = document.querySelector(
    '[aria-rowindex="2"] > [aria-colindex="2"]',
  );

  if (!cell) {
    throw new Error('No date cell rendered');
  }

  return cell as HTMLElement;
}

/** Select the cell (not editing yet) and type one character on it. */
async function typeOnSelectedCell(key: string) {
  fireEvent.mouseDown(dateCell());
  fireEvent.click(dateCell());
  expect(screen.queryByRole('textbox')).toBeNull();

  await act(async () => {
    fireEvent.keyDown(dateCell(), { key });
  });
  await settle();
}

/** Lets the cell's async writes (`resource.set`, the debounced save) land. */
async function settle() {
  await act(() => new Promise(resolve => setTimeout(resolve, 300)));
}

describe('typing on a selected date cell (#1822)', () => {
  it('opens the editor with the character and keeps the stored date', async () => {
    const row = await renderDateCell();

    await typeOnSelectedCell('2');

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('2');
    expect(row.get(DAY)).toBe(STORED);
  });

  it('keeps the stored date when the edit is abandoned with Escape', async () => {
    const row = await renderDateCell();

    await typeOnSelectedCell('2');
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    });
    await settle();

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(row.get(DAY)).toBe(STORED);
    expect(dateCell().textContent).toMatch(/25.*2026|2026.*25/);
  });

  it('stores the date once the typed text is committed', async () => {
    const row = await renderDateCell();

    await typeOnSelectedCell('2');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '2026-10-2' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() => expect(row.get(DAY)).toBe('2026-10-02'));
  });
});
