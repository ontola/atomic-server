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
  urls,
} from '@tomic/react';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { defaultUITheme } from '@tomic/ui';
import { NumberPropertyForm } from './NumberPropertyForm';
import { TextPropertyForm } from './TextPropertyForm';

vi.mock('./Inputs/TableRangeInput', () => ({ TableRangeInput: () => null }));
vi.mock('./Inputs/DecimalPlacesInput', () => ({
  DecimalPlacesInput: () => null,
}));
afterEach(cleanup);
beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

async function setup({
  kind = 'number',
  format,
  existingProperty = false,
  datatype,
}: {
  kind?: 'number' | 'text';
  format?: string;
  existingProperty?: boolean;
  datatype?: Datatype;
} = {}) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const [subject, propertyDatatype] of [
    [core.properties.isA, Datatype.RESOURCEARRAY],
    [core.properties.datatype, Datatype.ATOMIC_URL],
    [dataBrowser.properties.numberFormatting, Datatype.ATOMIC_URL],
  ]) {
    const property = await store.newResource({ subject, noParent: true });
    await property.set(core.properties.datatype, propertyDatatype, false);
    await property.set(core.properties.shortname, 'test-property', false);
    await property.set(core.properties.description, 'Test metadata', false);
    await store.getProperty(subject);
  }

  const draft = await store.newResource({
    subject: '_new:number-draft',
    noParent: true,
  });
  if (datatype) await draft.set(core.properties.datatype, datatype, false);
  if (format)
    await draft.set(dataBrowser.properties.numberFormatting, format, false);
  const save = vi.spyOn(draft, 'save').mockResolvedValue('persisted');
  render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={defaultUITheme as unknown as DefaultTheme}>
        {kind === 'number' ? (
          <NumberPropertyForm
            resource={draft}
            existingProperty={existingProperty}
          />
        ) : (
          <TextPropertyForm
            resource={draft}
            existingProperty={existingProperty}
          />
        )}
      </ThemeProvider>
    </StoreContext.Provider>,
  );

  return { draft, save };
}

it('does not retype an existing integer property when display precision is absent', async () => {
  // EditPropertyDialog passes this flag through PropertyForm even though the
  // editable resource is a separate draft with a signed genesis.
  const { draft, save } = await setup({
    existingProperty: true,
    datatype: Datatype.INTEGER,
  });
  await waitFor(() =>
    expect(draft.get(dataBrowser.properties.numberFormatting)).toBe(
      urls.instances.numberFormats.number,
    ),
  );
  expect(draft.get(core.properties.datatype)).toBe(Datatype.INTEGER);
  expect(
    (screen.getByRole('radio', { name: 'Number' }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(save).not.toHaveBeenCalled();
});
it('still defaults a new number draft to float without persisting it', async () => {
  const { draft, save } = await setup();
  await waitFor(() =>
    expect(draft.get(core.properties.datatype)).toBe(Datatype.FLOAT),
  );
  expect(save).not.toHaveBeenCalled();
});

// The clean baseline saves text-format changes explicitly. The old legacy
// extraction ancestry had removed this call; restacking must not inherit that.
it('preserves the clean host explicit save when changing text format', async () => {
  const { draft, save } = await setup({ kind: 'text' });
  fireEvent.click(screen.getByRole('radio', { name: 'Rich text' }));
  await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith());
  expect(draft.get(core.properties.datatype)).toBe(Datatype.MARKDOWN);
});
it('preserves an unknown saved format until the user chooses a supported format', async () => {
  const { draft, save } = await setup({
    format: 'https://example.com/custom-format',
    existingProperty: true,
    datatype: Datatype.INTEGER,
  });
  const option = screen.getByRole('radio', {
    name: 'https://example.com/custom-format',
  }) as HTMLInputElement;
  expect(option.checked).toBe(true);
  expect(option.disabled).toBe(true);
  expect(draft.get(dataBrowser.properties.numberFormatting)).toBe(
    'https://example.com/custom-format',
  );
  expect(draft.get(core.properties.datatype)).toBe(Datatype.INTEGER);
  expect(save).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('radio', { name: 'Number' }));
  await waitFor(() =>
    expect(draft.get(dataBrowser.properties.numberFormatting)).toBe(
      urls.instances.numberFormats.number,
    ),
  );
  expect(draft.get(core.properties.datatype)).toBe(Datatype.INTEGER);
  expect(save).not.toHaveBeenCalled();
});
