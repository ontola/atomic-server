// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  core,
  Datatype,
  LoroLoader,
  Store,
  StoreContext,
  useResource,
  useString,
  type Collection,
  type Property,
} from '@tomic/react';
import { buildTheme } from '../../styling';
import { QuickFilterField } from './QuickFilterField';
import { subjectListCollection, useQuickFilter } from './useQuickFilter';
import { useAllMembers } from './helpers/useAllMembers';

beforeAll(async () => {
  // As in TableCell.test: hand loro-crdt its WASM from disk, not over HTTP.
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = (await import('loro-crdt/web')) as unknown as {
    default: (opts: { module_or_path: Uint8Array }) => Promise<unknown>;
  };
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

afterEach(cleanup);

// `_new:` subjects stay local, so nothing here reaches for a server — the
// properties included.
const TITLE = '_new:prop-title';
const OWNER = '_new:prop-owner';
const DONE = '_new:prop-done';

const properties: Property[] = [
  { subject: TITLE, datatype: Datatype.STRING, shortname: 'title' },
  { subject: OWNER, datatype: Datatype.ATOMIC_URL, shortname: 'owner' },
  { subject: DONE, datatype: Datatype.BOOLEAN, shortname: 'done' },
].map(p => ({ ...p, description: '' }));

const columns = properties.map(property => ({ property }));

interface Fixture {
  store: Store;
  rows: string[];
  /** The rows a "Done is true" column filter lets through, in order. */
  doneRows: string[];
}

async function fixture(): Promise<Fixture> {
  const store = new Store({ serverUrl: 'https://example.com' });

  const make = async (subject: string, values: Record<string, unknown>) => {
    const resource = await store.newResource({ subject, noParent: true });

    for (const [property, value] of Object.entries(values)) {
      await resource.set(property, value as never, false);
    }

    return resource.subject;
  };

  for (const [subject, name] of [
    [TITLE, 'Title'],
    [OWNER, 'Owner'],
    [DONE, 'Done'],
  ]) {
    await make(subject, { [core.properties.name]: name });
  }

  const ada = await make('_new:ada', {
    [core.properties.name]: 'Ada Lovelace',
  });

  const rows = [
    await make('_new:row-1', { [TITLE]: 'Buy oat milk', [DONE]: true }),
    await make('_new:row-2', { [TITLE]: 'Buy cow milk', [OWNER]: ada }),
    await make('_new:row-3', { [TITLE]: 'Fix the roof', [DONE]: true }),
  ];

  return { store, rows, doneRows: [rows[0], rows[2]] };
}

function RowTitle({ subject }: { subject: string }) {
  const [title] = useString(useResource(subject), TITLE);

  return <li>{title}</li>;
}

/**
 * The toolbar field over a view's rows, wired the way the table page wires it:
 * the column filter decides which collection the view has (the store answers
 * it), and the quick filter narrows that collection further.
 */
function Harness({ rows, doneRows }: Omit<Fixture, 'store'>) {
  const [text, setText] = useState('');
  const [onlyDone, setOnlyDone] = useState(false);
  const [all] = useState(() => subjectListCollection(rows));
  const [done] = useState(() => subjectListCollection(doneRows));
  const collection: Collection = onlyDone ? done : all;

  const quickFilter = useQuickFilter(collection, columns, text);
  const shown = useAllMembers(quickFilter.collection);

  return (
    <>
      <QuickFilterField value={text} onChange={setText} />
      <label>
        <input
          type='checkbox'
          checked={onlyDone}
          onChange={e => setOnlyDone(e.target.checked)}
        />
        Column filter: Done
      </label>
      <ul aria-label='Rows'>
        {shown.map(subject => (
          <RowTitle key={subject} subject={subject} />
        ))}
      </ul>
    </>
  );
}

async function renderHarness() {
  const { store, ...rest } = await fixture();

  render(
    <StoreContext value={store}>
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <Harness {...rest} />
      </ThemeProvider>
    </StoreContext>,
  );

  await expectRows(['Buy oat milk', 'Buy cow milk', 'Fix the roof']);
}

async function expectRows(titles: string[]) {
  await waitFor(() =>
    expect(
      screen
        .getByRole('list', { name: 'Rows' })
        .querySelectorAll('li')
        .values()
        .map(li => li.textContent)
        .toArray(),
    ).toEqual(titles),
  );
}

const field = () =>
  screen.getByRole('textbox', { name: 'Find rows containing text' });

async function type(text: string) {
  await act(async () => {
    fireEvent.change(field(), { target: { value: text } });
  });
}

describe('the quick filter field', () => {
  it('keeps the rows that show the text, in any column', async () => {
    await renderHarness();

    await type('MILK');
    await expectRows(['Buy oat milk', 'Buy cow milk']);

    // A reference, by its title.
    await type('lovelace');
    await expectRows(['Buy cow milk']);

    // A ticked checkbox, by its column's label.
    await type('done');
    await expectRows(['Buy oat milk', 'Fix the roof']);
  });

  it('says so when nothing matches, and restores every row when cleared', async () => {
    await renderHarness();

    await type('garden');
    await expectRows([]);

    await act(async () => {
      fireEvent.click(screen.getByTitle('Clear'));
    });
    expect((field() as HTMLInputElement).value).toBe('');
    await expectRows(['Buy oat milk', 'Buy cow milk', 'Fix the roof']);
  });

  it('clears with Escape', async () => {
    await renderHarness();

    await type('roof');
    await expectRows(['Fix the roof']);

    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Escape' });
    });
    expect((field() as HTMLInputElement).value).toBe('');
    await expectRows(['Buy oat milk', 'Buy cow milk', 'Fix the roof']);
  });

  it('only offers the clear button while there is text', async () => {
    await renderHarness();

    expect(screen.queryByTitle('Clear')).toBeNull();
    await type('milk');
    expect(screen.getByTitle('Clear')).toBeTruthy();
  });

  it('narrows what a column filter lets through, and not more', async () => {
    await renderHarness();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Column filter: Done'));
    });
    await expectRows(['Buy oat milk', 'Fix the roof']);

    await type('milk');
    // "Buy cow milk" matches the text, but the column filter keeps it out.
    await expectRows(['Buy oat milk']);

    // Dropping the column filter keeps the text, and lets the other match in.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Column filter: Done'));
    });
    await expectRows(['Buy oat milk', 'Buy cow milk']);
  });
});
