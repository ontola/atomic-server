import { describe, expect, it } from 'vitest';
import { core, Datatype } from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import { syncableApiSchema, syncableApiSchemaSpec } from './syncableApiSchema';

const document = (title = 'Studio Boards', fieldType = 'integer') => ({
  openapi: '3.0.3',
  info: { title, version: '1' },
  servers: [{ url: 'https://boards.example/api' }],
  paths: {},
  components: {
    crudResources: {
      board: {
        identity: {
          urlTemplate: '/boards/{boardId}',
          bindings: { boardId: { field: 'id' } },
        },
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            size: { type: fieldType },
          },
        },
        collections: { boards: { urlTemplate: '/boards' } },
      },
    },
  },
});

describe('catalog-derived Atomic schema', () => {
  it('uses resource-specific link bindings without changing raw fields or requiring unresolved links', async () => {
    const doc = document();
    const board = doc.components.crudResources.board;
    Object.assign(board.schema.properties, {
      owner: { type: 'object' },
      reviewers: { type: 'array', items: { type: 'object' } },
    });
    board.schema.required.push('owner');
    Object.assign(board, {
      'x-embeddedResources': {
        owner: { resource: 'person', cardinality: 'one' },
        reviewers: { resource: 'person', cardinality: 'many' },
      },
    });
    Object.assign(doc.components.crudResources, {
      person: {
        identity: {
          urlTemplate: '/people/{id}',
          bindings: { id: { field: 'id' } },
        },
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            owner: { type: 'object' },
          },
        },
      },
    });
    const before = structuredClone(doc);
    delete (before.components.crudResources.board as Record<string, unknown>)[
      'x-embeddedResources'
    ];
    const old = syncableApiSchemaSpec(
      'https://proxy.example',
      'studio',
      before,
    );
    const derived = syncableApiSchemaSpec(
      'https://proxy.example',
      'studio',
      doc,
    );
    expect(derived.classKeys).toEqual(old.classKeys);
    expect(derived.propertyKeys.owner).toBe(old.propertyKeys.owner);
    const linkedOwner = derived.resourcePropertyKeys.board.owner;
    const linkedReviewers = derived.resourcePropertyKeys.board.reviewers;
    for (const term of [...derived.spec.properties, ...derived.spec.classes])
      expect(term.shortname).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(
      derived.spec.properties.find(p => p.shortname === linkedOwner)?.datatype,
    ).toBe(Datatype.ATOMIC_URL);
    expect(
      derived.spec.properties.find(p => p.shortname === linkedReviewers)
        ?.datatype,
    ).toBe(Datatype.RESOURCEARRAY);
    expect(derived.resourcePropertyKeys.person.owner).toBe(
      old.propertyKeys.owner,
    );
    const klass = derived.spec.classes.find(
      c => c.shortname === derived.classKeys.board,
    )!;
    expect(klass.requires).toEqual([derived.propertyKeys.id]);
    expect(derived.requiredFieldNames.board).toEqual(['id', 'owner']);
    expect(klass.recommends).toContain(linkedOwner);
    expect(klass.recommends).not.toContain(old.propertyKeys.owner);
    const { store, resources } = fakeSchemaStore();
    const previous = await syncableApiSchema(
      store,
      'drive',
      'https://proxy.example',
      'studio',
      before,
      true,
    );
    resources.get(previous.classes.board)![core.properties.recommends] = [
      ...(resources.get(previous.classes.board)![
        core.properties.recommends
      ] as string[]),
      'custom:notes',
    ];
    const installed = await syncableApiSchema(
      store,
      'drive',
      'https://proxy.example',
      'studio',
      doc,
      true,
    );
    expect(installed.classes).toEqual(previous.classes);
    expect(resources.has(previous.properties.owner)).toBe(true);
    expect(
      resources.get(installed.classes.board)?.[core.properties.requires],
    ).toEqual([installed.properties.id]);
    expect(
      resources.get(installed.classes.board)?.[core.properties.recommends],
    ).toContain(installed.resourceProperties?.board.owner);
    expect(
      resources.get(installed.classes.board)?.[core.properties.recommends],
    ).toContain('custom:notes');
  });
  it('revokes delayed native schema setup before it can create terms', async () => {
    const { store, resources } = fakeSchemaStore();
    await syncableApiSchema(
      store,
      'drive',
      'https://proxy.example',
      'studio',
      document(),
      true,
    );
    const count = resources.size;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = store.getResource.bind(store);

    store.getResource = async subject => {
      const resource = await original(subject);
      entered();
      await gate;

      return resource;
    };

    let active = true;
    const setup = syncableApiSchema(
      store,
      'drive',
      'https://proxy.example',
      'studio',
      document('Studio', 'string'),
      true,
      () => {
        if (!active) throw new Error('The source changed');
      },
    );
    await waiting;
    active = false;
    release();
    await expect(setup).rejects.toThrow('The source changed');
    expect(resources.size).toBe(count);
  });
  it('retains class and property identities across provider display-name changes', async () => {
    const { store, resources } = fakeSchemaStore();
    const first = await syncableApiSchema(
      store,
      'drive',
      'https://proxy.example',
      'studio',
      document(),
      true,
    );
    const count = resources.size;
    const second = await syncableApiSchema(
      store,
      'drive',
      'https://proxy.example',
      'studio',
      document('Renamed Studio'),
      true,
    );
    expect(second).toEqual(first);
    expect(resources.size).toBe(count);
    expect(
      resources.get(first.properties.size)?.[core.properties.datatype],
    ).toBe(Datatype.INTEGER);
  });

  it('separates provider/proxy namespaces and preserves immutable property types', () => {
    const first = syncableApiSchemaSpec(
      'https://proxy.example',
      'studio',
      document(),
    );
    expect(
      syncableApiSchemaSpec('https://other.example', 'studio', document())
        .classKeys,
    ).not.toEqual(first.classKeys);
    expect(
      syncableApiSchemaSpec('https://proxy.example', 'another', document())
        .classKeys,
    ).not.toEqual(first.classKeys);
    const changed = syncableApiSchemaSpec(
      'https://proxy.example',
      'studio',
      document('Studio', 'string'),
    );
    expect(changed.classKeys).toEqual(first.classKeys);
    expect(changed.propertyKeys.size).not.toBe(first.propertyKeys.size);
  });

  it('resolves an installed schema without writes and fails clearly before setup', async () => {
    const { store, resources } = fakeSchemaStore();
    await expect(
      syncableApiSchema(
        store,
        'drive',
        'https://proxy.example',
        'studio',
        document(),
        false,
      ),
    ).rejects.toThrow('install its catalog schema');
    const installed = await syncableApiSchema(
      store,
      'drive',
      'https://proxy.example',
      'studio',
      document(),
      true,
    );
    const count = resources.size;
    expect(
      await syncableApiSchema(
        store,
        'drive',
        'https://proxy.example',
        'studio',
        document(),
        false,
      ),
    ).toEqual(installed);
    expect(resources.size).toBe(count);
  });
});
