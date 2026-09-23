// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserIntegrations } from './browser';
import {
  describePlatform,
  mergeQuerySelections,
  ontologyShortname,
  PlatformReader,
  readPlatform,
  type CatalogDocument,
  type Transport,
} from './reflector-read';

/** The shape of integrations/pets/fixtures/pets/document.json, inline. */
const pets: CatalogDocument = {
  info: { title: 'Pets' },
  servers: [{ url: 'https://pets.example' }],
  paths: {
    '/pets': {
      get: {
        'x-pagination': [{ scheme: 'nextLink' }],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Pet' },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    paginationSchemes: {
      nextLink: {
        type: 'nextLink',
        response: { headers: { Link: { role: 'nextLink' } } },
      },
    },
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          age: { type: 'integer' },
          vaccinated: { type: 'boolean' },
          weight: { type: 'number' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
    },
    crudResources: {
      pet: {
        schema: { $ref: '#/components/schemas/Pet' },
        identity: {
          urlTemplate: '/pets/{pet_id}',
          bindings: { pet_id: { field: 'id' } },
        },
        collections: { pets: { urlTemplate: '/pets' } },
      },
    },
  },
};
const rows = ['Rex', 'Whiskers', 'Tweety', 'Nibbles', 'Bubbles'].map(
  (name, i) => ({
    id: i + 1,
    name,
    age: i + 1,
    vaccinated: i % 2 === 0,
    weight: i + 0.5,
    updated_at: '2026-09-09T00:00:00Z',
  }),
);
const reply = (
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
) => ({ status, headers, body: JSON.stringify(body) });

function petsTransport() {
  return vi.fn<Transport>(async url =>
    url.searchParams.get('page') === '2'
      ? reply(rows.slice(2))
      : reply(rows.slice(0, 2), {
          Link: '<https://pets.example/pets?page=2>; rel="next"',
        }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('describes a platform from crudResources: no parameters, one collection', () => {
  expect(describePlatform(pets)).toEqual({
    parameters: [],
    collections: ['pets'],
    upstream: 'https://pets.example/',
  });
  expect(() => describePlatform({ ...pets, components: {} })).toThrow(
    /crudResources/,
  );
});

it('follows Link pagination and keeps Atomic datatypes', async () => {
  const transport = petsTransport();
  const fetched = await readPlatform(pets, {
    platform: 'pets',
    constants: {},
    transport,
  });

  expect(transport.mock.calls.map(([url]) => url.href)).toEqual([
    'https://pets.example/pets',
    'https://pets.example/pets?page=2',
  ]);
  expect(fetched.platform).toBe('pets');
  expect(fetched.errors).toEqual([]);
  expect(fetched.records.map(r => r.name)).toEqual(rows.map(r => r.name));
  expect(fetched.records[0]).toEqual({
    resource: 'pet',
    namespace: '',
    id: '1',
    name: 'Rex',
    values: {
      id: 1,
      name: 'Rex',
      age: 1,
      vaccinated: true,
      weight: 0.5,
      'updated-at': Date.parse('2026-09-09T00:00:00Z'),
    },
  });
  const datatypes = Object.fromEntries(
    fetched.ontology.terms.map(t => [t.shortname, t.datatype]),
  );
  expect(datatypes).toMatchObject({
    age: 'https://atomicdata.dev/datatypes/integer',
    vaccinated: 'https://atomicdata.dev/datatypes/boolean',
    weight: 'https://atomicdata.dev/datatypes/float',
    'updated-at': 'https://atomicdata.dev/datatypes/timestamp',
  });
  const pet = fetched.ontology.terms.find(t => t.kind === 'class')!;
  expect(pet).toMatchObject({
    path: 'pets/class/pet',
    requires: ['pets/property/id', 'pets/property/name'],
  });
});

it('checks access with one request and imports nothing', async () => {
  const transport = petsTransport();
  await expect(
    readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport,
      probe: true,
    }),
  ).resolves.toMatchObject({ records: [] });
  expect(transport).toHaveBeenCalledTimes(1);

  const denied = vi.fn<Transport>(async () => reply({}, {}, 403));
  await expect(
    readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport: denied,
      probe: true,
    }),
  ).rejects.toThrow('GET /pets responded 403');
});

/** Calendar-shaped: events nested under each calendar, pageToken in the body. */
const calendar: CatalogDocument = {
  info: { title: 'Calendar' },
  servers: [{ url: 'https://api.example/v3' }],
  paths: {
    '/users/me/calendarList': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/calendars/{calendarId}/events': {
      get: {
        parameters: [{ name: 'pageToken', in: 'query' }],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Events' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    paginationSchemes: {
      token: {
        type: 'pageToken',
        request: { queryParameters: { pageToken: { role: 'pageToken' } } },
        response: { bodyFields: { nextPageToken: { role: 'nextPageToken' } } },
      },
    },
    schemas: {
      Events: {
        type: 'object',
        properties: {
          nextPageToken: { type: 'string' },
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/Event' },
          },
        },
      },
      Event: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          summary: { type: 'string' },
          start: { type: 'object' },
        },
      },
    },
    crudResources: {
      calendar: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, summary: { type: 'string' } },
        },
        identity: {
          urlTemplate: '/calendars/{calendarId}',
          bindings: { calendarId: { field: 'id' } },
        },
        collections: {
          calendarList: { urlTemplate: '/users/me/calendarList' },
        },
      },
      event: {
        schema: { $ref: '#/components/schemas/Event' },
        identity: {
          urlTemplate: '/calendars/{calendarId}/events/{eventId}',
          bindings: { calendarId: { field: 'id' }, eventId: { field: 'id' } },
        },
        collections: {
          events: { urlTemplate: '/calendars/{calendarId}/events' },
        },
      },
    },
  },
};

it('reads nested collections once per parent, following page tokens', async () => {
  expect(describePlatform(calendar).parameters).toEqual([]);
  const transport = vi.fn<Transport>(async url => {
    if (url.pathname === '/v3/users/me/calendarList')
      return reply({
        items: [
          { id: 'work', summary: 'Work' },
          { id: 'a/b', summary: 'Slashed' },
        ],
      });
    const token = url.searchParams.get('pageToken');
    const calendarId = decodeURIComponent(url.pathname.split('/')[3]!);

    return reply(
      token
        ? { items: [{ id: 'e2', summary: `${calendarId} 2` }] }
        : {
            nextPageToken: 'next',
            items: [{ id: 'e1', summary: `${calendarId} 1`, start: {} }],
          },
    );
  });
  const fetched = await readPlatform(calendar, {
    platform: 'google-calendar',
    constants: {},
    transport,
  });

  expect(
    transport.mock.calls.map(([url]) => url.pathname + url.search),
  ).toEqual([
    '/v3/users/me/calendarList',
    '/v3/calendars/work/events',
    '/v3/calendars/work/events?pageToken=next',
    '/v3/calendars/a%2Fb/events',
    '/v3/calendars/a%2Fb/events?pageToken=next',
  ]);
  const events = fetched.records.filter(r => r.resource === 'event');
  expect(events.map(r => [r.namespace, r.id, r.name])).toEqual([
    ['work', 'e1', 'work 1'],
    ['work', 'e2', 'work 2'],
    ['a/b', 'e1', 'a/b 1'],
    ['a/b', 'e2', 'a/b 2'],
  ]);
  // A field typed differently across resources, or untyped, stays JSON.
  expect(
    fetched.ontology.terms.find(t => t.shortname === 'start')?.datatype,
  ).toBe('https://atomicdata.dev/datatypes/json');
});

/** Clockify-shaped: a workspace the user names, page numbers, a selection. */
const workspace: CatalogDocument = {
  info: { title: 'Timesheets' },
  servers: [{ url: 'https://api.example/api/v1' }],
  paths: {
    '/workspaces/{workspaceId}/entries': {
      get: {
        parameters: [
          { name: 'page', in: 'query' },
          { $ref: '#/components/parameters/start' },
        ],
      },
    },
  },
  components: {
    parameters: { start: { name: 'start', in: 'query' } },
    paginationSchemes: {
      pages: {
        type: 'pageNumber',
        request: { queryParameters: { page: { role: 'page' } } },
      },
    },
    crudResources: {
      entry: {
        schema: { type: 'object', properties: { id: { type: 'string' } } },
        identity: {
          urlTemplate: '/workspaces/{workspaceId}/entries/{entryId}',
          bindings: { entryId: { field: 'id' } },
        },
        collections: {
          entries: {
            urlTemplate: '/workspaces/{workspaceId}/entries',
            'x-list-query': { hydrated: true },
          },
        },
      },
    },
  },
};

it('asks for root parameters and applies catalog selections', async () => {
  expect(describePlatform(workspace)).toMatchObject({
    parameters: ['workspaceId'],
    collections: ['entries'],
  });
  // No page-count metadata in the response, so (as in syncables) one page.
  const transport = vi.fn<Transport>(async () => reply([{ id: 'a' }]));
  const options = { platform: 'clockify', transport };
  await expect(
    readPlatform(workspace, { ...options, constants: {} }),
  ).rejects.toThrow('Enter a value for workspaceId');
  const selection = mergeQuerySelections(
    {
      query_overrides: [
        {
          path: '/workspaces/{workspaceId}/entries',
          values: { start: 'old' },
        },
      ],
    },
    {
      query_overrides: [
        {
          path: '/workspaces/{workspaceId}/entries',
          values: { start: '2026-01-01T00:00:00Z' },
        },
      ],
    },
  );
  const fetched = await readPlatform(workspace, {
    ...options,
    constants: { workspaceId: 'w1' },
    selection,
  });

  expect(fetched.records.map(r => [r.namespace, r.id])).toEqual([['w1', 'a']]);
  expect(transport.mock.calls.map(([url]) => url.href)).toEqual([
    'https://api.example/api/v1/workspaces/w1/entries?hydrated=true&start=2026-01-01T00%3A00%3A00Z&page=1',
  ]);
  await expect(
    readPlatform(workspace, {
      ...options,
      constants: { workspaceId: 'w1' },
      selection: {
        query_overrides: [
          { path: '/workspaces/{workspaceId}/entries', values: { evil: 1 } },
        ],
      },
    }),
  ).rejects.toThrow('Unknown query parameter evil');
});

it('stops pagination that leaves the API origin', async () => {
  const transport = vi.fn<Transport>(async () =>
    reply(rows, { link: '<https://evil.example/pets>; rel="next"' }),
  );
  const fetched = await readPlatform(pets, {
    platform: 'pets',
    constants: {},
    transport,
  });
  // The first page is kept; the escape is reported, not followed.
  expect(transport).toHaveBeenCalledTimes(1);
  expect(fetched.records).toHaveLength(5);
  expect(fetched.errors).toEqual([
    'pets: Pagination left the catalog API origin',
  ]);
});

it('retries a 429 after Retry-After, and caps records and requests', async () => {
  let calls = 0;
  const sleep = vi.fn(async () => {});
  const transport = vi.fn<Transport>(async () =>
    ++calls === 1 ? reply({}, { 'Retry-After': '2' }, 429) : reply(rows),
  );
  const fetched = await readPlatform(pets, {
    platform: 'pets',
    constants: {},
    transport,
    sleep,
    limits: { maxRecords: 3 },
  });
  expect(sleep).toHaveBeenCalledWith(expect.any(Number));
  expect(fetched.records).toHaveLength(3);
  expect(fetched.errors).toEqual([
    'pets: Import exceeds 3 records; narrow its scope',
  ]);

  // Records land page by page, so a cap mid-walk keeps what was read.
  const capped = await readPlatform(pets, {
    platform: 'pets',
    constants: {},
    transport: petsTransport(),
    limits: { maxRequests: 1 },
  });
  expect(capped.records).toHaveLength(2);
  expect(capped.errors).toEqual([
    'pets: Import exceeds 1 requests; narrow its scope',
  ]);
  await expect(
    readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport: vi.fn<Transport>(async () => reply({}, {}, 500)),
    }),
  ).rejects.toThrow(
    'Import incomplete; no changes proposed: pets: GET /pets responded 500',
  );
});

it('rejects repeated identities instead of importing duplicates', async () => {
  const transport = vi.fn<Transport>(async () => reply([rows[0], rows[0]]));
  const fetched = await readPlatform(pets, {
    platform: 'pets',
    constants: {},
    transport,
  });
  expect(fetched.records).toHaveLength(1);
  expect(fetched.errors).toEqual([
    'pets: Missing or repeated record identity; pagination may not be forwarded by the proxy',
  ]);
});

it('normalizes shortnames the way the removed Rust engine did', () => {
  expect(ontologyShortname('updated_at')).toBe('updated-at');
  expect(ontologyShortname('State__Reason')).toBe('state-reason');
  expect(ontologyShortname('_id')).toBe('id');
});

it('reads through BrowserIntegrations: catalog JSON, proxy paths, rotating codes', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
  } as Storage;
  vi.stubGlobal('location', { origin: 'https://atomic.example' });
  vi.stubGlobal('navigator', {
    locks: { request: (_: string, f: () => unknown) => f() },
  });
  let code = 0;
  const http = vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname, search } = new URL(url);
    if (pathname === '/catalog') return Response.json(['pets']);
    // A proxy from before the `.json` route: fall back to `.yaml`.
    if (pathname === '/catalog/pets.json')
      return new Response('', { status: 404 });
    if (pathname === '/catalog/pets.yaml') return Response.json(pets);
    if (pathname === '/catalog/pets.selection.json') return Response.json({});
    if (pathname === '/connect/redeem')
      return Response.json({ connection_code: 'c0', platform: 'pets' });
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer c${code}`,
    );
    const headers = new Headers({ 'X-Connection-Code': `c${++code}` });
    if (!search)
      headers.set('Link', '<https://pets.example/pets?page=2>; rel="next"');

    return Response.json(
      pathname === '/proxy/pets/pets'
        ? search
          ? rows.slice(2)
          : rows.slice(0, 2)
        : {},
      { headers },
    );
  });
  const integrations = new BrowserIntegrations(
    storage,
    'https://proxy.example',
    http as typeof fetch,
  );
  const { state } = await integrations.start(
    'drive',
    'actor',
    'pets',
    'https://atomic.example/app/integrations',
  );
  await integrations.finish('drive', 'actor', state, 'handoff');
  const reader = new PlatformReader(integrations);
  const connection = {
    drive: 'drive',
    actor: 'actor',
    connection: state,
    platform: 'pets',
  };

  await expect(reader.describe('pets')).resolves.toMatchObject({
    collections: ['pets'],
  });
  await reader.check(connection, {});
  const fetched = await reader.read(connection, {});
  expect(fetched.records).toHaveLength(5);
  expect(
    http.mock.calls
      .map(([url]) => new URL(url))
      .filter(u => u.pathname.startsWith('/proxy/'))
      .map(u => u.pathname + u.search),
  ).toEqual([
    '/proxy/pets/pets',
    '/proxy/pets/pets',
    '/proxy/pets/pets?page=2',
  ]);
  // The rotated code is never handed to the read path.
  expect(JSON.stringify(fetched)).not.toMatch(/"c\d"/);
  await expect(
    reader.read({ ...connection, platform: 'clockify' }, {}),
  ).rejects.toThrow();
});
