// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  Store,
  StoreContext,
  LoroLoader,
  core,
  dataBrowser,
  Datatype,
  urls,
} from '@tomic/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../../styling';
import { NumberPropertyForm } from './NumberPropertyForm';

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

async function setup(existingProperty: boolean, format?: string) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const [subject, datatype] of [
    [core.properties.isA, Datatype.RESOURCEARRAY],
    [core.properties.datatype, Datatype.ATOMIC_URL],
    [dataBrowser.properties.numberFormatting, Datatype.ATOMIC_URL],
  ]) {
    const property = await store.newResource({ subject, noParent: true });
    await property.set(core.properties.datatype, datatype, false);
    await property.set(core.properties.shortname, 'test-property', false);
    await property.set(core.properties.description, 'Test metadata', false);
    await store.getProperty(subject);
  }

  const draft = await store.newResource({
    subject: '_new:number-draft',
    noParent: true,
  });
  await draft.set(core.properties.datatype, Datatype.INTEGER, false);
  if (format)
    await draft.set(dataBrowser.properties.numberFormatting, format, false);
  const save = vi.spyOn(draft, 'save').mockResolvedValue('persisted');
  render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <NumberPropertyForm
          resource={draft}
          existingProperty={existingProperty}
        />
      </ThemeProvider>
    </StoreContext.Provider>,
  );

  return { draft, save };
}

it('does not retype an existing integer property when display precision is absent', async () => {
  const { draft, save } = await setup(true);
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
  const { draft, save } = await setup(false);
  await waitFor(() =>
    expect(draft.get(core.properties.datatype)).toBe(Datatype.FLOAT),
  );
  expect(save).not.toHaveBeenCalled();
});
it('preserves an unknown saved format instead of replacing it', async () => {
  const { draft } = await setup(true, 'https://example.com/custom-format');
  const option = screen.getByRole('radio', {
    name: 'https://example.com/custom-format',
  }) as HTMLInputElement;
  expect(option.checked).toBe(true);
  expect(option.disabled).toBe(true);
  expect(draft.get(dataBrowser.properties.numberFormatting)).toBe(
    'https://example.com/custom-format',
  );
});
