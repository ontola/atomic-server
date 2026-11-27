// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  act,
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
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { defaultUITheme } from '@tomic/ui';
import { NumberPropertyForm } from './NumberPropertyForm.js';
import { TextPropertyForm } from './TextPropertyForm.js';

afterEach(cleanup);
beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

async function setup(
  kind: 'number' | 'text' = 'number',
  format?: string,
  precision?: number,
) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const [subject, datatype] of [
    [core.properties.isA, Datatype.RESOURCEARRAY],
    [core.properties.datatype, Datatype.ATOMIC_URL],
    [dataBrowser.properties.numberFormatting, Datatype.ATOMIC_URL],
    [dataBrowser.properties.min, Datatype.FLOAT],
    [dataBrowser.properties.max, Datatype.FLOAT],
    [dataBrowser.properties.decimalPlaces, Datatype.INTEGER],
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
  if (precision !== undefined)
    await draft.set(dataBrowser.properties.decimalPlaces, precision, false);
  if (format)
    await draft.set(dataBrowser.properties.numberFormatting, format, false);
  const save = vi.spyOn(draft, 'save').mockResolvedValue('persisted');
  render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={defaultUITheme as unknown as DefaultTheme}>
        {kind === 'number' ? (
          <NumberPropertyForm resource={draft} />
        ) : (
          <TextPropertyForm resource={draft} />
        )}
      </ThemeProvider>
    </StoreContext.Provider>,
  );

  return { draft, save };
}

it('still defaults a new number draft to float without persisting it', async () => {
  const { draft, save } = await setup();
  await waitFor(() =>
    expect(draft.get(core.properties.datatype)).toBe(Datatype.FLOAT),
  );
  expect(save).not.toHaveBeenCalled();
});

it('preserves a fractional range boundary for an integer column', async () => {
  const { draft, save } = await setup('number', undefined, 0);
  fireEvent.change(screen.getByPlaceholderText('max'), {
    target: { value: '2.5' },
  });

  await waitFor(() => expect(draft.get(dataBrowser.properties.max)).toBe(2.5));
  expect(draft.get(core.properties.datatype)).toBe(Datatype.INTEGER);
  expect(save).not.toHaveBeenCalled();
});

it('leaves fractional precision visible without changing saved precision or datatype', async () => {
  const { draft } = await setup('number', undefined, 0);
  const input = screen.getByLabelText<HTMLInputElement>('Decimal Places');
  await act(async () => {
    fireEvent.change(input, { target: { value: '1.5' } });
  });

  expect(input.value).toBe('1.5');
  expect(draft.get(dataBrowser.properties.decimalPlaces)).toBe(0);
  expect(draft.get(core.properties.datatype)).toBe(Datatype.INTEGER);
});

// The clean baseline saves text-format changes explicitly. The old legacy
// extraction ancestry had removed this call; restacking must not inherit that.
it('preserves the clean host explicit save when changing text format', async () => {
  const { draft, save } = await setup('text');
  fireEvent.click(screen.getByRole('radio', { name: 'Rich text' }));
  await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith());
  expect(draft.get(core.properties.datatype)).toBe(Datatype.MARKDOWN);
});
