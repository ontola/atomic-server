// @wc-ignore-file
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  core,
  server,
  dataBrowser,
  pluginSchema,
  ensureSchema,
  LoroLoader,
  type Store,
  type JSONValue,
} from '@tomic/lib';
import {
  prepareDocument,
  describeCollections,
  bindCollection,
  projectEntityObservation,
  type OpenApiDocument,
  type EntityIdentity,
} from 'syncables/browser';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import { sourceKey } from './builtinSyncIdentity.js';
import { syncablePlatformSchema } from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';
import { syncableApiSchema } from './syncableApiSchema';
import {
  materializeSyncableReferences,
  validateSyncableReferenceEvidence,
  type ReferenceMaterializationContext,
} from './syncableReferenceRecords';

vi.mock('@tomic/lib', async original => ({
  ...(await original<typeof import('@tomic/lib')>()),
  readConnectionSubjects: async (
    store: { queryReferences: (...args: unknown[]) => Promise<string[]> },
    ...args: unknown[]
  ) => store.queryReferences(...args),
}));
beforeAll(() => {
  (LoroLoader as unknown as { _Loro: unknown })._Loro = createRequire(
    import.meta.url,
  )('loro-crdt');
});

function document(): OpenApiDocument {
  return prepareDocument({
    openapi: '3.0.3',
    info: { title: 'Invented work tracker', version: '1' },
    servers: [{ url: 'https://example.test' }],
    components: {
      crudResources: {
        ticket: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              owner: { type: 'object' },
              reviewers: { type: 'array', items: { type: 'object' } },
              sponsorId: { type: 'integer', nullable: true },
            },
          },
          identity: {
            urlTemplate: '/tickets/{ticket_id}',
            bindings: { ticket_id: { field: 'id' } },
          },
          collections: {
            tickets: { urlTemplate: '/workspaces/{workspace_id}/tickets' },
            personTickets: { urlTemplate: '/people/{person_id}/tickets' },
          },
          references: {
            sponsor: {
              resource: 'person',
              required: false,
              bindings: {
                person_id: { field: 'sponsorId' },
                workspace_id: { field: 'workspaceId' },
              },
            },
          },
          'x-embeddedResources': {
            owner: {
              representation: 'object',
              cardinality: 'one',
              discriminator: {
                field: 'kind',
                mapping: { Person: 'person', Team: 'team' },
              },
            },
            reviewers: { resource: 'person', cardinality: 'many' },
            sponsorId: {
              representation: 'identity',
              cardinality: 'one',
              reference: 'sponsor',
            },
          },
        },
        person: {
          schema: {
            type: 'object',
            required: ['id', 'name', 'email'],
            properties: {
              portrait: { type: 'string', format: 'uri' },
              published: { type: 'string', format: 'date-time' },
              id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
              name: { type: 'string' },
              email: { type: 'string' },
              active: { type: 'boolean' },
            },
          },
          identity: {
            urlTemplate: '/workspaces/{workspace_id}/people/{person_id}',
            bindings: { person_id: { field: 'id' } },
          },
        },
        team: {
          schema: {
            type: 'object',
            properties: { id: { type: 'integer' }, name: { type: 'string' } },
          },
          identity: {
            urlTemplate: '/teams/{team_id}',
            bindings: { team_id: { field: 'id' } },
          },
        },
      },
    },
    paths: {
      '/people/{person_id}/tickets': {
        get: {
          operationId: 'personTickets',
          parameters: [
            {
              name: 'person_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          'x-crud': {
            action: 'list',
            resource: 'ticket',
            collection: 'personTickets',
          },
          responses: {
            '200': {
              description: 'Person tickets',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
      },
      '/workspaces/{workspace_id}/tickets': {
        get: {
          operationId: 'tickets',
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          'x-crud': {
            action: 'list',
            resource: 'ticket',
            collection: 'tickets',
          },
          responses: {
            '200': {
              description: 'Tickets',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
      },
      '/workspaces/{workspace_id}/people/{person_id}': {
        get: {
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          responses: { '200': { description: 'Person' } },
        },
      },
    },
  });
}

async function fixture() {
  const f = fakeSchemaStore();
  const drive = 'atomic:drive';
  const props = f.resources.get('drive')!;
  const ontology = f.resources.get('drive-ontology')!;
  f.resources.delete('drive');
  f.resources.delete('drive-ontology');
  f.resources.set(drive, {
    ...props,
    [core.properties.isA]: [server.classes.drive],
    [server.properties.defaultOntology]: 'atomic:ontology',
  });
  f.resources.set('atomic:ontology', {
    ...ontology,
    [core.properties.parent]: drive,
  });
  const actor = {
    subject: 'atomic:agent:me',
    server: 'http://localhost:9988',
    selected: drive,
    denied: new Set<string>(),
    beforeSet: undefined as (() => void) | undefined,
    afterSave: undefined as ((subject: string) => void) | undefined,
    unscoped: false,
  };
  const writes: string[] = [],
    queries: {
      drive: string;
      property: string;
      value: unknown;
      includeTrashed: boolean;
    }[] = [];
  const cache = new Map<
    string,
    Awaited<ReturnType<typeof f.store.getResource>>
  >();
  const get = f.store.getResource.bind(f.store),
    create = f.store.newResource.bind(f.store);

  const wrap = async (subject: string) => {
    if (!cache.has(subject)) {
      const row = await get(subject),
        set = row.set.bind(row);
      cache.set(
        subject,
        Object.assign(row, {
          getSubjects: (property: string) => row.get(property) ?? [],
          hasClasses: (...classes: string[]) =>
            classes.every(klass =>
              (row.get(core.properties.isA) as string[] | undefined)?.includes(
                klass,
              ),
            ),
          canWrite: async () => [!actor.denied.has(subject), undefined],
          set: async (
            property: string,
            value: JSONValue,
            _validate?: boolean,
            _datatype?: unknown,
            guard?: () => void,
          ) => {
            actor.beforeSet?.();
            guard?.();
            writes.push(subject);
            await set(property, value);
          },
          save: async () => {
            writes.push(subject);
            actor.afterSave?.(subject);
          },
        }),
      );
    }

    return cache.get(subject)!;
  };

  f.store.getResource = wrap;

  f.store.newResource = async opts => {
    const draft = await create(opts),
      subject = draft.subject.replace('local:', 'atomic:');
    const values = f.resources.get(draft.subject)!;
    f.resources.delete(draft.subject);
    f.resources.set(subject, values);

    return wrap(subject);
  };

  const beneath = (subject: string, root: string) => {
    const seen = new Set<string>();
    let current: unknown = subject;

    while (typeof current === 'string' && !seen.has(current)) {
      if (current === root) return true;
      seen.add(current);
      current = f.resources.get(current)?.[core.properties.parent];
    }

    return false;
  };

  Object.assign(f.store, {
    getAgent: () => actor,
    getServerUrl: () => actor.server,
    getDrive: () => actor.selected,
    normalizeSubject: (subject: string) => subject,
    resources: cache,
    queryReferences: async (
      root: string,
      property: string,
      value: unknown,
      options: { includeTrashed: boolean },
    ) => {
      queries.push({
        drive: root,
        property,
        value,
        includeTrashed: options.includeTrashed,
      });

      return [...f.resources]
        .filter(
          ([subject, values]) =>
            (actor.unscoped || beneath(subject, root)) &&
            values[property] !== undefined &&
            (value === undefined || values[property] === value),
        )
        .map(([subject]) => subject);
    },
  });
  f.resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: 'https://atomicdata.dev/datatypes/string',
    [core.properties.shortname]: 'name',
  });
  const platform = await ensureSchema(f.store, drive, syncablePlatformSchema());
  const hierarchy = await ensureSchema(
    f.store,
    drive,
    syncableHierarchySchema(),
  );
  const plugin = await ensureSchema(f.store, drive, pluginSchema());
  const doc = document();
  const apiSchema = await syncableApiSchema(
    f.store,
    drive,
    'https://proxy.example',
    'invented',
    doc,
    true,
  );
  const schema = {
    properties: { ...platform.properties, ...hierarchy.properties },
    classes: { ...platform.classes, ...hierarchy.classes },
  };
  const principal = { kind: 'public' as const };
  const context: ReferenceMaterializationContext = {
    drive,
    proxyOrigin: 'https://proxy.example',
    platform: 'invented',
    principal,
    principalApp: 'atomic:principal',
    document: doc,
    schema,
    apiSchema,
  };
  const key = sourceKey({ ...context, kind: 'principal' });
  f.resources.set(context.principalApp, {
    [core.properties.parent]: drive,
    [core.properties.name]: 'Invented · Public',
    [core.properties.isA]: [
      dataBrowser.classes.table,
      hierarchy.classes['syncable-principal'],
      plugin.classes.app,
    ],
    [schema.properties['syncable-source-key']]: key,
    [schema.properties['syncable-node-kind']]: 'principal',
    [schema.properties['syncable-source-config']]: {
      version: 2,
      kind: 'principal',
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      principal,
    },
    [platform.properties['builtin-app']]: 'syncables',
    [platform.properties['syncable-platform-id']]: context.platform,
    [platform.properties['syncable-proxy-origin']]: context.proxyOrigin,
    [plugin.properties['app-data']]: context.principalApp,
  });
  const collection = describeCollections(doc).find(
    item => item.resource === 'ticket',
  )!;
  const observe = (
    raw: Record<string, unknown>,
    workspace_id: string | number = 9,
    extraContext: Record<string, string | number> = {},
  ) =>
    projectEntityObservation(doc, {
      collection,
      record: { id: 1, ...raw },
      context: { workspace_id, ...extraContext },
      provenance: {
        read: bindCollection(doc, {
          collection: 'tickets',
          context: { workspace_id: String(workspace_id) },
        }),
      },
    });
  const run = (
    raw: Record<string, unknown>,
    workspace_id: string | number = 9,
    assert = () => {},
    extraContext: Record<string, string | number> = {},
  ) =>
    materializeSyncableReferences(
      f.store as unknown as Store,
      context,
      [observe(raw, workspace_id, extraContext)],
      assert,
    );
  const owner = (result: Awaited<ReturnType<typeof run>>) =>
    result.find(field => field.field === 'owner')!.subjects[0];
  writes.length = 0;
  queries.length = 0;

  return { ...f, context, actor, writes, queries, run, observe, owner, wrap };
}

const person = (extra: Record<string, unknown> = {}) => ({
  kind: 'Person',
  id: 7,
  name: 'API Person',
  ...extra,
});
const configOf = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.resources.get(id)![
    f.context.schema.properties['syncable-source-config']
  ] as Record<string, unknown>;

describe('native direct reference records', () => {
  it('retains an active proven origin without self-invalidating on new child-read context or raw enrichment', async () => {
    const f = await fixture();
    const id = f.owner(await f.run({ owner: person() }));
    const before = structuredClone(f.resources.get(id)!);
    const origin = configOf(f, id);
    f.context.readonlyOriginEntityKeys = [
      (origin.entityIdentity as { key: string }).key,
    ];
    const stamp = JSON.stringify(origin);

    const assertOrigin = () => {
      if (JSON.stringify(configOf(f, id)) !== stamp)
        throw new Error('The Sync filter source entity changed');
    };

    f.writes.length = 0;
    const result = await f.run(
      { owner: person({ email: 'new@example.test' }) },
      9,
      assertOrigin,
      { child_scope: 123 },
    );
    expect(f.owner(result)).toBe(id);
    expect(f.resources.get(id)).toEqual(before);
    expect(f.writes).not.toContain(id);
    expect(configOf(f, id).read).toBeUndefined();
  });

  it.each([
    'key',
    'principal',
    'table',
    'Drive',
    'raw identity',
    'missing',
    'missing table',
  ])(
    'does not bypass retained origin validation for corrupt %s evidence',
    async corruption => {
      const f = await fixture();
      const id = f.owner(await f.run({ owner: person() }));
      const p = f.context.schema.properties;
      const row = f.resources.get(id)!;
      const origin = configOf(f, id);
      f.context.readonlyOriginEntityKeys = [
        (origin.entityIdentity as { key: string }).key,
      ];
      if (corruption === 'key') row[p['syncable-source-key']] = 'forged';
      if (corruption === 'principal')
        origin.principal = {
          kind: 'authenticated',
          namespace: 'https://foreign.example',
          subject: 8,
        };
      if (corruption === 'table')
        row[p['syncable-entity-table']] = 'atomic:foreign-table';
      if (corruption === 'Drive')
        row['https://atomicdata.dev/properties/drive'] = 'atomic:other-drive';
      if (corruption === 'raw identity') origin.record = { id: 999 };
      if (corruption === 'missing') f.resources.delete(id);

      if (corruption === 'missing table') {
        row[core.properties.parent] = f.context.principalApp;
        f.resources.delete(String(row[p['syncable-entity-table']]));
      }

      f.writes.length = 0;
      await expect(
        f.run({ owner: person({ email: 'more@example.test' }) }),
      ).rejects.toThrow();
      expect(f.writes).toEqual([]);
    },
  );

  it('keeps a canonical partial record when a separate relationship binding is missing', async () => {
    const f = await fixture();
    const resources = f.context.document.components!.crudResources as Record<
      string,
      Record<string, unknown>
    >;
    resources.person.references = {
      teamRoute: {
        resource: 'team',
        bindings: { team_id: { field: 'routeId' } },
      },
    };
    const detailResponse = {
      description: 'Team',
      links: {
        tickets: {
          operationId: 'personTickets',
          parameters: { person_id: '$response.body#/id' },
        },
      },
    };
    f.context.document.paths['/teams/{team_id}'] = {
      get: {
        operationId: 'teamRoute',
        'x-crud': { action: 'read', resource: 'team' },
        responses: {
          '200': detailResponse,
        },
      },
    };
    const result = await f.run({ owner: { id: 7, kind: 'Person' } });
    const id = f.owner(result);
    const row = f.resources.get(id)!;
    expect(configOf(f, id).record).toEqual({ id: 7, kind: 'Person' });
    expect(configOf(f, id).read).toBeUndefined();
    expect(
      row[f.context.schema.properties['syncable-navigation-intents']],
    ).toEqual([]);
    expect(
      row[f.context.schema.properties['syncable-rule-memberships']],
    ).toBeUndefined();
  });

  it('stores canonical partial rows and ordinary views without inventing collection membership', async () => {
    const f = await fixture(),
      result = await f.run({ owner: person() }),
      id = f.owner(result),
      row = f.resources.get(id)!;
    const p = f.context.schema.properties,
      table = f.resources.get(row[p['syncable-entity-table']] as string)!;
    expect(row[core.properties.isA]).toContain(
      f.context.schema.classes['syncable-reference'],
    );
    expect(row[core.properties.isA]).not.toContain(
      f.context.apiSchema.classes.person,
    );
    expect(row[f.context.apiSchema.properties.name]).toBe('API Person');
    expect(configOf(f, id)).toMatchObject({
      version: 3,
      record: person(),
      context: { workspace_id: 9 },
    });
    expect(configOf(f, id).read).toBeUndefined();
    expect(row[p['syncable-navigation-intents']]).toMatchObject([
      {
        version: 1,
        resource: 'ticket',
        definition: {
          source: {
            kind: 'related',
            origin: { record: person(), context: { workspace_id: 9 } },
            via: { collection: 'personTickets', kind: 'identity' },
          },
        },
      },
    ]);
    expect(JSON.stringify(row[p['syncable-navigation-intents']])).not.toContain(
      '"read":',
    );
    expect(row[p['syncable-rule-memberships']]).toBeUndefined();
    const viewSubjects = table[dataBrowser.properties.tableViews] as string[];
    expect(
      viewSubjects.map(subject => {
        const view = f.resources.get(subject)!;

        return [
          view[core.properties.name],
          view[dataBrowser.properties.viewKind],
        ];
      }),
    ).toEqual([
      ['Table', 'table'],
      ['Sync', 'syncables'],
    ]);
    expect(table[dataBrowser.properties.tableDefaultView]).toBe(
      viewSubjects[0],
    );
    expect(
      f.queries.every(
        query => query.drive === f.context.drive && query.includeTrashed,
      ),
    ).toBe(true);
    expect(f.owner(await f.run({ owner: person() }))).toBe(id);
  });

  it('preserves retained table, view identities and settings while enriching a reference', async () => {
    const f = await fixture();
    const id = f.owner(await f.run({ owner: person() }));
    const p = f.context.schema.properties;
    const tableId = f.resources.get(id)![p['syncable-entity-table']] as string;
    const table = f.resources.get(tableId)!;
    const legacyView = 'atomic:retained-collection-view';
    f.resources.set(legacyView, {
      [core.properties.parent]: tableId,
      [core.properties.isA]: [dataBrowser.classes.view],
      [core.properties.name]: 'My saved collection',
      [dataBrowser.properties.viewKind]: 'syncable-collection',
      'atomic:saved-settings': { columns: ['name'], sort: 'descending' },
    });
    table[dataBrowser.properties.tableViews] = [
      legacyView,
      ...(table[dataBrowser.properties.tableViews] as string[]),
    ];
    table[dataBrowser.properties.tableDefaultView] = legacyView;
    const viewSubjects = table[dataBrowser.properties.tableViews] as string[];
    const before = structuredClone([
      table,
      ...viewSubjects.map(subject => f.resources.get(subject)!),
    ]);
    const count = f.resources.size;
    f.writes.length = 0;

    expect(
      f.owner(await f.run({ owner: person({ email: 'added@example.test' }) })),
    ).toBe(id);
    expect([
      table,
      ...viewSubjects.map(subject => f.resources.get(subject)!),
    ]).toEqual(before);
    expect(f.resources.size).toBe(count);
    expect(
      f.writes.some(
        subject => subject === tableId || viewSubjects.includes(subject),
      ),
    ).toBe(false);
  });

  it('prefers usable human text over earlier URI/date columns and preserves an existing custom name', async () => {
    const f = await fixture();
    const portrait = 'https://images.example/portrait/7';
    const id = f.owner(
      await f.run({
        owner: person({ portrait, published: '2026-11-20T12:00:00Z' }),
      }),
    );
    const row = await f.wrap(id);
    expect(row.get(core.properties.name)).toBe('API Person');
    await row.set(core.properties.name, 'My custom name');
    await f.run({
      owner: person({
        portrait: 'https://images.example/new',
        name: 'Updated provider label',
      }),
    });
    expect(row.get(core.properties.name)).toBe('My custom name');
  });

  it('skips blank labels and falls back to another supplied string or the canonical path', async () => {
    const f = await fixture();
    const email = f.owner(
      await f.run({
        owner: person({
          id: 8,
          portrait: 'https://images.example/8',
          name: '  ',
          email: 'contact@example.test',
        }),
      }),
    );
    expect(f.resources.get(email)![core.properties.name]).toBe(
      'contact@example.test',
    );
    const url = f.owner(
      await f.run({
        owner: person({
          id: 9,
          portrait: 'https://images.example/9',
          name: '',
        }),
      }),
    );
    expect(f.resources.get(url)![core.properties.name]).toBe(
      'https://images.example/9',
    );
    const path = f.owner(
      await f.run({ owner: { kind: 'Person', id: 10, name: '  ' } }),
    );
    expect(f.resources.get(path)![core.properties.name]).toBe(
      '/workspaces/9/people/10',
    );
  });

  it('retains typed and composite identities and ordered array duplicates', async () => {
    const f = await fixture();
    const numeric = f.owner(await f.run({ owner: person() }));
    const text = f.owner(await f.run({ owner: person({ id: '7' }) }));
    const otherWorkspace = f.owner(await f.run({ owner: person() }, 10));
    expect(new Set([numeric, text, otherWorkspace]).size).toBe(3);
    const result = await f.run({
      reviewers: [person(), person({ id: '7' }), person()],
    });
    expect(result.find(field => field.field === 'reviewers')!.subjects).toEqual(
      [numeric, text, numeric],
    );
  });

  it('stores discriminator-selected targets and applies the full class only with real required values', async () => {
    const f = await fixture();
    const id = f.owner(
      await f.run({ owner: { kind: 'Team', id: 7, name: 'Real team' } }),
    );
    expect(f.resources.get(id)![core.properties.isA]).toContain(
      f.context.apiSchema.classes.team,
    );
    expect(configOf(f, id).resource).toBe('team');
  });

  it('does no allocation for absent, null, empty or wholly unresolved arrays', async () => {
    const f = await fixture();

    for (const raw of [
      {},
      { owner: null },
      { reviewers: [] },
      { reviewers: [person(), { name: 'No identity' }] },
    ]) {
      const result = await f.run(raw);
      expect(result.every(field => field.subjects.length === 0)).toBe(true);
    }

    expect(f.writes).toEqual([]);
    expect(f.queries).toEqual([]);
  });

  it('retains minimal declared evidence for scalar targets without inventing an object', async () => {
    const f = await fixture();
    const result = await f.run({
      sponsorId: 7,
      workspaceId: 9,
      secret: 'private body',
    });
    const id = result.find(field => field.field === 'sponsorId')!.subjects[0];
    const row = f.resources.get(id)!,
      p = f.context.schema.properties;
    expect(configOf(f, id).record).toEqual({});
    expect(row[f.context.apiSchema.properties.id]).toBeUndefined();
    const evidence = row[p['syncable-reference-evidence']];
    expect(JSON.stringify(evidence)).not.toContain('private body');
    expect(
      validateSyncableReferenceEvidence(
        f.context.document,
        evidence,
        configOf(f, id).entityIdentity as EntityIdentity,
      ),
    ).toBe(true);
    expect(
      validateSyncableReferenceEvidence(
        f.context.document,
        { ...(evidence as object), field: 'secret' },
        configOf(f, id).entityIdentity as EntityIdentity,
      ),
    ).toBe(false);
    expect(
      (await f.run({ sponsorId: 7, workspaceId: 9 })).find(
        field => field.field === 'sponsorId',
      )!.subjects,
    ).toEqual([id]);
  });

  it('fills absent embedded fields while retaining richer evidence and user edits', async () => {
    const f = await fixture(),
      id = f.owner(await f.run({ owner: person() }));
    const row = await f.wrap(id),
      property = f.context.apiSchema.properties;
    await row.set(property.name, 'My name');
    await row.set('atomic:note', 'My note');
    expect(
      f.owner(
        await f.run({
          owner: person({ name: 'New API name', email: 'real@example.test' }),
        }),
      ),
    ).toBe(id);
    expect(row.get(property.name)).toBe('My name');
    expect(row.get('atomic:note')).toBe('My note');
    expect(row.get(property.email)).toBe('real@example.test');
    expect(configOf(f, id).record).toMatchObject({
      name: 'API Person',
      email: 'real@example.test',
    });
    expect(row.get(core.properties.isA)).toContain(
      f.context.apiSchema.classes.person,
    );
  });

  it('does not use user-filled API fields or missing custom-required values as full API evidence', async () => {
    const f = await fixture(),
      id = f.owner(await f.run({ owner: person() }));
    const row = await f.wrap(id);
    await row.set(f.context.apiSchema.properties.email, 'user@example.test');
    await f.run({ owner: person() });
    expect(row.get(core.properties.isA)).not.toContain(
      f.context.apiSchema.classes.person,
    );
    const klass = f.resources.get(f.context.apiSchema.classes.person)!;
    klass[core.properties.requires] = [
      ...(klass[core.properties.requires] as string[]),
      'atomic:required-note',
    ];
    await f.run({ owner: person({ email: 'real@example.test' }) });
    expect(row.get(core.properties.isA)).not.toContain(
      f.context.apiSchema.classes.person,
    );
  });

  it('reuses a moved retained target without reparenting or updating user data', async () => {
    const f = await fixture(),
      id = f.owner(await f.run({ owner: person() }));
    f.resources.set('atomic:folder', {
      [core.properties.parent]: f.context.drive,
    });
    await (await f.wrap(id)).set(core.properties.parent, 'atomic:folder');
    const before = structuredClone(f.resources.get(id));
    f.writes.length = 0;
    expect(
      f.owner(await f.run({ owner: person({ email: 'new@example.test' }) })),
    ).toBe(id);
    expect(f.resources.get(id)).toEqual(before);
    expect(f.writes).toEqual([]);
  });

  it.each(['trash', 'ambiguous', 'unprovable'] as const)(
    'rejects retained %s identities before allocating replacements',
    async mode => {
      const f = await fixture(),
        id = f.owner(await f.run({ owner: person() }));

      if (mode === 'trash') {
        f.resources.set('atomic:trash', {
          [core.properties.parent]: f.context.drive,
        });
        f.resources.get(f.context.drive)![dataBrowser.properties.trashFolder] =
          'atomic:trash';
        f.resources.get(id)![core.properties.parent] = 'atomic:trash';
      } else if (mode === 'ambiguous')
        f.resources.set(
          'atomic:duplicate',
          structuredClone(f.resources.get(id)!),
        );
      else {
        f.resources.get(id)![core.properties.parent] = 'atomic:missing';
        f.actor.unscoped = true;
      }

      f.writes.length = 0;
      const count = f.resources.size;
      await expect(
        f.run({ owner: person({ email: 'x@example.test' }) }),
      ).rejects.toThrow();
      expect(f.resources.size).toBe(count);
      expect(f.writes).toEqual([]);
    },
  );

  it('pins actual Drive ancestry while ignoring proven foreign matches and a different UI Drive', async () => {
    const f = await fixture(),
      id = f.owner(await f.run({ owner: person() }));
    f.resources.set('atomic:other-drive', {
      [core.properties.isA]: [server.classes.drive],
    });
    f.resources.set('atomic:foreign', {
      ...structuredClone(f.resources.get(id)!),
      [core.properties.parent]: 'atomic:other-drive',
    });
    f.actor.unscoped = true;
    f.actor.selected = 'atomic:other-drive';
    expect(
      f.owner(await f.run({ owner: person({ email: 'real@example.test' }) })),
    ).toBe(id);
    expect(
      f.resources.get('atomic:foreign')![f.context.apiSchema.properties.email],
    ).toBeUndefined();
  });

  it('rejects historical targets and external query subjects before native allocation or fetch', async () => {
    const f = await fixture();
    const p = f.context.schema.properties;
    const legacy = sourceKey({
      ...f.context,
      kind: 'record',
      collection: { resource: 'person', collection: 'old-people' },
      remoteId: 7,
    });
    f.resources.set('atomic:legacy-person', {
      [core.properties.parent]: f.context.drive,
      [p['syncable-source-key']]: legacy,
    });
    const count = f.resources.size;
    await expect(f.run({ owner: person() })).rejects.toThrow(/historical/);
    expect(f.resources.size).toBe(count);
    expect(f.writes).toEqual([]);
    f.resources.delete('atomic:legacy-person');
    const external = 'https://foreign.example/identity';
    f.resources.set(external, {
      [core.properties.parent]: f.context.drive,
      [p['syncable-source-key']]: legacy,
    });
    const original = f.store.getResource.bind(f.store);
    const fetched: string[] = [];

    f.store.getResource = async subject => {
      fetched.push(subject);

      return original(subject);
    };

    await expect(f.run({ owner: person() })).rejects.toThrow(/another server/);
    expect(fetched).not.toContain(external);
    expect(f.writes).toEqual([]);
  });

  it('requires raw required relationship evidence even when Atomic class requirements omit that link', async () => {
    const f = await fixture();
    f.context.apiSchema.requiredFields = {
      ...f.context.apiSchema.requiredFields,
      person: ['id', 'name', 'email', 'owner'],
    };
    const id = f.owner(
      await f.run({ owner: person({ email: 'real@example.test' }) }),
    );
    expect(f.resources.get(id)![core.properties.isA]).not.toContain(
      f.context.apiSchema.classes.person,
    );
  });

  it('keeps prior supplied raw details while filling absent nested evidence', async () => {
    const f = await fixture();
    const id = f.owner(
      await f.run({
        owner: person({ details: { old: 'kept', nested: { first: 1 } } }),
      }),
    );
    await f.run({
      owner: person({ details: { old: 'new', nested: { second: 2 } } }),
    });
    expect(configOf(f, id).record).toMatchObject({
      details: { old: 'kept', nested: { first: 1, second: 2 } },
    });
  });

  it.each([
    ['at acknowledgement', 'atomic:agent:me', ['atomic:agent:me']],
    ['after the next publication', 'atomic:agent:me', ['atomic:agent:me']],
    ['at acknowledgement', 'did:ad:agent:me', ['atomic:agent:me']],
    ['after the next publication', 'did:ad:agent:me', ['atomic:agent:me']],
    [
      'at acknowledgement',
      'did:ad:agent:me',
      ['did:ad:agent:me', 'atomic:agent:me'],
    ],
    [
      'after the next publication',
      'did:ad:agent:me',
      ['did:ad:agent:me', 'atomic:agent:me'],
    ],
  ] as const)(
    'preserves the native genesis writer %s for %s with writers %j',
    async (timing, actorSubject, storedWriters) => {
      const f = await fixture();
      f.actor.subject = actorSubject;
      const published = new Set<string>();
      let delayed: string | undefined;

      const publish = (subject: string) => {
        if (published.has(subject)) return;
        const row = f.resources.get(subject)!;
        expect(row[core.properties.write]).toEqual([actorSubject]);
        // The delayed publication can contain canonical subjects alongside
        // the original signer spelling.
        row[core.properties.write] = [...storedWriters];
        published.add(subject);
      };

      f.actor.afterSave = subject => {
        if (timing === 'at acknowledgement') publish(subject);
        else {
          if (delayed) publish(delayed);
          delayed = subject;
        }
      };

      const id = f.owner(await f.run({ owner: person() }));
      if (delayed) publish(delayed);
      const p = f.context.schema.properties;
      const tableId = f.resources.get(id)![
        p['syncable-entity-table']
      ] as string;
      const table = f.resources.get(tableId)!;

      for (const subject of [
        id,
        tableId,
        ...(table[dataBrowser.properties.tableViews] as string[]),
      ]) {
        expect(f.resources.get(subject)![core.properties.write]).toEqual(
          storedWriters,
        );
        expect(published.has(subject)).toBe(true);
      }

      const row = f.resources.get(id)!;
      row[core.properties.write] = [
        f.actor.subject,
        'atomic:existing-collaborator',
      ];
      await f.run({ owner: person({ email: 'new@example.test' }) });
      expect(f.resources.get(id)![core.properties.write]).toEqual([
        f.actor.subject,
        'atomic:existing-collaborator',
      ]);
    },
  );

  it('allows the same retained writers to arrive in a different order', async () => {
    const f = await fixture();
    const id = f.owner(await f.run({ owner: person() }));
    const row = f.resources.get(id)!;
    const collaborator = 'atomic:agent:existing-collaborator';
    row[core.properties.write] = [f.actor.subject, collaborator];

    f.actor.beforeSet = () => {
      row[core.properties.write] = [collaborator, f.actor.subject];
    };

    expect(
      f.owner(await f.run({ owner: person({ email: 'new@example.test' }) })),
    ).toBe(id);
    expect(row[core.properties.write]).toEqual([collaborator, f.actor.subject]);
  });

  it('rejects a writer being removed from a retained reference during an update', async () => {
    const f = await fixture();
    const id = f.owner(await f.run({ owner: person() }));
    const row = f.resources.get(id)!;
    row[core.properties.write] = [
      f.actor.subject,
      'atomic:agent:existing-collaborator',
    ];

    f.actor.beforeSet = () => {
      row[core.properties.write] = [f.actor.subject];
    };

    f.writes.length = 0;
    await expect(
      f.run({ owner: person({ email: 'new@example.test' }) }),
    ).rejects.toThrow(`${id}; ${core.properties.write}`);
    expect(f.writes).toEqual([]);
  });

  it('still rejects an unexpected writer added while publishing a new native reference', async () => {
    const f = await fixture();

    f.actor.afterSave = subject => {
      f.resources.get(subject)![core.properties.write] = [
        f.actor.subject,
        'atomic:unexpected-writer',
      ];
    };

    await expect(f.run({ owner: person() })).rejects.toThrow(
      /https:\/\/atomicdata.dev\/properties\/write/,
    );
    expect(
      [...f.resources.values()].filter(
        values =>
          values[f.context.schema.properties['syncable-node-kind']] ===
          'record',
      ),
    ).toHaveLength(0);
  });

  it('permits ordinary server commit metadata but rejects an edit or move at the guarded mutation boundary', async () => {
    const f = await fixture();

    f.actor.afterSave = subject => {
      const values = f.resources.get(subject)!;
      values['https://atomicdata.dev/properties/createdAt'] = 123;
      values['https://atomicdata.dev/properties/createdBy'] = f.actor.subject;
      values['https://atomicdata.dev/properties/lastCommit'] =
        'atomic:server-commit';
    };

    const id = f.owner(await f.run({ owner: person() }));
    expect(
      f.resources.get(id)!['https://atomicdata.dev/properties/createdAt'],
    ).toBe(123);

    for (const property of [core.properties.name, core.properties.parent]) {
      const original = f.resources.get(id)![property];

      f.actor.beforeSet = () => {
        f.resources.get(id)![property] = 'atomic:concurrent-change';
      };

      f.writes.length = 0;
      await expect(
        f.run({ owner: person({ email: 'more@example.test' }) }),
      ).rejects.toThrow(`${id}; ${property}`);
      expect(f.writes).toEqual([]);
      f.resources.get(id)![property] = original;
      f.actor.beforeSet = undefined;
    }
  });

  it('rejects forged observations, missing rights and a session change at the mutation boundary', async () => {
    const f = await fixture(),
      observation = f.observe({ owner: person() });
    observation.entity = { ...observation.entity, key: 'forged' };
    await expect(
      materializeSyncableReferences(
        f.store as unknown as Store,
        f.context,
        [observation],
        () => {},
      ),
    ).rejects.toThrow(/identity/);
    expect(f.writes).toEqual([]);
    f.actor.denied.add(f.context.principalApp);
    await expect(f.run({ owner: person() })).rejects.toThrow(/Write access/);
    expect(f.writes).toEqual([]);
    f.actor.denied.clear();

    f.actor.beforeSet = () => {
      f.actor.subject = 'atomic:other-agent';
    };

    await expect(f.run({ owner: person() })).rejects.toThrow(/changed/);
    expect(f.writes).toEqual([]);
  });
});
