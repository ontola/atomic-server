// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  Store,
  StoreContext,
  LoroLoader,
  core,
  dataBrowser,
  Datatype,
} from '@tomic/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../../../styling';
import { FormValidationContextProvider } from '@components/forms/formValidation/FormValidationContextProvider';
import { TableRangeInput } from './TableRangeInput';
import { PropertyForm } from '../PropertyForm';

vi.mock('../categories', () => {
  const Category = ({
    resource,
  }: {
    resource: import('@tomic/react').Resource;
  }) => (
    <TableRangeInput
      resource={resource}
      minProp={dataBrowser.properties.min}
      maxProp={dataBrowser.properties.max}
    />
  );

  return { categoryFormFactory: () => Category };
});

afterEach(cleanup);
beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

async function setup(datatype: Datatype, form = false) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const [subject, fieldDatatype] of [
    [dataBrowser.properties.min, Datatype.FLOAT],
    [dataBrowser.properties.max, Datatype.FLOAT],
    [core.properties.name, Datatype.STRING],
    [core.properties.shortname, Datatype.SLUG],
  ]) {
    const property = await store.newResource({ subject, noParent: true });
    await property.set(core.properties.datatype, fieldDatatype, false);
    await property.set(core.properties.shortname, 'bound', false);
    await property.set(core.properties.description, 'Test bound', false);
    await store.getProperty(subject);
  }

  const draft = await store.newResource({
    subject: '_new:range-draft',
    noParent: true,
  });
  await draft.set(core.properties.datatype, datatype, false);
  await draft.set(dataBrowser.properties.max, 20, false);
  await draft.set(core.properties.name, 'Test column', false);
  await draft.set(core.properties.shortname, 'test-column', false);
  const validity = vi.fn();
  const submit = vi.fn();
  render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <FormValidationContextProvider onValidationChange={validity}>
          {form ? (
            <PropertyForm
              resource={draft}
              onSubmit={submit}
              category={undefined}
            />
          ) : (
            <TableRangeInput
              resource={draft}
              minProp={dataBrowser.properties.min}
              maxProp={dataBrowser.properties.max}
            />
          )}
        </FormValidationContextProvider>
      </ThemeProvider>
    </StoreContext.Provider>,
  );

  return { draft, validity, submit };
}

it('preserves fractional float constraints on the unsaved Atomic draft', async () => {
  const { draft } = await setup(Datatype.FLOAT);
  const save = vi.spyOn(draft, 'save').mockResolvedValue('persisted');
  fireEvent.change(screen.getByRole('textbox', { name: 'Minimum' }), {
    target: { value: '1.5' },
  });
  await waitFor(() => expect(draft.get(dataBrowser.properties.min)).toBe(1.5));
  expect(save).not.toHaveBeenCalled();
});
it('blocks fractional integer constraints and keeps the raw input for correction', async () => {
  const { draft, validity } = await setup(Datatype.INTEGER);
  const input = screen.getByRole('textbox', { name: 'Minimum' });
  fireEvent.change(input, { target: { value: '1.5' } });
  expect((input as HTMLInputElement).value).toBe('1.5');
  await waitFor(() => expect(validity).toHaveBeenLastCalledWith(false));
  expect(draft.get(dataBrowser.properties.min)).toBeUndefined();
});
it('accepts a max-only integer constraint and equal inclusive bounds', async () => {
  const { draft, validity } = await setup(Datatype.INTEGER);
  await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true));
  fireEvent.change(screen.getByRole('textbox', { name: 'Minimum' }), {
    target: { value: '0' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Maximum' }), {
    target: { value: '0' },
  });
  await waitFor(() => expect(draft.get(dataBrowser.properties.max)).toBe(0));
  expect(draft.get(dataBrowser.properties.min)).toBe(0);
  expect(validity).toHaveBeenLastCalledWith(true);
});

it('does not confirm a property dialog via Enter/form submission while constraints are invalid', async () => {
  const { validity, submit } = await setup(Datatype.INTEGER, true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Minimum' }), {
    target: { value: '-' },
  });
  await waitFor(() => expect(validity).toHaveBeenLastCalledWith(false));
  const form = screen
    .getByRole('textbox', { name: 'Column name' })
    .closest('form')!;
  fireEvent.submit(form);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Minimum' }), {
    target: { value: '1' },
  });
  await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true));
  fireEvent.submit(form);
  expect(submit).toHaveBeenCalledOnce();
});
