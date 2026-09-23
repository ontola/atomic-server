import { describe, it, expect, vi } from 'vitest';

import { ClientDbWorker } from './client-db.js';
import { RequestCancelledError } from './error.js';

describe('ClientDbWorker without a secure context', () => {
  it('parks in server-only mode with a clear error when Web Locks are unavailable', async () => {
    // Simulate an insecure context (plain HTTP on a non-localhost origin, e.g.
    // `http://homeassistant.local:9883`): the browser withholds
    // `navigator.locks`. Node's default test env already lacks it; make the
    // precondition explicit and robust to future Node versions that might add
    // it.
    if (
      typeof navigator !== 'undefined' &&
      (navigator as Navigator & { locks?: unknown }).locks
    ) {
      Object.defineProperty(navigator, 'locks', {
        value: undefined,
        configurable: true,
      });
    }

    const db = new ClientDbWorker('wasm-url', 'worker-url');

    // Must NOT throw an opaque TypeError — it resolves cleanly into a degraded,
    // server-only mode, recording the reason on `initError`.
    await expect(
      db.init('http://homeassistant.local:9883'),
    ).resolves.toBeUndefined();
    expect(db.initError).toBeInstanceOf(Error);
    expect(db.initError?.message).toMatch(/insecure connection/i);
  });
});

describe('ClientDbWorker cold initialization', () => {
  it('does not steal its own lock while its worker is still loading', async () => {
    vi.useFakeTimers();
    const request = vi.fn((_name, _options, callback) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage() {}
        close() {}
      },
    );
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: unknown) => void;
        postMessage(message: { id: string }) {
          setTimeout(
            () =>
              this.onmessage?.({ data: { id: message.id, type: 'result' } }),
            3000,
          );
        }
        terminate() {}
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new ClientDbWorker('wasm-url', 'worker-url');

    try {
      const initialized = db.init('https://example.com');
      await vi.advanceTimersByTimeAsync(3100);
      await initialized;
      expect(request).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      db.destroy();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe('ClientDbWorker leader handoff', () => {
  it('finishes a pending follower call through its new local worker', async () => {
    vi.useFakeTimers();
    const workerMessages: string[] = [];
    let acquire!: () => Promise<unknown>;
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn((_name, _options, callback) => {
          acquire = callback;

          return new Promise(() => {});
        }),
      },
    });
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage?: (event: { data: { type: string } }) => void;
        postMessage = vi.fn();
        close() {}
      },
    );
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: unknown) => void;
        postMessage(message: { id: string; type: string }) {
          workerMessages.push(message.type);
          queueMicrotask(() =>
            this.onmessage?.({
              data: { id: message.id, type: 'result', data: undefined },
            }),
          );
        }
        terminate() {}
      },
    );
    const db = new ClientDbWorker('wasm-url', 'worker-url');

    try {
      const initialized = db.init('https://example.com');
      const channel = (
        db as unknown as {
          bc: { onmessage?: (event: { data: { type: string } }) => void };
        }
      ).bc;
      channel.onmessage?.({ data: { type: 'leader-announce' } });
      await initialized;
      const pending = db.flush();
      const unacknowledgedWrite = expect(
        db.putResource('{}'),
      ).rejects.toBeInstanceOf(RequestCancelledError);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      void acquire();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(pending).resolves.toBeUndefined();
      await unacknowledgedWrite;
      expect(workerMessages).toEqual(['init', 'flush']);
    } finally {
      db.destroy();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('rejects pending follower calls when the new worker cannot start', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: (
          _name: string,
          _options: unknown,
          callback: () => Promise<unknown>,
        ) => callback(),
      },
    });
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('worker failed');
        }
      },
    );
    const db = new ClientDbWorker('wasm-url', 'worker-url');
    Object.assign(db, {
      role: 'follower',
      bc: { postMessage: vi.fn(), close: vi.fn() },
    });

    try {
      const pending = expect(db.flush()).rejects.toThrow('worker failed');
      (
        db as unknown as {
          requestLeaderLock: (baseUrl: string, steal: boolean) => void;
        }
      ).requestLeaderLock('https://example.com', false);
      await pending;
      await expect(db.flush()).rejects.toThrow('ClientDb unavailable');
    } finally {
      db.destroy();
      vi.unstubAllGlobals();
    }
  });
});

describe('ClientDbWorker version vectors', () => {
  it('converts the nested Rust maps for drive and database inventories', async () => {
    const db = new ClientDbWorker('wasm-url', 'worker-url');
    const transport = db as unknown as {
      send(message: unknown): Promise<unknown>;
    };
    vi.spyOn(transport, 'send').mockResolvedValue(
      new Map([['did:ad:drive', new Map([['12345678901234567890', 42]])]]),
    );
    const expected = { 'did:ad:drive': { '12345678901234567890': 42 } };
    expect(await db.getVersionVectorsForDrive('did:ad:drive')).toEqual(
      expected,
    );
    expect(await db.getAllVersionVectors()).toEqual(expected);
    vi.restoreAllMocks();
  });
});
