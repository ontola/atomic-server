import { expect, it, vi } from 'vitest';
import { discoverDatabases, proxyOperation } from './proxy';
import { run } from './plugin';
import { id, fixture } from './fixture';
import { request } from './model';
import { runWithAsyncReads } from '../localthought/async-plugin';
import { continueBrowserSync, type Step } from '../localthought/browser-sync';
import { P } from './model';
it('discovers database names and POST cursor pagination entirely through the proxy', async () => {
  const proxy = vi.fn(
    async (_path: string, _init?: { method?: string; body?: string }) => ({
      status: 200,
      body: JSON.stringify({
        results: [
          { object: 'data_source', id, title: [{ plain_text: 'Tasks' }] },
        ],
        has_more: true,
        next_cursor: 'second',
      }),
    }),
  );
  const result = await discoverDatabases(proxy, 'Tasks', 'first');
  expect(result.results[0].name).toBe('Tasks');
  expect(proxy.mock.calls[0][0]).toBe('/v1/search');
  expect(JSON.parse(proxy.mock.calls[0][1]!.body!)).toMatchObject({
    start_cursor: 'first',
    query: 'Tasks',
  });
  expect(result.cursor).toBe('second');
  await expect(discoverDatabases(proxy, '', 'second')).rejects.toThrow(
    'pagination',
  );
});
it('keeps credentials out of forwarded requests and rejects undeclared operations', async () => {
  const proxy = vi.fn(async () => ({ status: 200, body: '{}' }));
  const read = proxyOperation(id, proxy, 'read');
  await read(request('schema', 'GET', `/data_sources/${id}`));
  expect(proxy.mock.calls).toEqual([
    [`/v1/data_sources/${id}`, { method: 'GET', body: undefined }],
  ]);
  await expect(
    read(request('update', 'PATCH', `/pages/${id}`, {})),
  ).rejects.toThrow('declared');
  await expect(
    read({
      ...request('schema', 'GET', `/data_sources/${id}`),
      url: 'https://evil.example/data_sources/' + id,
    }),
  ).rejects.toThrow('endpoint');
  expect(proxy).toHaveBeenCalledTimes(1);
});
it('preserves the existing Notion preview over asynchronous proxy reads', async () => {
  const f = fixture();
  const expected = run(f.input);
  const proxy = vi.fn(async (path: string) => ({
    status: 200,
    body: JSON.stringify(
      path.endsWith('/query') ? f.responses.query : f.responses.schema,
    ),
  }));
  const { http: _http, ...input } = f.input;
  const actual = await runWithAsyncReads(
    run,
    input,
    proxyOperation(id, proxy, 'read'),
  );
  expect(actual).toEqual(expected);
  expect(proxy).toHaveBeenCalledTimes(2);
});

it('imports, checkpoints, then sends an Atomic edit back through the proxy', async () => {
  const f = fixture();
  const proxy = vi.fn(
    async (path: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(init.body!);
        f.page.properties.Name.title = body.properties.title.title;
      }
      const data = path.endsWith('/query')
        ? f.responses.query
        : path.includes('/pages/')
          ? f.page
          : f.responses.schema;
      return { status: 200, body: JSON.stringify(data) };
    },
  );
  const read = proxyOperation(id, proxy, 'read');
  const write = proxyOperation(id, proxy, 'write');
  const invoke = (input: object) =>
    runWithAsyncReads(run, { ...f.input, ...input }, read);
  const atomic = async (verdict: any) => {
    const outcomes: { subject: string }[] = [];
    for (const intent of verdict.intents) {
      const subject = intent.subject ?? 'row';
      if (intent.op === 'create')
        f.records[subject] = { [P.parent]: intent.parent, [P.isA]: intent.isA };
      Object.assign(f.records[subject], intent.set ?? {});
      for (const property of intent.properties ?? [])
        delete f.records[subject][property];
      outcomes.push({ subject });
    }
    return { outcomes };
  };
  const first: any = await invoke({ phase: 'preview' });
  const host = {
    save: vi.fn(),
    external: write,
    atomic,
    step: (session: object) =>
      invoke({ ...session, phase: 'step' }) as Promise<Step>,
  };
  const imported = await continueBrowserSync(
    { proposal: first.proposal, connection: f.input.connection },
    host,
  );
  expect(imported.complete).toBe(true);
  expect(f.records.row[P.name]).toBe('Task');
  f.records.row[P.name] = 'Edited in Atomic';
  const next: any = await invoke({
    phase: 'preview',
    connection: imported.connection,
  });
  const synced = await continueBrowserSync(
    { proposal: next.proposal, connection: imported.connection },
    host,
  );
  expect(synced.complete).toBe(true);
  expect(f.page.properties.Name.title[0].text.content).toBe('Edited in Atomic');
  f.page.properties.Name.title[0].text.content = 'Edited in Notion';
  const refreshed: any = await invoke({
    phase: 'preview',
    connection: synced.connection,
  });
  expect(refreshed.problems).toEqual([]);
  expect(
    proxy.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
  ).toHaveLength(1);
});
