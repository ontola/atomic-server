// @vitest-environment jsdom
// @wc-ignore-file
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
  urls,
  Datatype,
} from '@tomic/react';
import { buildTheme } from '../../../../styling';
import { FormValidationContextProvider } from '@components/forms/formValidation/FormValidationContextProvider';
import { DecimalPlacesInput } from './DecimalPlacesInput';
import { DateFormatPicker } from './DateFormatPicker';
afterEach(cleanup);
beforeAll(async () => {
  const web = await import('loro-crdt/web');
  await web.default({
    module_or_path: await readFile(
      createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
    ),
  });
  await LoroLoader.initializeLoro();
});
it('retains invalid precision without changing Atomic metadata, and applies zero/unset datatype policy only after valid input', async () => {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const [subject, datatype] of [
    [core.properties.datatype, Datatype.ATOMIC_URL],
    [urls.properties.constraints.decimalPlaces, Datatype.INTEGER],
  ]) {
    const property = await store.newResource({ subject, noParent: true });
    await property.set(core.properties.datatype, datatype, false);
    await property.set(core.properties.shortname, 'precision', false);
    await property.set(
      core.properties.description,
      'Precision fixture metadata',
      false,
    );
    await store.getProperty(subject);
  }

  const draft = await store.newResource({
    subject: '_new:precision',
    noParent: true,
  });
  await draft.set(core.properties.datatype, Datatype.FLOAT, false);
  await draft.set(urls.properties.constraints.decimalPlaces, 2, false);
  const validity = vi.fn();
  render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <FormValidationContextProvider onValidationChange={validity}>
          <DecimalPlacesInput resource={draft} />
        </FormValidationContextProvider>
      </ThemeProvider>
    </StoreContext.Provider>,
  );
  const input = screen.getByRole('textbox', { name: 'Decimal Places' });
  fireEvent.change(input, { target: { value: '1.5' } });
  expect((input as HTMLInputElement).value).toBe('1.5');
  expect(draft.get(core.properties.datatype)).toBe(Datatype.FLOAT);
  expect(draft.get(urls.properties.constraints.decimalPlaces)).toBe(2);
  await waitFor(() => expect(validity).toHaveBeenLastCalledWith(false));
  fireEvent.change(input, { target: { value: '0' } });
  await waitFor(() =>
    expect(draft.get(urls.properties.constraints.decimalPlaces)).toBe(0),
  );
  expect(draft.get(core.properties.datatype)).toBe(Datatype.INTEGER);
  await waitFor(() => expect(validity).toHaveBeenLastCalledWith(true));
  fireEvent.change(input, { target: { value: '' } });
  await waitFor(() =>
    expect(
      draft.get(urls.properties.constraints.decimalPlaces),
    ).toBeUndefined(),
  );
  expect(draft.get(core.properties.datatype)).toBe(Datatype.FLOAT);
});
it('dispatches the Atomic format ID through the shared date choices', () => {
  const change = vi.fn();
  render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <DateFormatPicker
        value={urls.instances.dateFormats.localNumeric}
        onChange={change}
        withTime
      />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Long' }));
  expect(change).toHaveBeenCalledWith(urls.instances.dateFormats.localLong);
});
