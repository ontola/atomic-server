// @vitest-environment jsdom
import { StrictMode, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { FancyTable } from './chunks/TableEditor/TableEditor.js';
import {
  ValueCell,
  type ValueCellProps,
  type ValueCellState,
} from './ValueCell.js';
import { StringCell } from './chunks/TablePage/EditorCells/StringCell.js';
import { IntegerCell } from './chunks/TablePage/EditorCells/IntegerCell.js';
import { integerSeed } from './chunks/TablePage/EditorCells/numberInput.js';

vi.mock('./chunks/TableEditor/DndWrapper.js', () => ({
  DndWrapper: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./chunks/TableEditor/TableHeader.js', () => ({
  TableHeader: () => <div role='row' />,
}));
vi.mock('react-virtualized-auto-sizer', () => ({
  AutoSizer: ({
    renderProp,
  }: {
    renderProp: (size: { height: number }) => ReactNode;
  }) => renderProp({ height: 400 }),
}));
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const defaults: ValueCellProps = {
  identity: 'row:a/name',
  rowIndex: 0,
  columnIndex: 1,
  label: 'Name',
  value: 'stored',
  onChange: () => {},
  editStart: { kind: 'value', fromCharacter: key => key },
  renderEditor: state => <StringCell.Edit {...state} property='name' />,
  renderDisplay: state => <StringCell.Display {...state} property='name' />,
};

function Grid({ overrides }: { overrides: Partial<ValueCellProps> }) {
  return (
    <StrictMode>
      <FancyTable
        columns={['name']}
        itemCount={1}
        columnToKey={String}
        labelledBy='title'
        HeadingComponent={() => null}
        NewColumnButtonComponent={() => null}
      >
        {() => <ValueCell {...defaults} {...overrides} />}
      </FancyTable>
    </StrictMode>
  );
}

function cell() {
  return document.querySelector<HTMLElement>(
    '[aria-rowindex="2"] > [aria-colindex="2"]',
  )!;
}

async function typeToEdit(key: string) {
  fireEvent.mouseDown(cell());
  fireEvent.click(cell());
  expect(screen.queryByRole('textbox')).toBeNull();
  await act(async () => {
    fireEvent.keyDown(cell(), { key });
  });
}

it('preserves the first character while the host value has not caught up', async () => {
  const change = vi.fn();
  render(<Grid overrides={{ onChange: change }} />);
  expect(change).not.toHaveBeenCalled();
  await typeToEdit('r');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('r');
  expect(change).toHaveBeenCalledWith('r');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'row' } });
  expect(change).toHaveBeenLastCalledWith('row');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('row');
});

it('seeds a number as text and only writes a committed parsed value', async () => {
  const change = vi.fn();
  const seedDraft = vi.fn();
  render(
    <Grid
      overrides={{
        value: 12,
        onChange: change,
        editStart: {
          kind: 'text',
          accepts: key => integerSeed.test(key),
          onSeed: seedDraft,
        },
        renderEditor: state => (
          <IntegerCell.Edit {...state} property='quantity' />
        ),
      }}
    />,
  );
  await typeToEdit('-');
  expect(seedDraft).toHaveBeenCalledWith('-');
  expect(change).not.toHaveBeenCalled();
  const input = screen.getByRole('textbox');
  expect((input as HTMLInputElement).value).toBe('-');
  fireEvent.change(input, { target: { value: '-2' } });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' });
  });
  await waitFor(() => expect(change).toHaveBeenCalledWith(-2));
});

function SeedEditor({ value, seed }: ValueCellState) {
  const [text, setText] = useState(seed ?? String(value));

  return <input value={text} onChange={event => setText(event.target.value)} />;
}

it('opens a picker without interpreting a typed digit as a stored value', async () => {
  const change = vi.fn();
  render(
    <Grid
      overrides={{
        value: 25,
        onChange: change,
        editStart: { kind: 'picker' },
        renderEditor: state => <SeedEditor {...state} />,
      }}
    />,
  );
  await typeToEdit('7');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('25');
  expect(change).not.toHaveBeenCalled();
});

it('discards a seed when a virtual cell is assigned another row/property identity', async () => {
  const change = vi.fn();
  const { rerender } = render(<Grid overrides={{ onChange: change }} />);
  await typeToEdit('r');
  rerender(
    <Grid
      overrides={{ identity: 'row:b/name', value: 'other', onChange: change }}
    />,
  );
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('other');
  expect(change.mock.calls).toEqual([['r']]);
});

it('leaves the native context menu available during editing', async () => {
  const menu = vi.fn();
  render(<Grid overrides={{ onContextMenu: menu }} />);
  fireEvent.contextMenu(cell());
  expect(menu).toHaveBeenCalledTimes(1);
  await typeToEdit('r');
  fireEvent.contextMenu(screen.getByRole('textbox'));
  expect(menu).toHaveBeenCalledTimes(1);
});
