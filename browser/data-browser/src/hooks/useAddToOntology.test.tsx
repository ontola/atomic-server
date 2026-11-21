// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, renderHook } from '@testing-library/react';
import { core, type Resource } from '@tomic/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAddToOntology } from './useAddToOntology';

const drive = 'atomic:drive';
const ontology = 'atomic:ontology';
const previousClass = 'atomic:existing-class';
const newClass = 'atomic:new-class';
const preview = {
  subject: ontology,
  props: { classes: [] },
  set: vi.fn(),
  save: vi.fn(),
};
const loaded = {
  props: { classes: [previousClass] },
  set: vi.fn(),
  save: vi.fn(),
};
const getResource = vi.fn(async (id: string) =>
  id === ontology ? loaded : { title: id },
);

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useStore: () => ({ getResource }),
  useResource: (id: string) =>
    id === drive ? { props: { defaultOntology: ontology } } : preview,
}));
vi.mock('../helpers/AppSettings', () => ({ useSettings: () => ({ drive }) }));

afterEach(cleanup);

it('adds a row class to the loaded ontology, preserving classes omitted by the preview', async () => {
  const row = {
    subject: newClass,
    get: () => ontology,
    set: vi.fn(),
    save: vi.fn(),
    hasClasses: (id: string) => id === core.classes.class,
  } as unknown as Resource;
  const { result } = renderHook(() => useAddToOntology());
  await result.current(row);

  expect(loaded.set).toHaveBeenCalledWith(core.properties.classes, [
    previousClass,
    newClass,
  ]);
  expect(loaded.save).toHaveBeenCalledOnce();
  expect(preview.set).not.toHaveBeenCalled();
});
