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
import { Store, LoroLoader, core, Datatype } from '@tomic/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../../styling';
import { TextPropertyForm } from './TextPropertyForm';

vi.mock('./Inputs/TableRangeInput', () => ({ TableRangeInput: () => null }));
afterEach(cleanup);
beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

it('changes only the unsaved property draft when a text format is selected', async () => {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
  const draft = await store.newResource({
    subject: '_new:column-draft',
    noParent: true,
  });
  await draft.set(core.properties.datatype, Datatype.STRING, false);
  const save = vi.spyOn(draft, 'save').mockResolvedValue('persisted');
  render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <TextPropertyForm resource={draft} />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Rich text' }));
  await waitFor(() =>
    expect(draft.get(core.properties.datatype)).toBe(Datatype.MARKDOWN),
  );
  expect(save).not.toHaveBeenCalled();
});
