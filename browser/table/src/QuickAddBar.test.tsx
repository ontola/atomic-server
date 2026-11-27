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

it('reports a failed request and continues the already accepted queue', async () => {
  const error = new Error('write failed');
  let reject!: (error: Error) => void;
  const create = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(undefined);
  const onError = vi.fn(),
    onCreated = vi.fn();
  render(
    <TableQuickAddBar
      label='Add item'
      field
      create={create}
      onError={onError}
      onCreated={onCreated}
    />,
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'First' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(input, { target: { value: 'Second' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  reject(error);
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(create.mock.calls).toEqual([['First'], ['Second']]);
});

function submit(value: string) {
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

it('keeps the create callback that accepted each queued row', async () => {
  const first = Promise.withResolvers<void>();
  const createBefore = vi.fn(() => first.promise);
  const createAfter = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <TableQuickAddBar label='Add item' field create={createBefore} />,
  );
  submit('First');
  rerender(<TableQuickAddBar label='Add item' field create={createAfter} />);
  submit('Second');
  first.resolve();

  await waitFor(() =>
    expect(createAfter).toHaveBeenCalledExactlyOnceWith('Second'),
  );
  expect(createBefore).toHaveBeenCalledExactlyOnceWith('First');
});

it('drains accepted rows after navigation and reports failures to their original owner', async () => {
  const first = Promise.withResolvers<void>();
  const failure = new Error('Original table rejected the row');
  const before = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(failure);
  const after = vi.fn().mockResolvedValue(undefined);
  const onOldCreated = vi.fn();
  const onOldError = vi.fn();
  const onNewCreated = vi.fn();
  const { rerender } = render(
    <TableQuickAddBar
      key='before'
      label='Add item'
      field
      create={before}
      onCreated={onOldCreated}
      onError={onOldError}
    />,
  );
  submit('First');
  submit('Second');
  rerender(
    <TableQuickAddBar
      key='after'
      label='Add item'
      field
      create={after}
      onCreated={onNewCreated}
    />,
  );
  submit('Third');
  first.resolve();

  await waitFor(() =>
    expect(onOldError).toHaveBeenCalledExactlyOnceWith(failure),
  );
  expect(before.mock.calls).toEqual([['First'], ['Second']]);
  expect(after).toHaveBeenCalledExactlyOnceWith('Third');
  expect(onOldCreated).not.toHaveBeenCalled();
  expect(onNewCreated).toHaveBeenCalledOnce();
});
