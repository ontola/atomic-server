// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
it('keeps the native numeric field and delegates the existing value and kind changes', () => {
  const value = vi.fn(),
    kind = vi.fn();
  render(
    <TableRowActionFields
      kinds={kinds}
      kind='increment'
      property='count'
      label='Count'
      value='1'
      values={[]}
      onKindChange={kind}
      onPropertyChange={() => {}}
      onValueChange={value}
      onLabelChange={() => {}}
    />,
  );
  fireEvent.change(screen.getByRole('spinbutton', { name: 'By' }), {
    target: { value: '0' },
  });
  expect(value).toHaveBeenCalledExactlyOnceWith('0');
  fireEvent.change(screen.getByLabelText('Does what'), {
    target: { value: 'setValue' },
  });
  expect(kind).toHaveBeenCalledExactlyOnceWith('setValue');
});
