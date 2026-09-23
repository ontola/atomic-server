import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { RPCClient } from './rpc';
import { isViewRequest, viewRequest } from './viewProtocol';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function frame() {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const parent = { postMessage: vi.fn() };
  const window = {
    parent,
    addEventListener: (_: string, listener: (typeof listeners)[number]) =>
      listeners.push(listener),
    removeEventListener: vi.fn(),
  };
  const reply = (data: unknown, source: unknown = parent) =>
    listeners.forEach(listener => listener({ source, data } as MessageEvent));

  return { window, reply, parent };
}

it('validates version, correlation id, operation and argument envelope', () => {
  const valid = viewRequest('one', 'get', { subject: 'row' });
  expect(isViewRequest(valid)).toBe(true);
  for (const change of [
    { version: 2 },
    { id: NaN },
    { id: '' },
    { op: 'sign-as-owner' },
    { args: [] },
    { args: null },
  ])
    expect(isViewRequest({ ...valid, ...change })).toBe(false);
});

it.each(['packaged', 'generated'])(
  'uses the same resource contract and trusts only the parent: %s',
  async kind => {
    const f = frame();
    vi.stubGlobal('window', f.window);
    let getResource: (
      subject: string,
    ) => Promise<{ subject: string; props: unknown }>;

    if (kind === 'packaged') {
      const client = new RPCClient();
      getResource = subject => client.getResource(subject);
    } else {
      const source = readFileSync(
        new URL(
          '../../../server/src/plugins/assets/view-client.js',
          import.meta.url,
        ),
        'utf8',
      );
      const store = new Function(
        'window',
        'setTimeout',
        source.replace('export const store', 'const store') + '\nreturn store;',
      )(f.window, () => 0);
      getResource = subject => store.getResource(subject);
    }

    const pending = getResource('row');
    const request = f.parent.postMessage.mock.calls[0][0];
    expect(isViewRequest(request)).toBe(true);
    expect(request).toMatchObject({ op: 'get', args: { subject: 'row' } });
    const result = {
      subject: 'row',
      props: { name: 'Shared shape' },
      title: 'Shared shape',
      loading: false,
    };
    const response = {
      type: 'atomic.view.response',
      version: 1,
      id: request.id,
      result,
    };
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    f.reply(response, {});
    await Promise.resolve();
    expect(settled).toBe(false);
    f.reply(response);
    expect(await pending).toMatchObject({
      subject: 'row',
      props: result.props,
    });
  },
);

it('lets a generated view wait for host recovery but still rejects a silent host', async () => {
  vi.useFakeTimers();
  const f = frame();
  const source = readFileSync(
    new URL(
      '../../../server/src/plugins/assets/view-client.js',
      import.meta.url,
    ),
    'utf8',
  );
  const store = new Function(
    'window',
    'setTimeout',
    'clearTimeout',
    source.replace('export const store', 'const store') + '\nreturn store;',
  )(f.window, setTimeout, clearTimeout);
  const pending = store.query({ property: 'parent', value: 'table' });
  const outcome = pending.then(
    (value: unknown) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
  // ClientDb's follower recovery and websocket authentication each allow 30s.
  // A view must not abandon the host halfway through that supported recovery.
  await vi.advanceTimersByTimeAsync(30_000);
  f.reply({
    type: 'atomic.view.response',
    version: 1,
    id: f.parent.postMessage.mock.calls[0][0].id,
    result: ['row'],
  });
  expect(await outcome).toEqual({ value: ['row'] });
  expect(vi.getTimerCount()).toBe(0);

  const silent = store.query({ property: 'parent', value: 'table' });
  const rejected = expect(silent).rejects.toThrow(
    'The host did not answer query in time.',
  );
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('carries the proxy relay ops, and store.proxy sends them', () => {
  for (const op of ['proxy', 'proxyConnections', 'proxyConnect'] as const)
    expect(isViewRequest(viewRequest(1, op, { platform: 'pets' }))).toBe(true);
  const f = frame();
  const source = readFileSync(
    new URL(
      '../../../server/src/plugins/assets/view-client.js',
      import.meta.url,
    ),
    'utf8',
  );
  const store = new Function(
    'window',
    'setTimeout',
    'clearTimeout',
    source.replace('export const store', 'const store') + '\nreturn store;',
  )(
    f.window,
    () => 0,
    () => undefined,
  );
  void store.proxy.request({
    platform: 'pets',
    connectionId: 'c1',
    path: '/pets',
    query: { page: '2' },
  });
  void store.proxy.connections({ platform: 'pets' });
  void store.proxy.connect({ platform: 'pets' });
  const sent = f.parent.postMessage.mock.calls.map(([m]) => m);
  expect(sent.every(isViewRequest)).toBe(true);
  expect(sent.map(m => [m.op, m.args.platform])).toEqual([
    ['proxy', 'pets'],
    ['proxyConnections', 'pets'],
    ['proxyConnect', 'pets'],
  ]);
  expect(sent[0].args).toMatchObject({ connectionId: 'c1', path: '/pets' });
});
