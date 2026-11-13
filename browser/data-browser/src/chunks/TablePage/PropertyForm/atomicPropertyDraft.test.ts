// @wc-ignore-file
import { beforeEach, expect, it, vi } from 'vitest';
import {
  core,
  dataBrowser,
  Datatype,
  type Resource,
  type Store,
} from '@tomic/react';
import {
  prepareAtomicPropertyDraft,
  saveAtomicPropertyDraft,
} from './atomicPropertyDraft';
const mocks = vi.hoisted(() => ({
  draft: vi.fn(),
  create: vi.fn(),
  carry: vi.fn(),
  replace: vi.fn(),
  constraint: vi.fn(),
  applyConstraint: vi.fn(),
}));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  getEffectiveConstraint: () => undefined,
  setClassConstraint: (...args: unknown[]) => mocks.constraint(...args),
}));
vi.mock('./categories', () => ({ getCategoryFromResource: () => 'number' }));
vi.mock('./columnConstraints', () => ({
  CONSTRAINT_FIELDS: [],
  seedDraftFromConstraint: vi.fn(),
  applyDraftConstraint: (...args: unknown[]) => mocks.applyConstraint(...args),
}));
vi.mock('@helpers/propertyIdentity', () => ({
  isContentAddressed: () => true,
  createPropertyDraft: (...args: unknown[]) => mocks.draft(...args),
  createContentAddressedFromDraft: (...args: unknown[]) =>
    mocks.create(...args),
  carryValuesOver: (...args: unknown[]) => mocks.carry(...args),
  replacePropertyReferences: (...args: unknown[]) => mocks.replace(...args),
  applyDraftFields: vi.fn(),
}));

function resource(
  subject: string,
  classes: string[] = [],
  values: Record<string, unknown> = {},
) {
  const fields = new Map(Object.entries(values));
  const saved: unknown[] = [];

  return {
    subject,
    fields,
    saved,
    get: (key: string) => fields.get(key),
    hasClasses: (cls: string) => classes.includes(cls),
    save: vi.fn(async () => {
      saved.push(structuredClone([...fields.entries()]));

      return 'persisted' as const;
    }),
  };
}

type Stub = ReturnType<typeof resource>;
const asResource = (value: Stub) => value as unknown as Resource;
let original: Stub,
  table: Stub,
  view: Stub,
  ontology: Stub,
  unrelated: Stub,
  created: Stub;
let store: Store;
beforeEach(() => {
  vi.resetAllMocks();
  const old = 'https://example.com/old';
  original = resource(old, [], {
    [core.properties.name]: 'Original',
    [core.properties.datatype]: Datatype.FLOAT,
    [core.properties.parent]: 'https://example.com/ontology',
  });
  table = resource('https://example.com/class', [core.classes.class], {
    [core.properties.recommends]: [old],
  });
  view = resource('https://example.com/view', [], {
    [dataBrowser.properties.viewColumns]: [old],
  });
  ontology = resource('https://example.com/ontology', [core.classes.ontology], {
    [core.properties.properties]: [old],
  });
  unrelated = resource('https://example.com/unrelated-row', [], {
    [core.properties.recommends]: [old],
  });
  created = resource('https://example.com/new', [], {
    [core.properties.datatype]: Datatype.INTEGER,
  });
  store = {
    getResource: vi.fn(async () => asResource(table)),
    clientSideQuery: (predicate: (value: Resource) => boolean) =>
      [table, view, ontology, unrelated].map(asResource).filter(predicate),
  } as unknown as Store;
  let sequence = 0;
  mocks.draft.mockImplementation(
    async (_store, _parent, { source }: { source: Resource }) =>
      asResource(
        resource(
          'draft-' + sequence++,
          [],
          Object.fromEntries((source as unknown as Stub).fields),
        ),
      ),
  );
  mocks.create.mockResolvedValue(asResource(created));
  mocks.carry.mockResolvedValue(undefined);
  mocks.constraint.mockResolvedValue(undefined);
  mocks.applyConstraint.mockResolvedValue(undefined);
  mocks.replace.mockImplementation(async () => {
    for (const [target, property] of [
      [table, core.properties.recommends],
      [view, dataBrowser.properties.viewColumns],
      [ontology, core.properties.properties],
    ] as const) {
      const list = target.fields.get(property) as string[];

      if (list.includes(old)) {
        target.fields.set(
          property,
          list.map(value => (value === old ? created.subject : value)),
        );
        await target.save();
      }
    }
  });
});
it('reuses the materialized identity and frozen constraints while draining references skipped by old-ID discovery', async () => {
  const prepared = await prepareAtomicPropertyDraft(
    store,
    asResource(original),
    table.subject,
  );
  const edited = prepared.resource as unknown as Stub;
  edited.fields.set(core.properties.datatype, Datatype.INTEGER);
  edited.fields.set(core.properties.name, 'Frozen candidate');
  view.save.mockRejectedValueOnce(Error('View save failed'));
  await expect(saveAtomicPropertyDraft(store, prepared)).rejects.toThrow(
    'View save failed',
  );
  expect(prepared.materialized?.subject).toBe(created.subject);
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(view.fields.get(dataBrowser.properties.viewColumns)).toEqual([
    created.subject,
  ]);
  edited.fields.set(core.properties.name, 'Changed after partial save');
  edited.fields.set(core.properties.datatype, Datatype.FLOAT);
  await saveAtomicPropertyDraft(store, prepared);
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.draft).toHaveBeenCalledTimes(2);
  expect((prepared.snapshot as unknown as Stub).get(core.properties.name)).toBe(
    'Frozen candidate',
  );
  expect(
    (prepared.snapshot as unknown as Stub).get(core.properties.datatype),
  ).toBe(Datatype.INTEGER);
  expect(mocks.applyConstraint).toHaveBeenCalledWith(
    asResource(table),
    created.subject,
    prepared.snapshot,
  );
  expect(view.saved.length).toBeGreaterThan(0);
  expect(ontology.fields.get(core.properties.properties)).toEqual([
    created.subject,
  ]);
  expect(unrelated.save).not.toHaveBeenCalled();
});
it('allows repair before materialization and writes no references after failed definition creation', async () => {
  const prepared = await prepareAtomicPropertyDraft(
    store,
    asResource(original),
    table.subject,
  );
  const edited = prepared.resource as unknown as Stub;
  edited.fields.set(core.properties.datatype, Datatype.INTEGER);
  mocks.create.mockRejectedValueOnce(Error('Definition rejected'));
  await expect(saveAtomicPropertyDraft(store, prepared)).rejects.toThrow(
    'Definition rejected',
  );
  expect(prepared.materialized).toBeUndefined();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(table.save).not.toHaveBeenCalled();
  edited.fields.set(core.properties.name, 'Repaired candidate');
  await saveAtomicPropertyDraft(store, prepared);
  expect((prepared.snapshot as unknown as Stub).get(core.properties.name)).toBe(
    'Repaired candidate',
  );
  expect(mocks.create).toHaveBeenCalledTimes(2);
});
it('rejects an incomplete checkpoint before writing references or constraints', async () => {
  const prepared = await prepareAtomicPropertyDraft(
    store,
    asResource(original),
    table.subject,
  );
  prepared.materialized = asResource(created);
  await expect(saveAtomicPropertyDraft(store, prepared)).rejects.toThrow(
    'checkpoint is incomplete',
  );
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.applyConstraint).not.toHaveBeenCalled();
  expect(table.save).not.toHaveBeenCalled();
});
