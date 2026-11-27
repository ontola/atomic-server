// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { useContext, useRef, useState } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  core,
  Datatype,
  LoroLoader,
  Resource,
  Store,
  StoreContext,
  useArray,
} from '@tomic/react';
import { DialogGlobalContextProvider } from '@tomic/ui/components/Dialog/DialogGlobalContextProvider';
import { DropdownPortalContext } from '@tomic/ui/components/Dropdown/dropdownContext';
import { buildTheme, ThemeProvider } from '../../test/providers.js';
import { TableHeadingMenu } from './TableHeadingMenu.js';
import { ColumnRemovalDialog } from './ColumnRemovalDialog.js';
import { TablePageContext } from './tablePageContext.js';

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCanWrite: () => true,
}));
vi.mock('@tomic/resource-ui/ResourceUIHost', async importOriginal => ({
  ...(await importOriginal<
    typeof import('@tomic/resource-ui/ResourceUIHost')
  >()),
  useResourceNavigation: () => ({
    constructOpenURL: (subject: string) => subject,
  }),
  useNavigateWithTransition: () => () => undefined,
}));
vi.mock('@tomic/resource-ui/views/ResourceInline/index', () => ({
  ResourceInline: ({ subject }: { subject: string }) => <span>{subject}</span>,
}));
vi.mock('@tomic/resource-ui/components/ResourceUsage/index', () => ({
  ResourceUsage: () => null,
}));
vi.mock('./PropertyForm/EditPropertyDialog.js', () => ({
  EditPropertyDialog: () => null,
}));

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => undefined;

  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };

  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };

  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

afterEach(cleanup);

async function openRemoval(external = false) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const field of [core.properties.recommends, core.properties.requires]) {
    const metadata = new Resource(field);
    store.addResource(metadata);
    await metadata.set(core.properties.datatype, Datatype.RESOURCEARRAY, false);
    await metadata.set(core.properties.shortname, 'columns', false);
    await metadata.set(
      core.properties.description,
      'Columns in this schema',
      false,
    );
  }

  const tableClass = await store.newResource({
    subject: 'https://example.com/row-class',
    noParent: true,
  });
  const property = await store.newResource({
    subject: 'https://example.com/column',
    noParent: true,
  });
  await property.set(
    core.properties.parent,
    external ? 'https://example.com/other' : tableClass.subject,
    false,
  );
  await tableClass.set(core.properties.requires, [property.subject], false);
  const save = vi.spyOn(tableClass, 'save').mockResolvedValue('persisted');
  const destroy = vi.spyOn(property, 'destroy').mockResolvedValue(undefined);

  function Page() {
    const context = useContext(TablePageContext);
    const portal = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [required] = useArray(tableClass, core.properties.requires);

    return (
      <DropdownPortalContext value={portal}>
        <TablePageContext
          value={{
            ...context,
            tableClassSubject: tableClass.subject,
            requestColumnRemoval: () => setOpen(true),
          }}
        >
          {required.includes(property.subject) && (
            <TableHeadingMenu resource={property} />
          )}
          {open && (
            <ColumnRemovalDialog
              tableClass={tableClass}
              property={property}
              onClose={() => setOpen(false)}
            />
          )}
        </TablePageContext>
        <div ref={portal} />
      </DropdownPortalContext>
    );
  }

  render(
    <StoreContext value={store}>
      <ThemeProvider theme={buildTheme()}>
        <DialogGlobalContextProvider>
          <Page />
        </DialogGlobalContextProvider>
      </ThemeProvider>
    </StoreContext>,
  );
  fireEvent.click(screen.getByTitle('Edit column'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));

  return {
    dialog: await screen.findByRole('dialog'),
    tableClass,
    property,
    save,
    destroy,
  };
}

it('removes the column without destroying its owned definition when the checkbox is unchecked', async () => {
  const { dialog, tableClass, property, save, destroy } = await openRemoval();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(save).toHaveBeenCalledOnce();
  expect(tableClass.getArray(core.properties.requires)).not.toContain(
    property.subject,
  );
  expect(destroy).not.toHaveBeenCalled();
});

it('keeps the pending confirmation after the heading disappears and retains the checked intent after a save error', async () => {
  const { dialog, save, destroy } = await openRemoval();
  const firstSave = Promise.withResolvers<'persisted'>();
  save.mockReturnValueOnce(firstSave.promise);
  const checkbox = within(dialog).getByRole<HTMLInputElement>('checkbox');
  fireEvent.click(checkbox);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(screen.queryByTitle('Edit column')).toBeNull();
  expect(dialog.getAttribute('aria-busy')).toBe('true');
  expect(
    within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' })
      .disabled,
  ).toBe(true);
  expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(
    false,
  );
  expect(destroy).not.toHaveBeenCalled();

  await act(async () => firstSave.reject(new Error('Schema save failed')));
  expect(within(dialog).getByRole('alert').textContent).toBe(
    'Schema save failed',
  );
  expect(checkbox.checked).toBe(true);
  expect(destroy).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(save).toHaveBeenCalledTimes(2);
  expect(destroy).toHaveBeenCalledOnce();
});

it('retries a failed property deletion without repeating the successful schema save', async () => {
  const { dialog, save, destroy } = await openRemoval();
  destroy.mockRejectedValueOnce(new Error('Property deletion failed'));
  const checkbox = within(dialog).getByRole<HTMLInputElement>('checkbox');
  fireEvent.click(checkbox);
  const submit = within(dialog).getByRole('button', { name: 'Delete' });
  fireEvent.click(submit);

  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    'Property deletion failed',
  );
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(true);
  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(save).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledTimes(2);
});

it('only allows detaching an external definition', async () => {
  const { dialog, save, destroy } = await openRemoval(true);
  expect(within(dialog).getByRole<HTMLInputElement>('checkbox').disabled).toBe(
    true,
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(save).toHaveBeenCalledOnce();
  expect(destroy).not.toHaveBeenCalled();
});

it('waits for an offline schema change to sync before allowing the definition to be destroyed', async () => {
  const { dialog, save, destroy } = await openRemoval();
  save.mockResolvedValueOnce('offline');
  fireEvent.click(within(dialog).getByRole('checkbox'));
  const submit = within(dialog).getByRole('button', { name: 'Delete' });
  fireEvent.click(submit);

  expect((await within(dialog).findByRole('alert')).textContent).toContain(
    'sync',
  );
  expect(destroy).not.toHaveBeenCalled();

  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(save).toHaveBeenCalledTimes(2);
  expect(destroy).toHaveBeenCalledOnce();
});
