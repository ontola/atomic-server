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
import { createTableQuickAddQueue } from './quickAddQueue.js';
afterEach(cleanup);
it('queues Enter submissions serially while preserving newly typed text', async () => {
  const releases: (() => void)[] = [],
    created = vi.fn();
  const create = vi.fn(
    () => new Promise<void>(resolve => releases.push(resolve)),
  );
  render(
    <TableQuickAddBar
      scope='table-one'
      label='Add item'
      field
      create={create}
      onCreated={created}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Add item' });
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
it('reports failed text without automatically retrying and continues accepted requests', async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(Error('Offline'))
    .mockResolvedValueOnce(undefined);
  render(
    <TableQuickAddBar scope='one' label='Add item' field create={create} />,
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Failed item' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(input, { target: { value: 'Next item' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Failed item');
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
});
it('keeps accepted writes bound to their original owner and suppresses stale success notifications', async () => {
  let release!: () => void;
  const oldCreate = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const oldCreated = vi.fn(),
    newCreate = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <TableQuickAddBar
      scope='old'
      label='Add'
      field
      create={oldCreate}
      onCreated={oldCreated}
    />,
  );
  const input = screen.getByRole('textbox');

  for (const value of ['First', 'Second']) {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  rerender(
    <TableQuickAddBar scope='new' label='Add' field create={newCreate} />,
  );
  release();
  await waitFor(() => expect(oldCreate).toHaveBeenCalledTimes(2));
  expect(oldCreated).not.toHaveBeenCalled();
  expect(newCreate).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
});
it('serializes a request enqueued synchronously by a completion subscriber', async () => {
  const queue = createTableQuickAddQueue(),
    calls: string[] = [];
  let added = false;
  queue.subscribe(() => {
    if (!added && queue.getSnapshot().pending === 0) {
      added = true;
      queue.enqueue({
        value: 'Second',
        create: async value => {
          calls.push(value);
        },
      });
    }
  });
  queue.enqueue({
    value: 'First',
    create: async value => {
      calls.push(value);
    },
  });
  await waitFor(() => expect(queue.getSnapshot().pending).toBe(0));
  expect(calls).toEqual(['First', 'Second']);
});
