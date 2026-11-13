// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from 'react';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import {
  TablePropertyDialog,
  type TablePropertyEditorProps,
} from './PropertyDialog.js';
type Draft = { name: Map<string, string> };
const makeDraft = (name = 'Original'): Draft => ({
  name: new Map([['value', name]]),
});

function Editor({
  draft,
  disabled,
  onSubmit,
  onValidationChange,
}: TablePropertyEditorProps<Draft>) {
  const [name, setName] = useState(() => draft.name.get('value')!);
  useEffect(
    () => onValidationChange(!!name && !disabled),
    [name, disabled, onValidationChange],
  );

  return (
    <form
      aria-label='Property draft'
      onSubmit={event => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input
        aria-label='Name'
        value={name}
        disabled={disabled}
        onChange={event => {
          setName(event.target.value);
          draft.name.set('value', event.target.value);
        }}
      />
    </form>
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };

  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

async function readyToSave() {
  await screen.findByRole('textbox');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
}

it('prepares once under StrictMode and permits cancellation before a late draft arrives', async () => {
  let complete!: (value: Draft) => void;
  const prepare = vi.fn(
      () =>
        new Promise<Draft>(resolve => {
          complete = resolve;
        }),
    ),
    close = vi.fn();
  render(
    <StrictMode>
      <TablePropertyDialog
        open
        scope='first'
        title='Edit column'
        prepare={prepare}
        save={vi.fn()}
        Editor={Editor}
        onClose={close}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => complete(makeDraft()));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole('textbox')).toBeNull();
});
it('retains edited metadata after failure and closes only after a successful explicit retry', async () => {
  const prepared = makeDraft(),
    close = vi.fn(),
    save = vi
      .fn()
      .mockRejectedValueOnce(Error('Save failed'))
      .mockResolvedValueOnce(undefined);
  render(
    <TablePropertyDialog
      open
      scope='same'
      title='Edit column'
      prepare={() => prepared}
      save={save}
      Editor={Editor}
      onClose={close}
    />,
  );
  fireEvent.change(await screen.findByRole('textbox'), {
    target: { value: 'Retained' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Save failed');
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(
    'Retained',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save.mock.calls).toEqual([[prepared], [prepared]]);
  expect(prepared.name.get('value')).toBe('Retained');
});
it('guards duplicate submission and cancellation synchronously while a save is pending', async () => {
  let complete!: () => void;
  const save = vi.fn(
      () =>
        new Promise<void>(resolve => {
          complete = resolve;
        }),
    ),
    close = vi.fn();
  render(
    <TablePropertyDialog
      open
      scope='same'
      title='Edit column'
      prepare={() => makeDraft()}
      save={save}
      Editor={Editor}
      onClose={close}
    />,
  );
  await readyToSave();
  fireEvent.submit(screen.getByRole('form'));
  fireEvent.submit(screen.getByRole('form'));
  fireEvent(
    screen.getByRole('dialog'),
    new Event('cancel', { cancelable: true }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(save).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  await act(async () => complete());
  expect(close).toHaveBeenCalledOnce();
});
it('retains preparation errors with an explicit retry and no persistence until Save', async () => {
  const prepare = vi
      .fn()
      .mockRejectedValueOnce(Error('Metadata unavailable'))
      .mockResolvedValueOnce(makeDraft()),
    save = vi.fn();
  render(
    <TablePropertyDialog
      open
      scope='same'
      title='Edit column'
      prepare={prepare}
      save={save}
      Editor={Editor}
      onClose={vi.fn()}
    />,
  );
  await screen.findByText('Metadata unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('textbox');
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(save).not.toHaveBeenCalled();
});
it('suppresses stale save completion and cannot save into a changed owner', async () => {
  let complete!: () => void;
  const save = vi.fn(
      () =>
        new Promise<void>(resolve => {
          complete = resolve;
        }),
    ),
    close = vi.fn();
  const base = {
    open: true,
    title: 'Edit column',
    Editor,
    onClose: close,
    save,
  };
  const { rerender } = render(
    <TablePropertyDialog
      {...base}
      scope='first'
      prepare={() => makeDraft('First')}
    />,
  );
  await readyToSave();
  fireEvent.submit(screen.getByRole('form'));
  rerender(
    <TablePropertyDialog
      {...base}
      scope='second'
      canSave={false}
      prepare={() => makeDraft('Second')}
    />,
  );
  await waitFor(() =>
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(
      'Second',
    ),
  );
  await act(async () => complete());
  expect(close).not.toHaveBeenCalled();
  fireEvent.submit(screen.getByRole('form'));
  expect(save).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert').textContent).toContain('unavailable');
});
it('locks a backend-checkpointed draft after partial save while leaving explicit retry available', async () => {
  let materialized = false;
  const save = vi
    .fn()
    .mockImplementationOnce(async () => {
      materialized = true;
      throw Error('Attachment failed');
    })
    .mockResolvedValueOnce(undefined);
  const prepare = vi.fn(() => makeDraft()),
    close = vi.fn();
  render(
    <TablePropertyDialog
      open
      scope='same'
      title='Edit column'
      prepare={prepare}
      save={save}
      isDraftLocked={() => materialized}
      Editor={Editor}
      onClose={close}
    />,
  );
  await readyToSave();
  fireEvent.submit(screen.getByRole('form'));
  await screen.findByText('Attachment failed');
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('locked');
  expect(
    (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(prepare).toHaveBeenCalledOnce();
});

it('finishes StrictMode preparation once and can save the prepared draft', async () => {
  const prepare = vi.fn(() => makeDraft());
  const save = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <StrictMode>
      <TablePropertyDialog
        open
        scope='strict-ready'
        title='Edit column'
        prepare={prepare}
        save={save}
        Editor={Editor}
        onClose={close}
      />
    </StrictMode>,
  );
  await readyToSave();
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(prepare).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
});

it('notifies creation once after success and labels checkpointed retries explicitly', async () => {
  let created = false;
  const value = makeDraft();
  const saved = vi.fn(),
    close = vi.fn();
  const save = vi
    .fn()
    .mockImplementationOnce(async () => {
      created = true;
      throw Error('Attach failed');
    })
    .mockResolvedValueOnce(undefined);
  render(
    <TablePropertyDialog
      open
      scope='creation'
      title='New column'
      prepare={() => value}
      save={save}
      isDraftLocked={() => created}
      Editor={Editor}
      onClose={close}
      onSaved={saved}
      messages={{ save: 'Create', saveLocked: 'Retry' }}
    />,
  );
  await screen.findByRole('textbox');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await screen.findByText('Attach failed');
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(saved).toHaveBeenCalledExactlyOnceWith(value));
  expect(close).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledTimes(2);
});
