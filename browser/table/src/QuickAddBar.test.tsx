// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { TableQuickAddBar } from './QuickAddBar.js';
afterEach(cleanup);
it('queues Enter submissions serially while preserving newly typed text', async () => {
  const releases: (() => void)[] = [],
    created = vi.fn();
  const create = vi.fn(
    () => new Promise<void>(resolve => releases.push(resolve)),
  );
  render(
    <TableQuickAddBar
      label='Add item'
      field
      create={create}
      onCreated={created}
    />,
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: ' First ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(input, { target: { value: 'Second' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(input, { target: { value: 'Still typing' } });
  expect(create).toHaveBeenCalledExactlyOnceWith('First');
  expect(
    (screen.getByRole('button', { name: 'Add item' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  releases[0]();
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create).toHaveBeenLastCalledWith('Second');
  releases[1]();
  await waitFor(() => expect(created).toHaveBeenCalledTimes(2));
  expect((input as HTMLInputElement).value).toBe('Still typing');
});
