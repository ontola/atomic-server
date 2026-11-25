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
import { DialogGlobalContextProvider } from '@tomic/ui/components/Dialog/DialogGlobalContextProvider';
import { useState } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildTheme, ThemeProvider } from '../../test/providers.js';
import { QuickAddDialog } from './QuickAddDialog.js';
import { RowActionDialog } from './RowActionDialog.js';
import { DerivedColumnDialog } from './DerivedColumnDialog.js';
import { useRealFormulaEngine } from './formulaEngine.testing.js';
import { Datatype } from '@tomic/react';

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useResource: () => ({ title: 'Done' }),
  useString: () => [undefined],
  useTitle: () => ['Done'],
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

it('waits for the view save, keeps a failed draft, and closes after retry', async () => {
  const first = Promise.withResolvers<void>();
  const save = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(undefined);

  function Fixture() {
    const [open, setOpen] = useState(false);

    return (
      <>
        <button onClick={() => setOpen(true)}>Configure</button>
        <QuickAddDialog
          open={open}
          bindShow={setOpen}
          editing={{ label: 'Original' }}
          classProperties={[]}
          onSave={save}
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
  fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
  const label = screen.getByTestId<HTMLInputElement>('quick-add-config-label');
  fireEvent.change(label, { target: { value: 'Updated' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
  await act(async () => first.reject(Error('View rejected save')));
  expect(screen.getByRole('alert').textContent).toBe('View rejected save');
  expect(label.value).toBe('Updated');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(save.mock.calls).toEqual([
    [{ label: 'Updated', presets: [] }],
    [{ label: 'Updated', presets: [] }],
  ]);
});

it.each(['action', 'formula'] as const)(
  'keeps the %s editor open until its write finishes',
  async kind => {
    if (kind === 'formula') await useRealFormulaEngine();
    const write = Promise.withResolvers<void>();
    const onSave = vi.fn(() => write.promise);

    function Fixture() {
      const [open, bindShow] = useState(true);

      return kind === 'action' ? (
        <RowActionDialog
          open={open}
          bindShow={bindShow}
          onSave={onSave}
          classProperties={[
            {
              subject: 'done',
              datatype: Datatype.BOOLEAN,
              shortname: 'done',
              description: '',
            },
          ]}
          editing={{
            id: 'mark',
            label: 'Mark done',
            kind: 'toggle',
            property: 'done',
          }}
        />
      ) : (
        <DerivedColumnDialog
          open={open}
          bindShow={bindShow}
          onSave={onSave}
          classProperties={[]}
          editing={{
            id: 'total',
            label: 'Total',
            kind: 'formula',
            formula: '1 + 2',
            vars: {},
          }}
        />
      );
    }

    render(
      <ThemeProvider theme={buildTheme()}>
        <DialogGlobalContextProvider>
          <Fixture />
        </DialogGlobalContextProvider>
      </ThemeProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');

    await act(async () => write.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  },
);

it('does not treat a blank increment field as zero', async () => {
  const save = vi.fn();

  render(
    <ThemeProvider theme={buildTheme()}>
      <DialogGlobalContextProvider>
        <RowActionDialog
          open
          bindShow={() => undefined}
          onSave={save}
          classProperties={[
            {
              subject: 'count',
              datatype: Datatype.INTEGER,
              shortname: 'count',
              description: '',
            },
          ]}
          editing={{
            id: 'increment',
            kind: 'increment',
            label: 'Increment',
            property: 'count',
            value: 1,
          }}
        />
      </DialogGlobalContextProvider>
    </ThemeProvider>,
  );
  const submit = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Save',
  });
  fireEvent.change(screen.getByTestId('action-config-value'), {
    target: { value: '' },
  });

  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByTestId('action-config-value'), {
    target: { value: '0' },
  });
  expect(submit.disabled).toBe(false);
});
