// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  TableRowActionFields,
  type TableRowActionKind,
} from './RowActionFields.js';
afterEach(cleanup);
const kinds: TableRowActionKind[] = [
  {
    kind: 'increment',
    title: 'Add a number',
    description: 'A numeric step',
    defaultLabel: '+1',
    valueField: { label: 'By', input: 'number' },
    targets: [
      {
        key: 'count',
        option: (
          <option key='count' value='count'>
            Count
          </option>
        ),
      },
    ],
  },
  {
    kind: 'setValue',
    title: 'Set a value',
    description: 'A fixed value',
    defaultLabel: 'Set',
    valueField: { label: 'To', input: 'select' },
    targets: [
      {
        key: 'status',
        option: (
          <option key='status' value='status'>
            Status
          </option>
        ),
        values: [
          {
            key: 'done',
            option: (
              <option key='done' value='done'>
                Done
              </option>
            ),
          },
        ],
      },
    ],
  },
];
it('retains invalid numeric text, accepts zero and preserves the original action identity', async () => {
  const changed = vi.fn();
  const { rerender } = render(
    <TableRowActionFields
      kinds={kinds}
      initial={{
        id: 'original',
        kind: 'increment',
        label: 'Count',
        property: 'count',
        value: 1,
      }}
      onChange={changed}
    />,
  );
  const value = screen.getByRole('textbox', { name: 'By' });

  for (const raw of ['-', '1e', '0x10', '']) {
    fireEvent.change(value, { target: { value: raw } });
    await waitFor(() => expect(changed.mock.lastCall?.[1]).toBe(false));
    expect((value as HTMLInputElement).value).toBe(raw);
  }

  fireEvent.change(value, { target: { value: '0' } });
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      {
        id: 'original',
        kind: 'increment',
        label: 'Count',
        property: 'count',
        value: 0,
      },
      true,
    ),
  );
  rerender(
    <TableRowActionFields
      kinds={kinds}
      initial={{
        id: 'incoming',
        kind: 'setValue',
        label: 'Peer',
        property: 'status',
        value: 'done',
      }}
      onChange={changed}
    />,
  );
  expect(
    (screen.getByRole('textbox', { name: 'By' }) as HTMLInputElement).value,
  ).toBe('0');
  expect(changed.mock.lastCall?.[0].id).toBe('original');
});
it('resets target and literal on kind changes and validates tag identity', async () => {
  const changed = vi.fn();
  render(<TableRowActionFields kinds={kinds} onChange={changed} />);
  fireEvent.change(screen.getByLabelText('To column'), {
    target: { value: 'count' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'By' }), {
    target: { value: '-2' },
  });
  await waitFor(() => expect(changed.mock.lastCall?.[1]).toBe(true));
  fireEvent.change(screen.getByLabelText('Does what'), {
    target: { value: 'setValue' },
  });
  expect((screen.getByLabelText('To column') as HTMLSelectElement).value).toBe(
    '',
  );
  await waitFor(() => expect(changed.mock.lastCall?.[1]).toBe(false));
  fireEvent.change(screen.getByLabelText('To column'), {
    target: { value: 'status' },
  });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'done' } });
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      {
        id: '',
        kind: 'setValue',
        label: 'Set',
        property: 'status',
        value: 'done',
      },
      true,
    ),
  );
});
