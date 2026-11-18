// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TableFilterValueInput,
  canonicalTableFilterJson,
} from './FilterValueInput.js';

afterEach(cleanup);

it('keeps native numeric editing and the existing normalization on blur', () => {
  const change = vi.fn();
  render(
    <TableFilterValueInput kind='number' value='2.500' onChange={change} />,
  );
  const input = screen.getByRole('spinbutton');
  expect(input.getAttribute('type')).toBe('number');
  expect(input.getAttribute('inputmode')).toBeNull();
  fireEvent.change(input, { target: { value: '0' } });
  expect(change).toHaveBeenLastCalledWith('0');
  fireEvent.blur(input);
  expect(change).toHaveBeenLastCalledWith('2.5');
});

it('preserves existing boolean values and does not add recovery choices', () => {
  const change = vi.fn();
  const { rerender } = render(
    <TableFilterValueInput kind='boolean' value='false' onChange={change} />,
  );
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
    'false',
  );
  rerender(
    <TableFilterValueInput
      kind='text'
      value='missing'
      choices={['one']}
      onChange={change}
    />,
  );
  expect(
    screen.getAllByRole('option').map(option => option.textContent),
  ).toEqual(['Pick an option…', 'one']);
});

it('canonicalizes complete JSON and retains incomplete JSON without a write', () => {
  const change = vi.fn();
  const { rerender } = render(
    <TableFilterValueInput
      kind='json'
      value='{"b":2,"a":1}'
      onChange={change}
    />,
  );
  fireEvent.blur(screen.getByRole('textbox'));
  expect(change).toHaveBeenCalledExactlyOnceWith('{"a":1,"b":2}');
  change.mockClear();
  rerender(
    <TableFilterValueInput kind='json' value='{"a":' onChange={change} />,
  );
  fireEvent.blur(screen.getByRole('textbox'));
  expect(change).not.toHaveBeenCalled();
  expect(canonicalTableFilterJson('{"z":[{"b":1,"a":2}]}')).toBe(
    '{"z":[{"a":2,"b":1}]}',
  );
});
