// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  core,
  Datatype,
  LoroLoader,
  Store,
  StoreContext,
  type Resource,
} from '@tomic/react';
import { FormValidationContextProvider } from '@tomic/resource-ui/components/forms/formValidation/FormValidationContextProvider';
import { buildTheme, ThemeProvider } from '../../../test/providers';
import { PropertyForm } from './PropertyForm.js';

vi.mock('./categories.js', () => ({ categoryFormFactory: () => () => null }));
afterEach(cleanup);
beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

async function fixture() {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const subject of [core.properties.name, core.properties.shortname]) {
    const property = await store.newResource({ subject, noParent: true });
    await property.set(core.properties.datatype, Datatype.STRING, false);
    await property.set(core.properties.shortname, 'test-property', false);
    await property.set(core.properties.description, 'Test metadata', false);
    await store.getProperty(subject);
  }

  let next = 0;

  const draft = async (name = '', shortname = '') => {
    const resource = await store.newResource({
      subject: `_new:name-${++next}`,
      noParent: true,
    });
    await resource.set(core.properties.name, name, false);
    await resource.set(core.properties.shortname, shortname, false);

    return resource;
  };

  const change = vi.fn();

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <StoreContext value={store}>
        <ThemeProvider theme={buildTheme()}>
          <FormValidationContextProvider onValidationChange={change}>
            {children}
          </FormValidationContextProvider>
        </ThemeProvider>
      </StoreContext>
    );
  }

  return { store, draft, Wrapper };
}

it('gives each column-name input its own accessible error relationship', async () => {
  const { draft, Wrapper } = await fixture();
  const first = await draft(),
    second = await draft();
  render(
    <Wrapper>
      <PropertyForm resource={first} onSubmit={() => {}} />
      <PropertyForm resource={second} onSubmit={() => {}} />
    </Wrapper>,
  );
  const inputs = screen.getAllByRole('textbox', { name: 'Column name' });
  expect(inputs[0].id).not.toBe(inputs[1].id);
  fireEvent.blur(inputs[0]);
  const error = await screen.findByRole('alert');
  expect(inputs[0].getAttribute('aria-invalid')).toBe('true');
  expect(inputs[0].getAttribute('aria-describedby')).toBe(error.id);
  expect(inputs[1].getAttribute('aria-describedby')).toBeNull();
});

it.each([true, false])(
  'retains raw names and the existing-property shortname policy (%s)',
  async existingProperty => {
    const { draft, Wrapper } = await fixture();
    const resource = await draft('Original', 'stable-shortname');
    const save = vi.spyOn(resource, 'save').mockResolvedValue('persisted');
    render(
      <Wrapper>
        <PropertyForm
          resource={resource}
          existingProperty={existingProperty}
          onSubmit={() => {}}
        />
      </Wrapper>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Column name' }), {
      target: { value: '  New Label  ' },
    });
    await waitFor(() =>
      expect(resource.get(core.properties.name)).toBe('  New Label  '),
    );
    expect(resource.get(core.properties.shortname)).toBe(
      existingProperty ? 'stable-shortname' : 'new-label',
    );
    expect(save).not.toHaveBeenCalled();
  },
);

it('exposes disabled presentation without changing the name', async () => {
  const { draft, Wrapper } = await fixture();
  const resource = await draft('Original');
  render(
    <Wrapper>
      <PropertyForm resource={resource} disabled onSubmit={() => {}} />
    </Wrapper>,
  );
  const input = screen.getByRole('textbox', { name: 'Column name' });
  expect(input.hasAttribute('disabled')).toBe(true);
  fireEvent.change(input, { target: { value: 'Blocked' } });
  expect(resource.get(core.properties.name)).toBe('Original');
});

it('selects the new resource name when an autofocus form is reused', async () => {
  const { draft, Wrapper } = await fixture();
  const first = await draft('First'),
    second = await draft('Second');
  const renderForm = (resource: Resource) => (
    <Wrapper>
      <PropertyForm resource={resource} autoFocusName onSubmit={() => {}} />
    </Wrapper>
  );
  const result = render(renderForm(first));
  const input = screen.getByRole('textbox', {
    name: 'Column name',
  }) as HTMLInputElement;
  await waitFor(() => expect(input.selectionEnd).toBe('First'.length));
  input.setSelectionRange(0, 0);
  result.rerender(renderForm(second));
  await waitFor(() => {
    expect(input.value).toBe('Second');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Second'.length);
    expect(document.activeElement).toBe(input);
  });
});
