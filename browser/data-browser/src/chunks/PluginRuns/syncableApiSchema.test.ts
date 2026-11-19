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
