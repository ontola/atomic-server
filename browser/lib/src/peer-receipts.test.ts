import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PeerReceiptRequests,
  PEER_RECEIPT_MAX_PENDING,
  PEER_RECEIPT_MAX_TARGETS,
  PEER_RECEIPT_TIMEOUT_MS,
} from './peer-receipts.js';
import { LoroLoader } from './loro-loader.js';
import { decodeB64, encodeB64 } from './base64.js';
import { PEER_STORAGE_BARRIER, Tag } from './ws-v2.js';
import type { ReplicaIdentity } from './replica-evidence.js';

const drive = 'atomic:test-drive';
const source = { storageId: 'a'.repeat(64), generation: 'b'.repeat(64) };
const replica = { storageId: 'c'.repeat(64), generation: 'd'.repeat(64) };
const version = (counter = 1) =>
  encodeB64(
    new LoroLoader.Loro.VersionVector(new Map([['1', counter]])).encode(),
  );
const payload = (frame: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(frame.subarray(1)));
const response = (request: Uint8Array, overrides = {}) =>
  new Uint8Array([
    Tag.STORAGE_RECEIPT_RESPONSE,
    ...new TextEncoder().encode(
      JSON.stringify({
        ...payload(request),
        replica,
        barrier: PEER_STORAGE_BARRIER,
        ...overrides,
      }),
    ),
  ]);

function harness(requestDrive = drive) {
  const state = { current: true };
  const send = vi.fn(async (_frame: Uint8Array) => {});
  const getSource = vi
    .fn<() => Promise<ReplicaIdentity | undefined>>()
    .mockResolvedValue(source);
  const onReceipt = vi.fn();
  const canSend = vi.fn(async (_subject: string) => true);
  const requests = new PeerReceiptRequests({
    drive: requestDrive,
    connectionId: 'connection-1',
    current: () => state.current,
    send,
    getSource,
    canSend,
    onReceipt,
  });
  const observe = (subject = drive, counter = 1) =>
    requests.observe({
      status: 'persisted',
      subject,
      local: { version: version(counter) },
    });

  return { requests, state, send, getSource, canSend, onReceipt, observe };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('peer storage receipt requests', () => {
  it.each(['x'.repeat(4097), 'é'.repeat(2049)])(
    'skips subjects and drives exceeding the UTF-8 wire limit',
    async longSubject => {
      const subjectCase = harness();
      subjectCase.requests.enable('agent');
      subjectCase.observe(longSubject);
      await subjectCase.requests.tick();
      expect(subjectCase.send).not.toHaveBeenCalled();

      const driveCase = harness(longSubject);
      driveCase.requests.enable('agent');
      driveCase.observe();
      await driveCase.requests.tick();
      expect(driveCase.send).not.toHaveBeenCalled();
    },
  );

  it('accepts the exact UTF-8 subject and drive boundary', async () => {
    const boundary = 'é'.repeat(2048);
    const { requests, observe, send } = harness(boundary);
    requests.enable('agent');
    observe(boundary);
    await requests.tick();
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips decoded empty and zero-counter version vectors', async () => {
    const { requests, send } = harness();
    requests.enable('agent');
    const invalid = [
      new LoroLoader.Loro.VersionVector(),
      new LoroLoader.Loro.VersionVector(new Map([['1', 0]])),
      new LoroLoader.Loro.VersionVector(
        new Map([
          ['1', 1],
          ['2', 0],
        ]),
      ),
    ];
    for (const vv of invalid)
      requests.observe({
        status: 'persisted',
        subject: drive,
        local: { version: encodeB64(vv.encode()) },
      });
    await requests.tick();
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for authentication/capability and a persistent source without losing exact save versions', async () => {
    const { requests, observe, send, getSource } = harness();
    observe(drive, 1);
    observe(drive, 2);
    await requests.tick();
    expect(getSource).not.toHaveBeenCalled();
    requests.enable('atomic:agent:verified');
    getSource.mockResolvedValueOnce(undefined);
    await requests.tick();
    expect(send).not.toHaveBeenCalled();
    await requests.tick();
    expect(send.mock.calls.map(([frame]) => payload(frame).version)).toEqual([
      version(1),
      version(2),
    ]);
  });

  it('binds the response to the pending nonce, exact version and authenticated connection', async () => {
    const { requests, observe, send, onReceipt } = harness();
    requests.enable('atomic:agent:verified');
    observe();
    await requests.tick();
    const request = send.mock.calls[0][0];
    await requests.receive(response(request, { nonce: '0'.repeat(64) }));
    await requests.receive(response(request, { drive: 'atomic:other-drive' }));
    await requests.receive(
      response(request, { subject: 'atomic:other-subject' }),
    );
    await requests.receive(response(request, { version: version(2) }));
    await requests.receive(response(request, { barrier: 'ordinary-ack' }));
    await requests.receive(
      response(request, { replica: { ...replica, generation: '' } }),
    );
    await requests.receive(
      response(request, {
        replica: {
          storageId: [replica.storageId],
          generation: [replica.generation],
        },
      }),
    );
    expect(onReceipt).not.toHaveBeenCalled();
    await requests.receive(response(request));
    const event = onReceipt.mock.calls[0][0];
    expect(event).toMatchObject({
      source,
      peerAgent: 'atomic:agent:verified',
      drive,
      connectionId: 'connection-1',
      observation: {
        capability: 'supported',
        replica,
        barrier: {
          version: version(),
          state: 'completed',
          storage: 'persistent',
          name: PEER_STORAGE_BARRIER,
        },
      },
    });
    for (const value of [
      event,
      event.source,
      event.observation,
      event.observation.replica,
      event.observation.barrier,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    await requests.receive(response(request));
    expect(onReceipt).toHaveBeenCalledTimes(1);
  });

  it('rejects expired and previous-connection responses', async () => {
    const first = harness();
    first.requests.enable('agent');
    first.observe();
    await first.requests.tick();
    const old = response(first.send.mock.calls[0][0]);
    vi.advanceTimersByTime(PEER_RECEIPT_TIMEOUT_MS + 1);
    await first.requests.receive(old);
    expect(first.onReceipt).not.toHaveBeenCalled();
    first.requests.close();
    const next = harness();
    next.requests.enable('agent');
    next.observe();
    await next.requests.tick();
    await next.requests.receive(old);
    expect(next.onReceipt).not.toHaveBeenCalled();
  });

  it('fences asynchronous response completion on identity or source generation change', async () => {
    const { requests, observe, send, getSource, state, onReceipt } = harness();
    requests.enable('agent');
    observe();
    await requests.tick();
    let resolve!: (value: ReplicaIdentity) => void;
    getSource.mockReturnValueOnce(new Promise(done => (resolve = done)));
    const receiving = requests.receive(response(send.mock.calls[0][0]));
    state.current = false;
    resolve(source);
    await receiving;
    expect(onReceipt).not.toHaveBeenCalled();

    const other = harness();
    other.requests.enable('agent');
    other.observe();
    await other.requests.tick();
    other.getSource.mockResolvedValue({
      ...source,
      generation: 'e'.repeat(64),
    });
    await other.requests.receive(response(other.send.mock.calls[0][0]));
    expect(other.onReceipt).not.toHaveBeenCalled();
  });

  it('fences asynchronous source lookup before sending and clears all pending work on close', async () => {
    const { requests, observe, getSource, send } = harness();
    requests.enable('agent');
    observe();
    let resolve!: (value: ReplicaIdentity) => void;
    getSource.mockReturnValueOnce(new Promise(done => (resolve = done)));
    const tick = requests.tick();
    requests.close();
    resolve(source);
    await tick;
    expect(send).not.toHaveBeenCalled();
    await requests.tick();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'])(
    'isolates %s from the consumer without retrying accepted evidence',
    async mode => {
      const { requests, observe, send, onReceipt } = harness();
      requests.enable('agent');
      observe();
      onReceipt.mockImplementation(() => {
        if (mode === 'throw') throw new Error('consumer failed');

        return Promise.reject(new Error('consumer failed'));
      });
      await requests.tick();
      await requests.receive(response(send.mock.calls[0][0]));
      observe();
      await requests.tick();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('rotates retries behind untouched targets and bounds queue, in-flight requests and attempts', async () => {
    const { requests, observe, send } = harness();
    requests.enable('agent');
    for (let i = 0; i < PEER_RECEIPT_MAX_TARGETS + 20; i++)
      observe(`atomic:${i}`);
    await requests.tick();
    expect(send).toHaveBeenCalledTimes(PEER_RECEIPT_MAX_PENDING);
    vi.advanceTimersByTime(PEER_RECEIPT_TIMEOUT_MS + 1);
    await requests.tick();
    expect(payload(send.mock.calls[4][0]).subject).toBe('atomic:4');

    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(PEER_RECEIPT_TIMEOUT_MS + 1);
      await requests.tick();
    }

    const counts = new Map<string, number>();

    for (const [frame] of send.mock.calls) {
      const subject = payload(frame).subject;
      counts.set(subject, (counts.get(subject) ?? 0) + 1);
    }

    expect(counts.size).toBe(PEER_RECEIPT_MAX_TARGETS);
    expect([...counts.values()].every(count => count === 3)).toBe(true);
  });

  it('fairly seeds the full dense reconciliation inventory without changing its exclusions', async () => {
    const { requests, send } = harness();
    requests.enable('agent');
    const resources = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `atomic:${String(i).padStart(3, '0')}`,
        [1],
      ]),
    );

    let responded = 0;

    for (let i = 0; i < 30; i++) {
      requests.seed({ drive, driveHash: '', peers: ['1'], resources });
      await requests.tick();

      // The integrated producer immediately fills each acknowledged slot.
      // Drain those new frames too, preserving the complete-inventory oracle.
      while (responded < send.mock.calls.length) {
        const frame = send.mock.calls[responded++][0];
        await requests.receive(response(frame));
        await Promise.resolve();
      }
    }

    const subjects = new Set(
      send.mock.calls.map(([frame]) => payload(frame).subject),
    );
    expect(subjects.size).toBe(100);
    expect(subjects.has('atomic:excluded-outbox-subject')).toBe(false);
  });

  it('ignores malformed, oversized and non-version evidence', async () => {
    const { requests, send, onReceipt } = harness();
    requests.enable('agent');
    for (const invalid of [null, '', 'not-a-vector', 'A'.repeat(17 * 1024)])
      requests.observe({
        status: 'persisted',
        subject: drive,
        local: { version: invalid },
      });
    await requests.tick();
    expect(send).not.toHaveBeenCalled();
    await requests.receive(new Uint8Array([Tag.STORAGE_RECEIPT_RESPONSE, 255]));
    await requests.receive(
      new Uint8Array(65537).fill(Tag.STORAGE_RECEIPT_RESPONSE),
    );
    expect(onReceipt).not.toHaveBeenCalled();
  });

  it('omits zero counters and empty resources from dense multi-actor inventories', async () => {
    const { requests, send } = harness();
    requests.enable('agent');
    requests.seed({
      drive,
      driveHash: '',
      peers: ['1', '2'],
      resources: {
        'atomic:a': [1, 0],
        'atomic:b': [0, 2],
        'atomic:empty': [0, 0],
      },
    });
    await requests.tick();
    expect(send).toHaveBeenCalledTimes(2);

    for (const [frame] of send.mock.calls) {
      const values = LoroLoader.Loro.VersionVector.decode(
        decodeB64(payload(frame).version),
      ).toJSON();
      expect(values.size).toBe(1);
      expect([...values.values()].every(value => value > 0)).toBe(true);
    }
  });

  it('checks current per-subject permission before disclosing the subject/version', async () => {
    const { requests, observe, send, canSend } = harness();
    requests.enable('agent');
    observe('atomic:private');
    observe('atomic:shared');
    canSend.mockImplementation(async subject => subject === 'atomic:shared');
    await requests.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(payload(send.mock.calls[0][0]).subject).toBe('atomic:shared');
  });
});
