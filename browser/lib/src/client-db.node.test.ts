import { expect, it, vi } from 'vitest';
import { NodeClientDb } from './client-db.node.js';

it.each(['snapshot', 'envelopes', 'import'] as const)(
  'does not expose the temporary snapshot between JSON and causal-state writes during %s',
  async operation => {
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
        envelopesFor: () => JSON.stringify({ snapshot: [...snapshot] }),
        importEnvelopes: async () => snapshot[0],
      },
    });
    const write = adapter.putResourceWithSnapshot(
      'did:ad:test',
      '{}',
      new Uint8Array([2]),
    );
    await vi.waitFor(() => expect(putResource).toHaveBeenCalled());
    let readSettled = false;
    const pending =
      operation === 'snapshot'
        ? adapter.getResourceWithSnapshot('did:ad:test')
        : operation === 'envelopes'
          ? adapter.envelopesFor(['did:ad:test'])
          : adapter.importEnvelopes([{ subject: 'did:ad:test', json: '{}' }]);
    const read = pending.then(result => {
      readSettled = true;

      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(readSettled).toBe(false);
    release();
    await write;
    const result = await read;
    if (operation === 'snapshot')
      expect(result).toMatchObject({ snapshot: new Uint8Array([2]) });
    else if (operation === 'envelopes')
      expect(result).toEqual({ snapshot: [2] });
    else expect(result).toBe(2);
  },
);
