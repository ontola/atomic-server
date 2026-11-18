// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { PropertyNameField, nameTableProperty } from './PropertyNameField.js';

afterEach(cleanup);

it('keeps an existing property shortname when its display name changes', () => {
  expect(
    nameTableProperty(
      { name: 'Quantity', shortname: 'quantity', existing: true },
      'Amount',
      () => 'amount',
    ),
  ).toEqual({ name: 'Amount', shortname: 'quantity', existing: true });
});
it('derives only a new property provisional shortname', () => {
  const slug = vi.fn(() => 'new-column');
  expect(
    nameTableProperty(
      { name: '', shortname: 'column', existing: false },
      ' New column ',
      slug,
    ).shortname,
  ).toBe('new-column');
  expect(slug).toHaveBeenCalledWith('New column');
});
it('retains raw names and exposes accessible validation without saving', () => {
  const change = vi.fn();
  render(
    <PropertyNameField value=' Raw name ' onChange={change} error='Required' />,
  );
  const input = screen.getByRole('textbox', { name: 'Column name' });
  expect((input as HTMLInputElement).value).toBe(' Raw name ');
  expect(input.getAttribute('aria-describedby')).toBe(
    screen.getByRole('alert').id,
  );
  fireEvent.change(input, { target: { value: '' } });
  expect(change).toHaveBeenCalledWith('');
});
it('autofocuses and selects a new draft name and respects disabled fields', async () => {
  const { rerender } = render(
    <PropertyNameField value='column' onChange={() => {}} autoFocus />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  await waitFor(() => expect(input.selectionStart).toBe(0));
  expect(input.selectionEnd).toBe(6);
  rerender(<PropertyNameField value='column' onChange={() => {}} disabled />);
  expect(input.disabled).toBe(true);
});

it('keeps baseline delayed selection after switching the owning resource', async () => {
  const { rerender } = render(
    <PropertyNameField
      value='First'
      onChange={() => {}}
      autoFocus
      focusKey='one'
    />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  await waitFor(() => expect(input.selectionStart).toBe(0));
  input.blur();
  rerender(
    <PropertyNameField
      value='Second'
      onChange={() => {}}
      autoFocus
      focusKey='two'
    />,
  );
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(6);
});
