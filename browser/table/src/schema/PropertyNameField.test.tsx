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

it('retains existing shortnames and derives only new provisional names', () => {
  const slug = vi.fn(() => 'new-column');
  expect(
    nameTableProperty(
      { name: 'Old', shortname: 'stable', existing: true },
      'New',
      slug,
    ).shortname,
  ).toBe('stable');
  expect(slug).not.toHaveBeenCalled();
  expect(
    nameTableProperty(
      { name: '', shortname: '', existing: false },
      ' New column ',
      slug,
    ).shortname,
  ).toBe('new-column');
  expect(slug).toHaveBeenCalledWith('New column');
});

it('preserves input identity and raw change/blur callbacks', () => {
  const change = vi.fn(),
    blur = vi.fn();
  render(
    <PropertyNameField value=' Raw name ' onChange={change} onBlur={blur} />,
  );
  const input = screen.getByPlaceholderText('New Column') as HTMLInputElement;
  expect(input.id).toBe('name-form');
  expect(input.value).toBe(' Raw name ');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(change).toHaveBeenCalledWith('');
  expect(blur).toHaveBeenCalledOnce();
});

it('retains delayed focus/selection when the host changes resource identity', async () => {
  const { rerender } = render(
    <PropertyNameField
      value='First'
      onChange={() => {}}
      autoFocus
      focusKey='one'
    />,
  );
  const input = screen.getByPlaceholderText('New Column') as HTMLInputElement;
  await waitFor(() => expect(input.selectionEnd).toBe(5));
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
