import { describe, it, vi } from 'vitest';

import { Agent } from './agent.js';
import type { Commit } from './commit.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import {
  canonicalizeSchemaPackage,
  defineSchema,
  freezeSchema,
  hashSchemaPackage,
  SCHEMA_HASH_PROPERTY,
  schemaToOntologyModel,
  type AtomicSchemaPackage,
} from './schema.js';
import { Datatype } from './datatypes.js';
import { core } from './ontologies/core.js';
import { getKnownNameBySubject } from './ontology.js';
import { Store } from './store.js';

interface MockClientDbEntry {
  json: string;
  snapshot?: Uint8Array;
}

function attachMockClientDb(
  store: Store,
  dbState = new Map<string, MockClientDbEntry>(),
): Map<string, MockClientDbEntry> {
  store.setClientDb({
    isReady: true,
    isInitialized: true,
    initError: undefined,
    putResourceWithSnapshot: vi.fn(
      async (subject: string, json: string, snapshot?: Uint8Array) => {
        dbState.set(subject, { json, snapshot });
      },
    ),
    getResource: async (subject: string) => dbState.get(subject)?.json ?? null,
    getResourceWithSnapshot: async (subject: string) => {
      const entry = dbState.get(subject);

      return { jsonAd: entry?.json ?? null, snapshot: entry?.snapshot };
    },
    getLoroSnapshot: async (subject: string) => dbState.get(subject)?.snapshot,
    waitForInit: async () => true,
    waitForReady: async () => true,
  } as unknown as Parameters<Store['setClientDb']>[0]);

  return dbState;
}

const todoSchema: AtomicSchemaPackage = {
  name: 'TodoApp',
  version: '1.0.0',
  classes: {
    todo: {
      title: 'Todo',
      description: 'A task',
      type: 'object',
      required: ['title'],
      properties: {
        title: {
          type: 'string',
          description: 'Task title',
        },
        done: {
          type: 'boolean',
          default: false,
        },
      },
    },
  },
};

describe('schema package hashing', () => {
  it('hashes equivalent schemas the same regardless of object key order', ({
    expect,
  }) => {
    const differentlyOrdered: AtomicSchemaPackage = {
      classes: {
        todo: {
          properties: {
            done: {
              default: false,
              type: 'boolean',
            },
            title: {
              description: 'Task title',
              type: 'string',
            },
          },
          required: ['title'],
          type: 'object',
          description: 'A task',
          title: 'Todo',
        },
      },
      version: '1.0.0',
      name: 'TodoApp',
    };

    expect(hashSchemaPackage(differentlyOrdered)).toBe(
      hashSchemaPackage(todoSchema),
    );
  });

  it('changes the hash when a property datatype changes', ({ expect }) => {
    const changed: AtomicSchemaPackage = {
      ...todoSchema,
      classes: {
        todo: {
          ...todoSchema.classes.todo,
          properties: {
            ...todoSchema.classes.todo.properties,
            title: {
              type: 'integer',
              description: 'Task title',
            },
          },
        },
      },
    };

    expect(hashSchemaPackage(changed)).not.toBe(hashSchemaPackage(todoSchema));
  });

  it('normalizes away undefined fields before canonicalization', ({
    expect,
  }) => {
    const withUndefined = {
      ...todoSchema,
      description: undefined,
    } as AtomicSchemaPackage;

    expect(canonicalizeSchemaPackage(withUndefined)).toBe(
      canonicalizeSchemaPackage(todoSchema),
    );
  });

  it('rejects non-finite numbers', ({ expect }) => {
    const invalid = {
      ...todoSchema,
      classes: {
        todo: {
          ...todoSchema.classes.todo,
          properties: {
            ratio: {
              type: 'number',
              default: Number.NaN,
            },
          },
        },
      },
    } as AtomicSchemaPackage;

    expect(() => hashSchemaPackage(invalid)).toThrow('non-finite number');
  });
});

describe('defineSchema', () => {
  it('returns the original schema, normalized schema, and schema hash', ({
    expect,
  }) => {
    const defined = defineSchema(todoSchema);

    expect(defined.schema).toBe(todoSchema);
    expect(defined.normalized).toEqual(todoSchema);
    expect(defined.schemaHash).toMatch(/^blake3:[0-9a-f]{64}$/);
  });

  it('supports pinned external ontology imports', ({ expect }) => {
    const external = defineSchema({
      name: 'ProjectApp',
      imports: {
        todo: {
          subject: 'did:ad:todoOntology',
          expectedHash: defineSchema(todoSchema).schemaHash,
        },
      },
      classes: {
        project: {
          type: 'object',
          properties: {
            title: {
              $ref: 'todo.properties.title',
            },
          },
        },
      },
    });

    expect(external.normalized.imports?.todo.subject).toBe(
      'did:ad:todoOntology',
    );
    expect(external.normalized.imports?.todo.expectedHash).toMatch(
      /^blake3:[0-9a-f]{64}$/,
    );
  });

  it('exposes content-addressed frozen ids as typed class/property handles', ({
    expect,
  }) => {
    // Inline literal (not annotated) so the generic captures the literal keys —
    // `.classes.todo` / `.properties.title` are typed, autocompleted handles.
    const defined = defineSchema({
      name: 'TodoApp',
      version: '1.0.0',
      classes: {
        todo: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            done: { type: 'boolean' },
          },
        },
      },
    });

    expect(defined.classes.todo).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);
    expect(defined.properties.title).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);
    expect(defined.properties.done).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);

    // The handles are exactly the frozen ids, addressable with no server.
    const frozen = freezeSchema(defined);
    expect(defined.classes.todo).toBe(frozen.classes.todo);
    expect(defined.properties.title).toBe(frozen.properties['todo.title']);
  });

  it('computes handles deterministically and locally (no server)', ({
    expect,
  }) => {
    const a = defineSchema(todoSchema).classes.todo;
    const b = defineSchema(todoSchema).classes.todo;

    expect(a).toBe(b);
  });

  it('registers the schema at runtime so props resolve by shortname', ({
    expect,
  }) => {
    const defined = defineSchema(todoSchema);
    // Accessing a handle triggers lazy freeze + runtime registration.
    const titleId = defined.properties.title;

    expect(getKnownNameBySubject(titleId)).toBe('title');
  });

  it('does not freeze on definition, and throws on handle access for imports', ({
    expect,
  }) => {
    // Defining an import-containing schema must not throw (no eager freeze)...
    const external = defineSchema({
      name: 'ProjectApp',
      imports: {
        todo: {
          subject: 'did:ad:todoOntology',
          expectedHash: defineSchema(todoSchema).schemaHash,
        },
      },
      classes: {
        project: {
          type: 'object',
          properties: { title: { $ref: 'todo.properties.title' } },
        },
      },
    });

    // ...but reaching for a local handle (which needs a store) throws clearly.
    expect(() => external.classes.project).toThrow(/store-backed registration/);
  });
});

describe('schemaToOntologyModel', () => {
  it('converts schema classes and properties to Atomic ontology model entries', ({
    expect,
  }) => {
    const model = schemaToOntologyModel(todoSchema);

    expect(model.ontology.shortname).toBe('TodoApp');
    expect(model.ontology.schemaHash).toMatch(/^blake3:[0-9a-f]{64}$/);
    expect(model.classes).toEqual([
      {
        key: 'todo',
        subject: undefined,
        shortname: 'todo',
        description: 'A task',
        requires: ['todo.title'],
        recommends: ['todo.done'],
      },
    ]);
    expect(
      model.properties.toSorted((a, b) =>
        a.propertyKey.localeCompare(b.propertyKey),
      ),
    ).toMatchObject([
      {
        key: 'todo.done',
        classKey: 'todo',
        propertyKey: 'done',
        shortname: 'done',
        description: 'done',
        datatype: Datatype.BOOLEAN,
      },
      {
        key: 'todo.title',
        classKey: 'todo',
        propertyKey: 'title',
        shortname: 'title',
        description: 'Task title',
        datatype: Datatype.STRING,
      },
    ]);
  });

  it('maps common JSON Schema datatypes to Atomic datatypes', ({ expect }) => {
    const model = schemaToOntologyModel({
      name: 'Types',
      classes: {
        item: {
          type: 'object',
          properties: {
            dueAt: { type: 'string', format: 'date' },
            url: { type: 'string', format: 'uri' },
            count: { type: 'integer' },
            price: { type: 'number' },
            payload: { type: 'object' },
            tags: { type: 'array', items: { type: 'string' } },
            owner: { $ref: '#/$defs/Agent' },
            files: { type: 'array', items: { $ref: '#/$defs/File' } },
          },
        },
      },
    });

    expect(
      Object.fromEntries(
        model.properties.map(prop => [prop.propertyKey, prop.datatype]),
      ),
    ).toEqual({
      dueAt: Datatype.DATE,
      url: Datatype.URI,
      count: Datatype.INTEGER,
      price: Datatype.FLOAT,
      payload: Datatype.JSON,
      tags: Datatype.JSON,
      owner: Datatype.ATOMIC_URL,
      files: Datatype.RESOURCEARRAY,
    });
  });

  it('keeps atomic extension metadata for generated properties and classes', ({
    expect,
  }) => {
    const model = schemaToOntologyModel({
      name: 'People',
      classes: {
        person: {
          type: 'object',
          'atomic:subject': 'did:ad:personClass',
          'atomic:shortname': 'person',
          required: ['friend'],
          properties: {
            friend: {
              type: 'string',
              'atomic:subject': 'did:ad:friendProperty',
              'atomic:datatype': Datatype.ATOMIC_URL,
              'atomic:classType': 'did:ad:personClass',
              'atomic:isLocked': true,
            },
          },
        },
      },
    });

    expect(model.classes[0].subject).toBe('did:ad:personClass');
    expect(model.properties[0]).toMatchObject({
      subject: 'did:ad:friendProperty',
      datatype: Datatype.ATOMIC_URL,
      classType: 'did:ad:personClass',
      isLocked: true,
    });
  });
});

describe('freezeSchema', () => {
  it('produces did:ad:frozen ids for the ontology, classes, and properties', ({
    expect,
  }) => {
    const frozen = freezeSchema(todoSchema);

    expect(frozen.ontology).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);
    expect(frozen.classes.todo).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);
    expect(frozen.properties['todo.title']).toMatch(
      /^did:ad:frozen:[0-9a-f]{64}$/,
    );
    expect(frozen.properties['todo.done']).toMatch(
      /^did:ad:frozen:[0-9a-f]{64}$/,
    );
  });

  it('rewrites class requires to the frozen property id', ({ expect }) => {
    const frozen = freezeSchema(todoSchema);
    const todoClass = frozen.resources.find(
      resource => resource.frozenId === frozen.classes.todo,
    )!;

    expect(
      (todoClass.content as Record<string, unknown>)[core.properties.requires],
    ).toEqual([frozen.properties['todo.title']]);
  });

  it('rewrites ontology members to frozen ids and keeps the schema hash', ({
    expect,
  }) => {
    const frozen = freezeSchema(todoSchema);
    const ontology = frozen.resources.find(
      resource => resource.frozenId === frozen.ontology,
    )!;
    const content = ontology.content as Record<string, unknown>;

    expect(content[core.properties.classes]).toEqual([frozen.classes.todo]);
    expect(content[core.properties.properties]).toEqual(
      expect.arrayContaining([
        frozen.properties['todo.title'],
        frozen.properties['todo.done'],
      ]),
    );
    // Presentation (schemaHash, descriptions) is NOT part of frozen identity.
    expect(content[SCHEMA_HASH_PROPERTY]).toBeUndefined();
    expect(content[core.properties.description]).toBeUndefined();
    expect(frozen.presentation.ontology.schemaHash).toBe(
      frozen.model.ontology.schemaHash,
    );
  });

  it('is deterministic and content-addressed across runs', ({ expect }) => {
    expect(freezeSchema(todoSchema).properties['todo.title']).toBe(
      freezeSchema(defineSchema(todoSchema)).properties['todo.title'],
    );
  });

  it('keeps the property id stable when only its description changes', ({
    expect,
  }) => {
    const base = freezeSchema(todoSchema).properties['todo.title'];
    const reworded = freezeSchema({
      ...todoSchema,
      classes: {
        todo: {
          ...todoSchema.classes.todo,
          properties: {
            ...todoSchema.classes.todo.properties,
            title: { type: 'string', description: 'A different title' },
          },
        },
      },
    });

    // Description is presentation, not identity — the id must not move...
    expect(reworded.properties['todo.title']).toBe(base);
    // ...but the new wording is captured in the presentation layer.
    expect(reworded.presentation.properties['todo.title'].description).toBe(
      'A different title',
    );
  });

  it('changes the property id when its datatype changes', ({ expect }) => {
    const base = freezeSchema(todoSchema).properties['todo.title'];
    const changed = freezeSchema({
      ...todoSchema,
      classes: {
        todo: {
          ...todoSchema.classes.todo,
          properties: {
            ...todoSchema.classes.todo.properties,
            title: { type: 'integer', description: 'Task title' },
          },
        },
      },
    });

    expect(changed.properties['todo.title']).not.toBe(base);
  });

  it('keeps a class id stable when a property description changes', ({
    expect,
  }) => {
    const base = freezeSchema(todoSchema).classes.todo;
    const reworded = freezeSchema({
      ...todoSchema,
      classes: {
        todo: {
          ...todoSchema.classes.todo,
          properties: {
            ...todoSchema.classes.todo.properties,
            title: { type: 'string', description: 'Reworded' },
          },
        },
      },
    });

    // No cascade: a cosmetic edit deep in the tree moves nothing.
    expect(reworded.classes.todo).toBe(base);
    expect(reworded.ontology).toBe(freezeSchema(todoSchema).ontology);
  });

  it('allows the same shortname across classes when definitions are identical', ({
    expect,
  }) => {
    const frozen = freezeSchema({
      name: 'Notes',
      classes: {
        note: {
          type: 'object',
          properties: { title: { type: 'string', description: 'Title' } },
        },
        memo: {
          type: 'object',
          properties: { title: { type: 'string', description: 'Title' } },
        },
      },
    });

    // Identical "title" definitions dedupe to a single frozen id.
    expect(frozen.properties['note.title']).toBe(frozen.properties['memo.title']);
  });

  it('rejects different definitions that share a shortname', ({ expect }) => {
    expect(() =>
      freezeSchema({
        name: 'Notes',
        classes: {
          note: {
            type: 'object',
            properties: { title: { type: 'string', description: 'A' } },
          },
          memo: {
            type: 'object',
            properties: { title: { type: 'integer', description: 'B' } },
          },
        },
      }),
    ).toThrow('shortname "title"');
  });

  it('throws on imported property references it cannot resolve', ({
    expect,
  }) => {
    expect(() =>
      freezeSchema({
        name: 'ProjectApp',
        imports: {
          todo: { subject: 'did:ad:todoOntology' },
        },
        classes: {
          project: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { $ref: 'todo.properties.title' },
            },
          },
        },
      }),
    ).toThrow('Imported properties require store-backed registration');
  });
});

describe('Store.registerSchema', () => {
  it('creates local DID ontology, class, and property resources that resolve', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );

    const registered = await store.registerSchema(defineSchema(todoSchema));
    const titleProperty = registered.properties['todo.title'];
    const todoClass = registered.classes.todo;

    expect(registered.ontology.subject).toMatch(/^did:ad:/);
    expect(titleProperty.subject).toMatch(/^did:ad:/);
    expect(todoClass.subject).toMatch(/^did:ad:/);
    expect(registered.ontology.props.classes).toEqual([todoClass.subject]);
    expect(registered.ontology.props.properties).toEqual(
      expect.arrayContaining([
        titleProperty.subject,
        registered.properties['todo.done'].subject,
      ]),
    );
    expect(todoClass.props.requires).toEqual([titleProperty.subject]);

    const resolvedProperty = await store.getProperty(titleProperty.subject);

    expect(resolvedProperty.shortname).toBe('title');
    expect(resolvedProperty.datatype).toBe(Datatype.STRING);
    expect(
      store.getRegisteredSchemaSubject(registered.model.ontology.schemaHash),
    ).toBe(registered.ontology.subject);
    expect(registered.ontology.hasClasses(core.classes.ontology)).toBe(true);
  });

  it('can save registered schemas through the normal commit path', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(true);
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );
    const posted: Commit[] = [];
    const postCommit = vi.fn(async (commit: Commit) => {
      const created = {
        ...commit,
        id: `https://example.com/commits/${commit.signature}`,
      } as Commit;
      posted.push(created);

      return created;
    });
    (
      store as unknown as { client: { postCommit: typeof postCommit } }
    ).client.postCommit = postCommit;

    const registered = await store.registerSchema(defineSchema(todoSchema), {
      save: true,
    });

    expect(postCommit).toHaveBeenCalled();
    expect(posted.map(commit => commit.subject)).toEqual(
      expect.arrayContaining([
        registered.ontology.subject,
        registered.classes.todo.subject,
        registered.properties['todo.title'].subject,
        registered.properties['todo.done'].subject,
      ]),
    );
  });

  it('reloads saved schema resources from the local DB in a fresh Store', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const agent = new Agent(
      new JSCryptoProvider(keys.privateKey),
      `did:ad:agent:${keys.publicKey}`,
    );
    const producer = new Store({ serverUrl: 'https://example.com', agent });
    producer.setServerConnected(false);
    const dbState = attachMockClientDb(producer);

    const registered = await producer.registerSchema(defineSchema(todoSchema), {
      save: true,
    });
    const ontologySubject = registered.ontology.subject;
    const classSubject = registered.classes.todo.subject;
    const titlePropertySubject = registered.properties['todo.title'].subject;

    expect(dbState.has(ontologySubject)).toBe(true);
    expect(dbState.has(classSubject)).toBe(true);
    expect(dbState.has(titlePropertySubject)).toBe(true);

    const consumer = new Store({ serverUrl: 'https://example.com', agent });
    consumer.setServerConnected(false);
    attachMockClientDb(consumer, dbState);

    const ontology = await consumer.getResource(ontologySubject);
    expect(ontology.get(SCHEMA_HASH_PROPERTY)).toBe(
      registered.model.ontology.schemaHash,
    );
    expect(ontology.props.classes).toEqual([classSubject]);
    expect(ontology.props.properties).toEqual(
      expect.arrayContaining([titlePropertySubject]),
    );

    const todoClass = await consumer.getResource(classSubject);
    expect(todoClass.props.requires).toEqual([titlePropertySubject]);

    const titleProperty = await consumer.getProperty(titlePropertySubject);
    expect(titleProperty.shortname).toBe('title');
    expect(titleProperty.datatype).toBe(Datatype.STRING);
  });

  it('checks expected hashes for imported ontologies', async ({ expect }) => {
    const keys = await Agent.generateKeyPair();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );

    const todo = await store.registerSchema(defineSchema(todoSchema));
    const projectSchema = defineSchema({
      name: 'ProjectApp',
      imports: {
        todo: {
          subject: todo.ontology.subject,
          expectedHash: todo.model.ontology.schemaHash,
        },
      },
      classes: {
        project: {
          type: 'object',
          properties: {
            title: { type: 'string' },
          },
        },
      },
    });

    await expect(store.registerSchema(projectSchema)).resolves.toMatchObject({
      ontology: expect.objectContaining({ subject: expect.any(String) }),
    });

    const mismatched = defineSchema({
      ...projectSchema.schema,
      imports: {
        todo: {
          subject: todo.ontology.subject,
          expectedHash:
            'blake3:0000000000000000000000000000000000000000000000000000000000000000',
        },
      },
    });

    await expect(store.registerSchema(mismatched)).rejects.toThrow(
      'Schema import todo expected',
    );
  });

  it('can create an instance using returned schema subjects', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );
    const registered = await store.registerSchema(defineSchema(todoSchema));
    const resource = await store.newResource({
      isA: registered.classes.todo.subject,
      propVals: {
        [registered.properties['todo.title'].subject]: 'Buy milk',
        [registered.properties['todo.done'].subject]: false,
      },
    });

    expect(resource.getClasses()).toContain(registered.classes.todo.subject);
    expect(resource.get(registered.properties['todo.title'].subject)).toBe(
      'Buy milk',
    );
    expect(resource.get(registered.properties['todo.done'].subject)).toBe(
      false,
    );
  });

  it('rejects datatype changes for an explicitly reused Property subject', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );
    const propertySubject = 'did:ad:sharedTitleProperty';

    await store.registerSchema(
      defineSchema({
        name: 'TodoApp',
        classes: {
          todo: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                'atomic:subject': propertySubject,
              },
            },
          },
        },
      }),
    );

    await expect(
      store.registerSchema(
        defineSchema({
          name: 'ChangedTodoApp',
          classes: {
            todo: {
              type: 'object',
              properties: {
                title: {
                  type: 'integer',
                  'atomic:subject': propertySubject,
                },
              },
            },
          },
        }),
      ),
    ).rejects.toThrow('already registered with a different');
  });

  it('can reuse one imported Property in another Class', async ({ expect }) => {
    const keys = await Agent.generateKeyPair();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );
    const todo = await store.registerSchema(defineSchema(todoSchema));
    const project = await store.registerSchema(
      defineSchema({
        name: 'ProjectApp',
        imports: {
          todo: {
            subject: todo.ontology.subject,
            expectedHash: todo.model.ontology.schemaHash,
          },
        },
        classes: {
          project: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { $ref: 'todo.properties.title' },
            },
          },
        },
      }),
    );

    expect(project.properties['project.title']).toBeUndefined();
    expect(project.classes.project.props.requires).toEqual([
      todo.properties['todo.title'].subject,
    ]);
  });
});

describe('Store lazy frozen publish on save', () => {
  it('PUTs referenced frozen definitions to /frozen when an instance is saved', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(true);
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );

    // Commits go to the mocked client; nothing hits the network there.
    (
      store as unknown as { client: { postCommit: typeof vi.fn } }
    ).client.postCommit = vi.fn(async (commit: Commit) => ({
      ...commit,
      id: `https://example.com/commits/${commit.signature}`,
    })) as never;

    // Capture the `/frozen` PUTs the store makes on save.
    const puts: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') {
        puts.push(url);
      }

      return { ok: true, status: 200 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      // No registerSchema, no CLI — just define and use.
      const schema = defineSchema(todoSchema);

      const todo = await store.newResource({
        isA: schema.classes.todo,
        propVals: { [schema.properties.title]: 'Buy milk' },
      });
      await todo.save();

      const classHash = schema.classes.todo.replace('did:ad:frozen:', '');
      const titleHash = schema.properties.title.replace('did:ad:frozen:', '');

      // The class and its property definitions were published automatically.
      expect(puts.some(url => url.endsWith(`/frozen/${classHash}`))).toBe(true);
      expect(puts.some(url => url.endsWith(`/frozen/${titleHash}`))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
