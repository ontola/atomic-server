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

it('renders supplied tag options and leaves their selection to the host', () => {
  const onValueChange = vi.fn();
  render(
    <TableRowActionFields
      kinds={kinds}
      kind='setValue'
      property='status'
      label='Finish'
      value=''
      values={kinds[1].targets[0].values!}
      onKindChange={() => {}}
      onPropertyChange={() => {}}
      onValueChange={onValueChange}
      onLabelChange={() => {}}
      messages={{ pickOption: 'Choose status' }}
    />,
  );
  const input = screen.getByRole('combobox', { name: 'To' });
  expect(screen.getByRole('option', { name: 'Choose status' })).toBeTruthy();
  fireEvent.change(input, { target: { value: 'done' } });
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith('done');
  expect((input as HTMLSelectElement).value).toBe('');
});

it('keeps the existing free-text fallback when the host provides no tag options', () => {
  const onValueChange = vi.fn();
  render(
    <TableRowActionFields
      kinds={kinds}
      kind='setValue'
      property='status'
      label='Finish'
      value='stored-tag'
      values={[]}
      onKindChange={() => {}}
      onPropertyChange={() => {}}
      onValueChange={onValueChange}
      onLabelChange={() => {}}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'To' });
  expect((input as HTMLInputElement).value).toBe('stored-tag');
  fireEvent.change(input, { target: { value: 'another-tag' } });
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith('another-tag');
});
