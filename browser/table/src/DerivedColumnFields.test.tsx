// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { TableDerivedColumnFields } from './DerivedColumnFields.js';
afterEach(cleanup);
const columns = [
  { key: 'quantity-id', label: 'Quantity' },
  { key: 'price-id', label: 'Price' },
];
it('retains invalid formulas, exposes unknown-column suggestions and binds stable Property identities', async () => {
  const changed = vi.fn(),
    validate = vi.fn(({ formula }: { formula: string }) =>
      formula.endsWith('*') ? 'Incomplete formula' : null,
    );
  render(
    <TableDerivedColumnFields
      columns={columns}
      ready
      validate={validate}
      onChange={changed}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: ' Total ' },
  });
  const input = screen.getByRole('textbox', { name: 'Formula' });
  fireEvent.change(input, { target: { value: 'quantty * price' } });
  expect(screen.getByRole('alert').textContent).toContain(
    'Did you mean "quantity"?',
  );
  expect(changed.mock.lastCall?.[1]).toBe(false);
  fireEvent.change(input, { target: { value: 'quantity *' } });
  expect(screen.getByRole('alert').textContent).toBe('Incomplete formula');
  expect((input as HTMLInputElement).value).toBe('quantity *');
  fireEvent.change(input, { target: { value: 'quantity * price' } });
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      {
        id: '',
        label: 'Total',
        formula: 'quantity * price',
        vars: { quantity: 'quantity-id', price: 'price-id' },
      },
      true,
    ),
  );
});
it('expands stored aliases, waits for the engine and preserves local identity and width across metadata rerenders', async () => {
  const changed = vi.fn(),
    validate = vi.fn(() => null);
  const dates = [
    { key: 'end-id', label: 'End', instant: true },
    { key: 'start-id', label: 'Start', instant: true },
  ];
  const initial = {
    id: 'elapsed',
    label: 'Elapsed',
    formula: 'v0 - v1',
    vars: { v0: 'end-id', v1: 'start-id' },
    width: 222,
  };
  const { rerender } = render(
    <TableDerivedColumnFields
      initial={initial}
      columns={dates}
      ready={false}
      validate={validate}
      onChange={changed}
    />,
  );
  expect(
    (screen.getByRole('textbox', { name: 'Formula' }) as HTMLInputElement)
      .value,
  ).toBe('end - start');
  expect(changed.mock.lastCall?.[1]).toBe(false);
  expect(validate).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Local elapsed' },
  });
  rerender(
    <TableDerivedColumnFields
      initial={{ ...initial, id: 'peer', label: 'Peer' }}
      columns={dates}
      ready
      validate={validate}
      onChange={changed}
    />,
  );
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      {
        id: 'elapsed',
        label: 'Local elapsed',
        formula: 'end - start',
        vars: { end: 'end-id', start: 'start-id' },
        width: 222,
        valueKind: 'duration',
      },
      true,
    ),
  );
});
it('fills examples without replacing a typed label and applies the provided display kind', async () => {
  const changed = vi.fn();
  render(
    <TableDerivedColumnFields
      columns={columns}
      ready
      validate={() => null}
      onChange={changed}
      examples={[
        { title: 'Total', formula: 'quantity * price', valueKind: 'number' },
      ]}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'My amount' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Total' }));
  await waitFor(() =>
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      label: 'My amount',
      formula: 'quantity * price',
      valueKind: 'number',
    }),
  );
  expect(changed.mock.lastCall?.[1]).toBe(true);
});
it('keeps Save unavailable when a ready validator cannot provide a result', () => {
  const changed = vi.fn();
  render(
    <TableDerivedColumnFields
      initial={{
        id: 'total',
        label: 'Total',
        formula: 'quantity',
        vars: { quantity: 'quantity-id' },
      }}
      columns={columns}
      ready
      validate={() => undefined}
      onChange={changed}
    />,
  );
  expect(changed.mock.lastCall?.[1]).toBe(false);
  expect(
    (screen.getByRole('textbox', { name: 'Formula' }) as HTMLInputElement)
      .value,
  ).toBe('quantity');
});
