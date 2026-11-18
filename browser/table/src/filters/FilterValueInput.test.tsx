// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import {
  TableFilterValueInput,
  canonicalTableFilterJson,
} from './FilterValueInput.js';
afterEach(cleanup);
it('retains incomplete numeric query text and does not round native integer strings on blur', () => {
  const change = vi.fn();
  const view = render(
    <TableFilterValueInput
      kind='number'
      value='1e'
      onChange={change}
      textType='search'
      label='Filter'
    />,
  );
  fireEvent.blur(screen.getByRole('searchbox', { name: 'Filter' }));
  expect(change).not.toHaveBeenCalled();
  view.rerender(
    <TableFilterValueInput
      kind='number'
      value='9007199254740993'
      onChange={change}
    />,
  );
  fireEvent.blur(screen.getByRole('textbox'));
  expect(change).not.toHaveBeenCalled();
  view.rerender(
    <TableFilterValueInput
      kind='number'
      value='0.00002500'
      normalizeNumbers
      onChange={change}
    />,
  );
  fireEvent.blur(screen.getByRole('textbox'));
  expect(change).toHaveBeenCalledExactlyOnceWith('0.000025');
});
it('preserves false and unknown saved choices without choosing a default', () => {
  const change = vi.fn();
  const view = render(
    <TableFilterValueInput kind='boolean' value='false' onChange={change} />,
  );
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
    'false',
  );
  view.rerender(
    <TableFilterValueInput
      kind='text'
      value='removed-option'
      choices={['a', 'b']}
      onChange={change}
    />,
  );
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
    'removed-option',
  );
  expect(
    (
      screen.getByRole('option', {
        name: 'removed-option',
      }) as HTMLOptionElement
    ).disabled,
  ).toBe(true);
  expect(change).not.toHaveBeenCalled();
});
it('canonicalizes complete JSON only, retaining invalid text and array order', () => {
  const change = vi.fn();
  const view = render(
    <TableFilterValueInput
      kind='json'
      value='{"b":2,"a":[3,{"z":0,"a":false}]}'
      onChange={change}
    />,
  );
  fireEvent.blur(screen.getByRole('textbox'));
  expect(change).toHaveBeenCalledExactlyOnceWith(
    '{"a":[3,{"a":false,"z":0}],"b":2}',
  );
  change.mockClear();
  view.rerender(
    <TableFilterValueInput kind='json' value='{"a":' onChange={change} />,
  );
  fireEvent.blur(screen.getByRole('textbox'));
  expect(change).not.toHaveBeenCalled();
  expect(canonicalTableFilterJson('{')).toBeUndefined();
});
it('keeps disabled reference picker callbacks from modifying the query', () => {
  const change = vi.fn();
  render(
    <TableFilterValueInput
      kind='reference'
      value='old'
      disabled
      onChange={change}
      referenceInput={state => (
        <button onClick={() => state.onChange('new')}>Picker</button>
      )}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Picker' }));
  expect(change).not.toHaveBeenCalled();
});
