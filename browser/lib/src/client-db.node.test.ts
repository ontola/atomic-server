import { expect, it, vi } from 'vitest';
import { NodeClientDb } from './client-db.node.js';

it('does not expose the temporary snapshot between JSON and causal-state writes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let snapshot: Uint8Array = new Uint8Array([0]);
  const putResource = vi.fn(async () => {
    snapshot = new Uint8Array([1]);
    await gate;
  });
  const adapter = new NodeClientDb({ wasmPath: 'unused-in-unit-test' });
  Object.assign(adapter, {
    db: {
      putResource,
      putLoroSnapshot: (_subject: string, value: Uint8Array) => {
        snapshot = value;
      },
      getResource: async () => '{"@id":"did:ad:test"}',
      getLoroSnapshot: () => snapshot,
    },
  });
  const write = adapter.putResourceWithSnapshot(
    'did:ad:test',
    '{}',
    new Uint8Array([2]),
  );
  await vi.waitFor(() => expect(putResource).toHaveBeenCalled());
  let readSettled = false;
  const read = adapter.getResourceWithSnapshot('did:ad:test').then(result => {
    readSettled = true;

    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(readSettled).toBe(false);
  release();
  await write;
  expect((await read).snapshot).toEqual(new Uint8Array([2]));
});
