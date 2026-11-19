// @vitest-environment jsdom
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { TableColumnRemovalDialog } from './ColumnRemovalDialog.js';
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };

  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

it('retains failure and explicit deletion intent until a successful retry', async () => {
  const close = vi.fn();
  const confirm = vi
    .fn()
    .mockRejectedValueOnce(Error('schema failed'))
    .mockResolvedValueOnce(undefined);
  render(
    <TableColumnRemovalDialog
      scope='owner/property'
      canRemove
      canDeleteDefinition
      onConfirm={confirm}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await screen.findByText('schema failed');
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(confirm.mock.calls).toEqual([[true], [true]]);
});

it('blocks duplicate submit, Escape, cancel and checkbox edits while pending', async () => {
  let finish!: () => void;
  const confirm = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  render(
    <TableColumnRemovalDialog
      scope='owner/property'
      canRemove
      canDeleteDefinition
      onConfirm={confirm}
      onClose={close}
    />,
  );
  const button = screen.getByRole('button', { name: 'Remove' });
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent(
    screen.getByRole('dialog'),
    new Event('cancel', { cancelable: true }),
  );
  expect(confirm.mock.calls).toEqual([[false]]);
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(
    true,
  );
  await act(async () => finish());
  expect(close).toHaveBeenCalledOnce();
});

it('suppresses stale completion after changing captured owner and resets deletion intent', async () => {
  let finish!: () => void;
  const confirm = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  const props = {
    canRemove: true,
    canDeleteDefinition: true,
    onConfirm: confirm,
    onClose: close,
  };
  const { rerender } = render(
    <TableColumnRemovalDialog scope='first' {...props} />,
  );
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  rerender(<TableColumnRemovalDialog scope='second' {...props} />);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(
    false,
  );
  await act(async () => finish());
  expect(close).not.toHaveBeenCalled();
});

it('blocks lost permissions without silently changing the submitted deletion choice', () => {
  const confirm = vi.fn();
  const close = vi.fn();
  const { rerender } = render(
    <TableColumnRemovalDialog
      scope='same'
      canRemove
      canDeleteDefinition
      onConfirm={confirm}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole('checkbox'));
  rerender(
    <TableColumnRemovalDialog
      scope='same'
      canRemove
      canDeleteDefinition={false}
      onConfirm={confirm}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  expect(
    (
      screen.getByRole('button', {
        name: 'Remove',
        exact: true,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
