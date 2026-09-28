import { describe, it, expect, vi } from 'vitest';

import { ClientDbWorker } from './client-db.js';
import { RequestCancelledError } from './error.js';

/** The 2s leader election plus the 15s a steal gets to settle, and a tick. */
const LEADER_ELECTION_AND_STEAL_MS = 17_500;

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

  // Run 4686 carried 60 "reclaiming the lock did not succeed" messages and not
  // one "stealing OPFS lock" warning beside them, which can only mean the lock
  // was ours the whole time and the page was waiting on its own wasm import.
  // The message sent the reader after another tab that never existed.
  it('does not blame another tab for its own slow boot', async () => {
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
    // Longer than the boot gets, so the give-up path runs. On the CI box the
    // same boot measured 7.9s.
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: unknown) => void;
        postMessage(message: { id: string; type?: string }) {
          if (message.type !== 'init') return;

          setTimeout(
            () =>
              this.onmessage?.({ data: { id: message.id, type: 'result' } }),
            30_000,
          );
        }
        terminate() {}
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new ClientDbWorker('wasm-url', 'worker-url');

    try {
      const initialized = db.init('https://example.com');
      await vi.advanceTimersByTimeAsync(LEADER_ELECTION_AND_STEAL_MS);
      await initialized;

      // One lock request, so nothing was stolen and nothing else held it.
      expect(request).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining('stealing OPFS lock'),
      );
      expect(db.initError?.message).toMatch(/has not finished opening/i);
      expect(db.initError?.message).not.toMatch(/another tab/i);

      // And it recovers on its own once the boot lands, without a reload.
      await vi.advanceTimersByTimeAsync(14_000);
      expect(db.initError).toBeUndefined();
      await expect(db.waitForReady()).resolves.toBe(true);
    } finally {
      db.destroy();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  // The budget this pins is not free: `send()` parks every caller on the init
  // promise, and `Store.hydrateFromLocalDb` runs before the server fetch, so
  // raising it to let a slow write through also blocks every read for the whole
  // boot. A class lookup then burns its three tries on its own 10s timeouts and
  // gives up for good, which renders a website as a bare property list.
  it('lets a read give up while its own boot drags on, rather than waiting it out', async () => {
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
    // A boot far longer than any budget here, so the read cannot be waiting on
    // anything but the park.
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: unknown) => void;
        postMessage(message: { id: string; type?: string }) {
          if (message.type !== 'init') return;

          setTimeout(
            () =>
              this.onmessage?.({ data: { id: message.id, type: 'result' } }),
            40_000,
          );
        }
        terminate() {}
      },
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new ClientDbWorker('wasm-url', 'worker-url');

    try {
      void db.init('https://example.com');
      const read = db.getResource('atomic:some-class');
      const settled = vi.fn();
      void read.then(settled, settled);

      await vi.advanceTimersByTimeAsync(16_000);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(read).rejects.toThrow(/ClientDb unavailable/);
    } finally {
      db.destroy();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('still names a real holder when the lock had to be stolen', async () => {
    vi.useFakeTimers();
    // A ghost leader: the lock is held, so our queued callback never runs and
    // no worker is ever spawned. The steal is ignored, as an engine without
    // `steal` support does.
    const request = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('navigator', { locks: { request } });
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage() {}
        close() {}
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new ClientDbWorker('wasm-url', 'worker-url');

    try {
      const initialized = db.init('https://example.com');
      await vi.advanceTimersByTimeAsync(LEADER_ELECTION_AND_STEAL_MS);
      await initialized;

      expect(request).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('stealing OPFS lock'),
      );
      expect(db.initError?.message).toMatch(/another tab/i);
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

describe('ClientDbWorker with a precompiled WebAssembly module', () => {
  it('hands the module to its worker instead of a url to fetch', async () => {
    const request = vi.fn((_name, _options, callback) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage() {}
        close() {}
      },
    );
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: unknown) => void;
        postMessage(message: { id: string } & Record<string, unknown>) {
          sent.push(message);
          queueMicrotask(() =>
            this.onmessage?.({ data: { id: message.id, type: 'result' } }),
          );
        }
        terminate() {}
      },
    );
    const compiled = { compiled: true } as unknown as WebAssembly.Module;
    const db = new ClientDbWorker('wasm-url', 'worker-url', {
      wasmModule: Promise.resolve(compiled),
    });

    try {
      await db.init('https://example.com');
      const init = sent.find(message => message.type === 'init');
      expect(init?.wasmModule).toBe(compiled);
    } finally {
      db.destroy();
      vi.unstubAllGlobals();
    }
  });
});
