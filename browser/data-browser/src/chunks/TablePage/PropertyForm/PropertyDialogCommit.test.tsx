// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { core, Datatype, type Resource } from '@tomic/react';
import { EditPropertyDialog } from './EditPropertyDialog';
import { NewPropertyDialog } from './NewPropertyDialog';

const mocks = vi.hoisted(() => ({
  store: { getResource: vi.fn() },
  prepare: vi.fn(),
  create: vi.fn(),
  apply: vi.fn(),
  constraint: vi.fn(),
  attach: vi.fn(),
}));

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useStore: () => mocks.store,
  getEffectiveConstraint: () => undefined,
}));
vi.mock('@helpers/propertyIdentity', () => ({
  createPropertyDraft: (...args: unknown[]) => mocks.prepare(...args),
  applyDraftFields: (...args: unknown[]) => mocks.apply(...args),
  isContentAddressed: () => false,
  recreatePropertyWithDatatype: vi.fn(),
  copyablePropertyFields: () => ({ isA: [], propVals: {} }),
}));
vi.mock('../Kanban/createSelectProperty', () => ({
  createPropertyOnClass: (...args: unknown[]) => mocks.create(...args),
  createSelectPropertyOnClass: vi.fn(),
  attachPropertiesToClass: (...args: unknown[]) => mocks.attach(...args),
}));
vi.mock('./columnConstraints', () => ({
  CONSTRAINT_FIELDS: [],
  applyDraftConstraint: (...args: unknown[]) => mocks.constraint(...args),
  seedDraftFromConstraint: vi.fn(),
  constraintPatchFromDraft: () => undefined,
}));
vi.mock('./categories', () => ({ getCategoryFromResource: () => 'text' }));
vi.mock(
  '@components/forms/formValidation/FormValidationContextProvider',
  () => ({
    FormValidationContextProvider: ({
      children,
    }: {
      children: React.ReactNode;
    }) => children,
  }),
);
vi.mock('@components/Button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }));
vi.mock('./PropertyForm', async () => {
  const { useState } = await import('react');

  return {
    PropertyForm: ({
      resource,
      onSubmit,
    }: {
      resource: Resource;
      onSubmit: () => void;
    }) => {
      const [name, setName] = useState(
        resource.get('https://atomicdata.dev/properties/name') as string,
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
            aria-label='Column name'
            value={name}
            onChange={event => {
              setName(event.target.value);
              void resource.set(
                'https://atomicdata.dev/properties/name',
                event.target.value,
              );
            }}
          />
        </form>
      );
    },
  };
});
vi.mock('@components/Dialog', async () => {
  const { useEffect, useRef } = await import('react');
  const { useDialog } = await import('@components/Dialog/useDialog');

  return {
    useDialog,
    Dialog: ({
      show,
      onClose,
      onClosed,
      children,
    }: {
      show: boolean;
      onClose: (success: boolean) => void;
      onClosed: () => void;
      children: React.ReactNode;
    }) => {
      const wasOpen = useRef(false);
      useEffect(() => {
        if (wasOpen.current && !show) onClosed();
        wasOpen.current = show;
      }, [show, onClosed]);

      return show ? (
        <div role='dialog'>
          {children}
          <button onClick={() => onClose(false)}>Cancel</button>
        </div>
      ) : null;
    },
    DialogActions: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DialogContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DialogTitle: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

function stubResource(subject: string, name = 'Original') {
  const values = new Map<string, unknown>([
    [core.properties.name, name],
    [core.properties.datatype, Datatype.STRING],
    [core.properties.parent, 'https://example.com/ontology'],
  ]);

  return {
    subject,
    values,
    props: { parent: 'https://example.com/ontology' },
    get: (key: string) => values.get(key),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    save: vi.fn(async () => 'persisted'),
    hasClasses: () => true,
  };
}

type Stub = ReturnType<typeof stubResource>;
const asResource = (value: Stub) => value as unknown as Resource;
let table: Stub;

beforeEach(() => {
  vi.resetAllMocks();
  table = stubResource('https://example.com/table-class');
  mocks.store.getResource.mockImplementation(async (subject: string) =>
    subject === table.subject ? table : stubResource(subject),
  );
  mocks.prepare.mockImplementation(async (_store, _parent, options) =>
    stubResource(
      'draft',
      options.source?.get(core.properties.name) ?? 'column',
    ),
  );
  mocks.apply.mockImplementation(async (target: Stub, draft: Stub) => {
    target.values.set(core.properties.name, draft.get(core.properties.name));
  });
  mocks.create.mockResolvedValue('https://example.com/new-property');
  mocks.constraint.mockResolvedValue(undefined);
  mocks.attach.mockResolvedValue(undefined);
});
afterEach(cleanup);

it('retains an existing property draft on failure and saves constraints in the supplied table class', async () => {
  const original = stubResource('https://example.com/property');
  original.save.mockRejectedValueOnce(Error('Backend unavailable'));
  const bindShow = vi.fn();
  render(
    <EditPropertyDialog
      resource={asResource(original)}
      showDialog
      bindShow={bindShow}
      tableClassSubject={table.subject}
    />,
  );
  const input = await screen.findByRole('textbox', { name: 'Column name' });
  fireEvent.change(input, { target: { value: 'Retained name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toBe('Backend unavailable');
  expect(
    (screen.getByRole('textbox', { name: 'Column name' }) as HTMLInputElement)
      .value,
  ).toBe('Retained name');
  expect(bindShow).not.toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(original.save).toHaveBeenCalledTimes(2);
  expect(mocks.constraint).toHaveBeenCalledWith(
    table,
    original.subject,
    expect.anything(),
  );
  expect(bindShow).toHaveBeenCalledWith(false);
});

it('keeps failed new-column input and prevents duplicate or cancelled in-flight creation', async () => {
  mocks.create.mockRejectedValueOnce(Error('Class save failed'));
  const bindShow = vi.fn(),
    onCreated = vi.fn();
  render(
    <NewPropertyDialog
      tableClassResource={asResource(table)}
      selectedCategory='text'
      showDialog
      bindShow={bindShow}
      onCreated={onCreated}
    />,
  );
  const input = await screen.findByRole('textbox', { name: 'Column name' });
  fireEvent.change(input, { target: { value: 'New retained name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await screen.findByRole('alert');
  expect(
    (screen.getByRole('textbox', { name: 'Column name' }) as HTMLInputElement)
      .value,
  ).toBe('New retained name');
  expect(onCreated).not.toHaveBeenCalled();
  let complete!: (subject: string) => void;
  mocks.create.mockImplementationOnce(
    () =>
      new Promise<string>(resolve => {
        complete = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(
    (
      screen.getByRole('button', {
        name: 'Create',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.submit(screen.getByRole('form', { name: 'Property draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(bindShow).not.toHaveBeenCalledWith(false);
  await act(async () => {
    complete('https://example.com/created');
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(
    'https://example.com/created',
  );
});

it('ignores a late new-property draft after switching table class', async () => {
  let complete!: (draft: Stub) => void;
  mocks.prepare.mockImplementationOnce(
    () =>
      new Promise<Stub>(resolve => {
        complete = resolve;
      }),
  );
  mocks.prepare.mockImplementationOnce(async () =>
    stubResource('new-draft', 'New class draft'),
  );
  const bindShow = vi.fn();
  const view = render(
    <NewPropertyDialog
      tableClassResource={asResource(table)}
      selectedCategory='text'
      showDialog
      bindShow={bindShow}
    />,
  );
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  const other = stubResource('https://example.com/other-class');
  view.rerender(
    <NewPropertyDialog
      tableClassResource={asResource(other)}
      selectedCategory='text'
      showDialog
      bindShow={bindShow}
    />,
  );
  await screen.findByRole('textbox', { name: 'Column name' });
  await act(async () => {
    complete(stubResource('old-draft', 'Old class draft'));
  });
  expect(
    (screen.getByRole('textbox', { name: 'Column name' }) as HTMLInputElement)
      .value,
  ).toBe('New class draft');
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  expect(mocks.create.mock.calls[0][1]).toBe(other);
});

it('retries only attachment after the property definition was already saved', async () => {
  mocks.attach.mockRejectedValueOnce(Error('Class attach failed'));
  const bindShow = vi.fn(),
    onCreated = vi.fn();
  render(
    <NewPropertyDialog
      tableClassResource={asResource(table)}
      selectedCategory='text'
      showDialog
      bindShow={bindShow}
      onCreated={onCreated}
    />,
  );
  const input = await screen.findByRole('textbox', { name: 'Column name' });
  fireEvent.change(input, { target: { value: 'Prepared column' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await screen.findByText(
    'Column definition saved. Retry to finish adding it to the table.',
  );
  expect(input.closest('[inert]')).not.toBeNull();
  expect(onCreated).not.toHaveBeenCalled();
  expect(mocks.create.mock.calls[0][2].deferAttach).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.attach).toHaveBeenCalledTimes(2);
  expect(mocks.attach).toHaveBeenNthCalledWith(1, mocks.store, table, [
    'https://example.com/new-property',
  ]);
  expect(mocks.attach).toHaveBeenNthCalledWith(2, mocks.store, table, [
    'https://example.com/new-property',
  ]);
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(
    'https://example.com/new-property',
  );
});

it('ignores a late edit draft after navigating to another property', async () => {
  let complete!: (draft: Stub) => void;
  mocks.prepare.mockImplementationOnce(
    () =>
      new Promise<Stub>(resolve => {
        complete = resolve;
      }),
  );
  mocks.prepare.mockImplementationOnce(async () =>
    stubResource('new-draft', 'Other property draft'),
  );
  const original = stubResource('https://example.com/first'),
    other = stubResource('https://example.com/second'),
    bindShow = vi.fn();
  const view = render(
    <EditPropertyDialog
      resource={asResource(original)}
      showDialog
      bindShow={bindShow}
      tableClassSubject={table.subject}
    />,
  );
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  view.rerender(
    <EditPropertyDialog
      resource={asResource(other)}
      showDialog
      bindShow={bindShow}
      tableClassSubject={table.subject}
    />,
  );
  await screen.findByRole('textbox', { name: 'Column name' });
  await act(async () => {
    complete(stubResource('old-draft', 'Old property draft'));
  });
  expect(
    (screen.getByRole('textbox', { name: 'Column name' }) as HTMLInputElement)
      .value,
  ).toBe('Other property draft');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(other.save).toHaveBeenCalledOnce());
  expect(original.save).not.toHaveBeenCalled();
});

it('does not close the current property editor when an earlier scope finishes saving', async () => {
  let complete!: (result: string) => void;
  const original = stubResource('https://example.com/first', 'First'),
    other = stubResource('https://example.com/second', 'Second');
  original.save.mockImplementationOnce(
    () =>
      new Promise<string>(resolve => {
        complete = resolve;
      }),
  );
  const bindShow = vi.fn();
  const view = render(
    <EditPropertyDialog
      resource={asResource(original)}
      showDialog
      bindShow={bindShow}
      tableClassSubject={table.subject}
    />,
  );
  await screen.findByRole('textbox', { name: 'Column name' });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(original.save).toHaveBeenCalledOnce());
  view.rerender(
    <EditPropertyDialog
      resource={asResource(other)}
      showDialog
      bindShow={bindShow}
      tableClassSubject={table.subject}
    />,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: 'Column name' }) as HTMLInputElement)
        .value,
    ).toBe('Second'),
  );
  await act(async () => {
    complete('persisted');
  });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(bindShow).not.toHaveBeenCalledWith(false);
  expect(other.save).not.toHaveBeenCalled();
});
