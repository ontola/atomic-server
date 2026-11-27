// @vitest-environment jsdom
// @wc-ignore-file
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { Resource } from '@tomic/react';
import { DialogGlobalContextProvider } from '@tomic/ui/components/Dialog/DialogGlobalContextProvider';
import { useState } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildTheme, ThemeProvider } from '../../../test/providers.js';
import { ExternalPropertyDialog } from './ExternalPropertyDialog.js';

const { optimisticSetter } = vi.hoisted(() => ({ optimisticSetter: vi.fn() }));
vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCanWrite: () => true,
  useArray: () => [[], optimisticSetter],
}));
vi.mock('@tomic/resource-ui/components/forms/ResourceSelector/index', () => ({
  ResourceSelector: ({
    setSubject,
    value,
  }: {
    setSubject: (subject: string) => void;
    value?: string;
  }) => (
    <button onClick={() => setSubject('https://example.com/column')}>
      {value ?? 'Choose property'}
    </button>
  ),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };

  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

it('keeps the selected property after a class save fails and completes the retry once', async () => {
  const first = Promise.withResolvers<'persisted'>();
  const created = vi.fn();
  let columns: string[] = [];
  const set = vi.fn(async (_: string, subjects: string[]) => {
    columns = subjects;
  });
  const save = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue('persisted');
  const tableClassResource = {
    getSubjects: () => columns,
    get: () => undefined,
    set,
    save,
  } as unknown as Resource;

  function Fixture() {
    const [open, setOpen] = useState(false);

    return (
      <>
        <button onClick={() => setOpen(true)}>Open editor</button>
        <ExternalPropertyDialog
          open={open}
          bindShow={setOpen}
          tableClassResource={tableClassResource}
          onCreated={created}
        />
      </>
    );
  }

  render(
    <ThemeProvider theme={buildTheme()}>
      <DialogGlobalContextProvider>
        <Fixture />
      </DialogGlobalContextProvider>
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open editor' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Choose property' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  expect(created).not.toHaveBeenCalled();
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  await act(async () => first.reject(Error('Could not write schema')));
  expect(screen.getByRole('alert').textContent).toBe('Could not write schema');
  expect(
    screen.getByRole('button', { name: 'https://example.com/column' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(created).toHaveBeenCalledExactlyOnceWith('https://example.com/column');
  expect(set).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledTimes(2);
});
