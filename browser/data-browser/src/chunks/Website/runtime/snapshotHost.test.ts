import { expect, it, vi } from 'vitest';
import { hostSnapshot } from './snapshotHost';
import { viewRequest } from '../../../../../plugin/src/viewProtocol';

it('serves only the frozen projection to its own frame and refuses live reads and writes', () => {
  let receive: (event: MessageEvent) => void = () => {};
  const host = {
    addEventListener: (_: string, listener: unknown) => {
      receive = listener as typeof receive;
    },
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', host);
  const target = { postMessage: vi.fn() };
  const frame = {
    contentWindow: target,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const snapshot = {
    title: 'Public notes',
    columns: ['Title'],
    rows: [['Selected only']],
  };
  const bridge = hostSnapshot(frame as never, snapshot);
  const send = (op: Parameters<typeof viewRequest>[1], source = target) =>
    receive({
      source,
      data: viewRequest(1, op, { subject: 'private-other-row' }),
    } as unknown as MessageEvent);
  send('data', {} as typeof target);
  expect(target.postMessage).not.toHaveBeenCalled();
  send('data');
  expect(target.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ result: snapshot }),
    '*',
  );

  for (const op of [
    'get',
    'query',
    'save',
    'patch',
    'create',
    'destroy',
    'search',
  ] as const) {
    send(op);
    expect(target.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('snapshot data only'),
      }),
      '*',
    );
  }

  bridge.close();
  target.postMessage.mockClear();
  send('data');
  expect(target.postMessage).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
