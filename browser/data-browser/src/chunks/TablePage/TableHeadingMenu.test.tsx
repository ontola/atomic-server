// @vitest-environment jsdom
// @wc-ignore-file
import { useContext, useState } from 'react';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import {
  Store,
  StoreContext,
  LoroLoader,
  core,
  Resource,
  Datatype,
} from '@tomic/react';
import { buildTheme } from '../../styling';
import { TablePageContext } from './tablePageContext';
import { TableHeadingMenu } from './TableHeadingMenu';
import { AtomicColumnRemovalDialog } from './AtomicColumnRemovalDialog';
vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCanWrite: () => true,
}));
vi.mock('../../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => vi.fn(),
}));
vi.mock('./PropertyForm/EditPropertyDialog', () => ({
  EditPropertyDialog: () => null,
}));
vi.mock('@components/ResourceUsage', () => ({ ResourceUsage: () => null }));
vi.mock('@views/ResourceInline', () => ({
  ResourceInline: ({ subject }: { subject: string }) => <span>{subject}</span>,
}));
vi.mock('@components/Dropdown', () => ({
  DropdownMenu: ({
    items,
  }: {
    items: {
      id: string;
      label: string;
      disabled?: boolean;
      onClick: () => void;
    }[];
  }) => (
    <>
      {items.map(item => (
        <button key={item.id} disabled={item.disabled} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </>
  ),
}));
beforeAll(async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };

  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };

  const web = await import('loro-crdt/web');
  await web.default({
    module_or_path: await readFile(
      createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
    ),
  });
  await LoroLoader.initializeLoro();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function fixture(
  external = false,
  failure = false,
  currentOwner?: string,
) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const [subject, datatype] of [
    [core.properties.requires, Datatype.RESOURCEARRAY],
    [core.properties.recommends, Datatype.RESOURCEARRAY],
    [core.properties.parent, Datatype.ATOMIC_URL],
  ] as const) {
    const property = new Resource(subject);
    store.addResource(property);
    await property.set(core.properties.datatype, datatype, false);
    await property.set(core.properties.shortname, 'metadata', false);
    await property.set(core.properties.description, 'Fixture metadata', false);
  }

  const cls = await store.newResource({
    subject: 'https://example.com/row',
    noParent: true,
  });
  const resource = await store.newResource({
    subject: 'https://example.com/count',
    noParent: true,
  });
  await resource.set(
    core.properties.parent,
    external ? 'https://example.com/other-class' : cls.subject,
    false,
  );
  await cls.set(core.properties.requires, [resource.subject], false);
  const save = vi.spyOn(cls, 'save');
  if (failure) save.mockRejectedValue(Error('schema save failed'));
  else save.mockResolvedValue('persisted');
  const destroy = vi.spyOn(resource, 'destroy').mockResolvedValue(undefined);

  function Page() {
    const defaults = useContext(TablePageContext);
    const [show, setShow] = useState(false);

    return (
      <TablePageContext.Provider
        value={{
          ...defaults,
          tableClassSubject: cls.subject,
          requestColumnRemoval: () => setShow(true),
        }}
      >
        {!show && <TableHeadingMenu resource={resource} />}
        {show && (
          <AtomicColumnRemovalDialog
            owner={cls.subject}
            property={resource.subject}
            currentOwner={currentOwner ?? cls.subject}
            onClose={() => setShow(false)}
          />
        )}
      </TablePageContext.Provider>
    );
  }

  render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <Page />
      </ThemeProvider>
    </StoreContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await screen.findByRole('dialog');

  return { save, destroy, cls, resource };
}

it('honors unchecked deletion even for a property owned by this class', async () => {
  const state = await fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  expect(state.cls.getArray(core.properties.requires)).not.toContain(
    state.resource.subject,
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(state.destroy).not.toHaveBeenCalled();
});
it('deletes an owned definition only after explicit selection and successful schema save', async () => {
  const state = await fixture();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Delete property and its children' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(state.destroy).toHaveBeenCalledOnce());
  expect(state.save.mock.invocationCallOrder[0]).toBeLessThan(
    state.destroy.mock.invocationCallOrder[0],
  );
});
it('keeps external definitions unavailable for deletion and does not destroy after failed detachment', async () => {
  const state = await fixture(true, true);
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Delete property and its children',
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await screen.findByText('schema save failed');
  expect(screen.getByRole('dialog')).toBeDefined();
  expect(state.destroy).not.toHaveBeenCalled();
});

it('keeps the page-owned dialog pending after its heading unmounts and closes only after confirmation', async () => {
  const state = await fixture();
  let finish!: (value: 'persisted') => void;
  state.save.mockImplementation(
    () =>
      new Promise<'persisted'>(resolve => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
  expect(
    (screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(state.destroy).not.toHaveBeenCalled();
  finish('persisted');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(state.destroy).not.toHaveBeenCalled();
});

it('does not retarget a captured removal intent to another row class', async () => {
  const state = await fixture(
    false,
    false,
    'https://example.com/another-class',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(state.save).not.toHaveBeenCalled();
  expect(state.destroy).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('unavailable');
  expect(state.cls.getArray(core.properties.requires)).toContain(
    state.resource.subject,
  );
});
