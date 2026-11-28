import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { encodeB64 } from './base64.js';
import { NativeClientDb, type NativeChannel } from './client-db.native.js';
import type { ClientDbWorker } from './client-db.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { Resource } from './resource.js';
import { Store } from './store.js';
import { BLOB, INTERNAL_ID } from './urls.js';

const DRIVE = 'atomic:attachment-drive';
const SUBJECT = 'atomic:attachment-file';
const AGENT = 'atomic:agent:attachment-owner';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const CHUNKS = 'https://atomicdata.dev/properties/chunks';
const cleanups: Array<() => void> = [];
type Manifest = {
  files: Array<{ subject: string; hash: string; chunks: string[] }>;
};
type Evidence = {
  subject: string;
  version?: string;
  manifest?: Manifest;
  state: 'confirmed' | 'unknown';
  confirmedAt?: number;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Tests interpretation and lifecycle of backend proof. Actual hash validation
 * belongs to Rust producer tests; browser acceptance uses that real producer. */
async function fixture({ serverEnabled = false } = {}) {
  const resources = new Map<string, Resource>();
  const calls: string[][] = [];
  let answer: (subjects: string[]) => Promise<unknown> = async () => [];
  const channel: NativeChannel = {
    async call(method, args) {
      if (method === 'init') return true;
      if (method === 'outboxEntries') return [];

      if (method === 'getResourceAttachmentEvidence') {
        calls.push(args[0] as string[]);

        return answer(args[0] as string[]);
      }

      if (method === 'getResourcesWithSnapshots')
        return (args[0] as string[]).map(subject => {
          const resource = resources.get(subject);

          return {
            jsonAd: resource?.toClientDbJsonAd() ?? null,
            snapshot: resource
              ? encodeB64(resource.getLoroDoc()!.export({ mode: 'snapshot' }))
              : null,
          };
        });

      return null;
    },
  };
  const db = new NativeClientDb(channel);
  const agent = new Agent(
    new JSCryptoProvider(encodeB64(new Uint8Array(32).fill(1))),
    AGENT,
  );
  const store = new Store({
    serverUrl: 'https://embed.invalid',
    connect: false,
    noServer: !serverEnabled,
    agent,
  });
  store.setClientDb(db as unknown as ClientDbWorker);
  await db.waitForInit();

  async function add(subject: string, file = true) {
    const resource = new Resource(subject);
    resource.setStore(store);
    await resource.set(
      core.properties.isA,
      [file ? server.classes.file : server.classes.folder],
      false,
    );
    await resource.set('https://atomicdata.dev/properties/drive', DRIVE, false);
    await resource.set(core.properties.name, file ? 'Photo' : 'Folder', false);

    if (file) {
      await resource.set(BLOB, `atomic:blob:${HASH}`, false);
      await resource.set(INTERNAL_ID, HASH, false);
      await resource.set(server.properties.filename, 'photo.png', false);
    }

    resource.sealPendingEdits();
    resources.set(subject, resource);
    store.resources.set(subject, resource);

    return resource;
  }

  const resource = await add(SUBJECT);
  const manifest: Manifest = {
    files: [{ subject: SUBJECT, hash: HASH, chunks: [] }],
  };
  const proof = (target = resource, files = manifest): Evidence => ({
    subject: target.subject,
    version: encodeB64(target.getLoroDoc()!.oplogVersion().encode()),
    manifest: structuredClone(files),
    state: 'confirmed',
    confirmedAt: 100,
  });
  answer = async () => [proof()];
  let stop: (() => void) | undefined;
  const get = (target = resource) =>
    store.getResourceAttachmentSyncStatus(target);

  const watch = (target = resource) => {
    stop ??= store.subscribeResourceAttachmentSyncStatus(target, () => {});
  };

  const unsubscribe = () => {
    stop?.();
    stop = undefined;
  };

  const poll = async (target = resource) => {
    watch(target);
    await vi.advanceTimersByTimeAsync(2000);
  };

  const respond = (value: unknown) => {
    answer = async () => structuredClone(value);
  };

  const respondWith = (callback: (subjects: string[]) => Promise<unknown>) => {
    answer = callback;
  };

  cleanups.push(() => {
    unsubscribe();
    store.setClientDb(undefined);
  });

  return {
    store,
    db,
    agent,
    resource,
    manifest,
    proof,
    add,
    calls,
    get,
    watch,
    unsubscribe,
    poll,
    respond,
    respondWith,
  };
}

describe('exact resource attachment evidence', () => {
  it('keeps the peer watch when an attachment dependency changes', async () => {
    const h = await fixture();
    const child = await h.add('atomic:attached-file');
    const peerWatch = vi.spyOn(h.store, 'subscribeResourcePeerSyncStatus');
    const stop = h.store.subscribeResourceCopies(h.resource, () => {});
    cleanups.push(stop);
    expect(peerWatch).toHaveBeenCalledOnce();

    await h.resource.set(server.properties.attachments, [child.subject], false);
    h.resource.sealPendingEdits();

    expect(
      h.store.getResourceCopies(h.resource).contents.manifest?.files,
    ).toHaveLength(2);
    expect(peerWatch).toHaveBeenCalledOnce();
  });

  it('does no I/O in a read and keeps byte proof separate from resource details', async () => {
    const h = await fixture();
    expect(h.get().required).toBe(true);
    expect(h.get().local.state).not.toBe('confirmed');
    expect(h.calls).toHaveLength(0);
    await h.poll();
    expect(h.get()).toMatchObject({
      required: true,
      manifest: h.manifest,
      local: { state: 'confirmed' },
      server: { state: 'not-configured' },
    });
    expect(h.store.getResourceSyncStatus(h.resource).local.state).not.toBe(
      'confirmed',
    );
  });

  it('never treats saved metadata as evidence of missing or corrupt bytes', async () => {
    const h = await fixture();
    h.respond([{ subject: SUBJECT, state: 'unknown' }]);
    await h.store.persistState(
      h.db as unknown as ClientDbWorker,
      SUBJECT,
      h.resource.toClientDbRow()!,
    );
    expect(h.store.getResourceSyncStatus(h.resource).local.state).toBe(
      'unavailable',
    );
    await h.poll();
    expect(h.get().required).toBe(true);
    expect(h.get().local.state).not.toBe('confirmed');
  });

  it('retains verified contents across a rename without requiring the old metadata version', async () => {
    const h = await fixture();
    h.respond([h.proof()]);
    await h.poll();
    await h.resource.set(server.properties.filename, 'renamed.png', false);
    h.resource.sealPendingEdits();
    expect(h.get().local.state).toBe('confirmed');
    await h.poll();
    expect(h.get().local.state).toBe('confirmed');
  });

  it('invalidates a replaced hash immediately and accepts only its new exact manifest', async () => {
    const h = await fixture();
    h.respond([h.proof()]);
    await h.poll();
    await h.resource.set(BLOB, `atomic:blob:${OTHER_HASH}`, false);
    await h.resource.set(INTERNAL_ID, OTHER_HASH, false);
    expect(h.get().local.state).not.toBe('confirmed');
    h.resource.sealPendingEdits();
    await h.poll();
    expect(h.get().local.state).not.toBe('confirmed');
    h.respond([
      h.proof(h.resource, {
        files: [{ subject: SUBJECT, hash: OTHER_HASH, chunks: [] }],
      }),
    ]);
    await h.poll();
    expect(h.get().local.state).toBe('confirmed');
  });

  it('requires the ordered chunk list, not a partial or reordered manifest', async () => {
    const h = await fixture();
    await h.resource.set(
      CHUNKS,
      [`atomic:blob:${HASH}`, `atomic:blob:${OTHER_HASH}`],
      false,
    );
    h.resource.sealPendingEdits();
    const current = {
      files: [{ subject: SUBJECT, hash: HASH, chunks: [HASH, OTHER_HASH] }],
    };
    h.respond([
      h.proof(h.resource, {
        files: [{ subject: SUBJECT, hash: HASH, chunks: [HASH] }],
      }),
    ]);
    await h.poll();
    expect(h.get().local.state).not.toBe('confirmed');
    h.respond([h.proof(h.resource, current)]);
    await h.poll();
    expect(h.get().local.state).toBe('confirmed');
    await h.resource.set(
      CHUNKS,
      [`atomic:blob:${OTHER_HASH}`, `atomic:blob:${HASH}`],
      false,
    );
    expect(h.get().local.state).not.toBe('confirmed');
  });

  it('requires its own File and all direct attachments, including changed child hashes', async () => {
    const h = await fixture();
    const attached = await h.add('atomic:attached-file');
    await h.resource.set(
      server.properties.attachments,
      [attached.subject],
      false,
    );
    h.resource.sealPendingEdits();
    h.respond([h.proof()]);
    await h.poll();
    expect(h.get().local.state).not.toBe('confirmed');
    const manifest = {
      files: [
        { subject: attached.subject, hash: HASH, chunks: [] },
        { subject: SUBJECT, hash: HASH, chunks: [] },
      ].sort((a, b) => a.subject.localeCompare(b.subject)),
    };
    h.respond([h.proof(h.resource, manifest)]);
    await h.poll();
    expect(h.get().local.state).toBe('confirmed');
    await attached.set(BLOB, `atomic:blob:${OTHER_HASH}`, false);
    await attached.set(INTERNAL_ID, OTHER_HASH, false);
    expect(h.get().local.state).not.toBe('confirmed');
  });

  it('does not call unresolved attachment references an empty manifest', async () => {
    const h = await fixture();
    const folder = await h.add('atomic:folder', false);
    await folder.set(
      server.properties.attachments,
      ['atomic:missing-file'],
      false,
    );
    folder.sealPendingEdits();
    h.respond([{ subject: folder.subject, state: 'unknown' }]);
    await h.poll(folder);
    expect(h.get(folder).required).toBe(true);
    expect(h.get(folder).local.state).not.toBe('confirmed');
  });

  it('leaves an unsupported URL-only File unconfirmed', async () => {
    const h = await fixture();
    h.resource.removeUnsafe(BLOB);
    h.resource.removeUnsafe(INTERNAL_ID);
    await h.resource.set(
      server.properties.downloadUrl,
      'https://external.invalid/photo.png',
      false,
    );
    h.respond([{ subject: SUBJECT, state: 'unknown' }]);
    await h.poll();
    expect(h.get().required).toBe(true);
    expect(h.get().local.state).not.toBe('confirmed');
  });

  it('clears byte proof when a fresh backend verification loses it', async () => {
    const h = await fixture();
    await h.poll();
    expect(h.get().local.state).toBe('confirmed');
    h.respond([{ subject: SUBJECT, state: 'unknown' }]);
    await h.poll();
    expect(h.get().local.state).not.toBe('confirmed');
  });

  for (const changed of ['agent', 'database'] as const) {
    it(`ignores a late positive verification across ${changed} A→B→A`, async () => {
      const h = await fixture();
      const old = h.proof();
      let release!: (value: unknown) => void;
      h.respondWith(
        () =>
          new Promise(resolve => {
            release = resolve;
          }),
      );
      h.watch();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.length).toBeGreaterThan(0);
      h.respond([{ subject: SUBJECT, state: 'unknown' }]);

      if (changed === 'agent') {
        h.store.setAgent(undefined);
        h.store.setAgent(h.agent);
      } else {
        h.store.setClientDb(undefined);
        h.store.setClientDb(h.db as unknown as ClientDbWorker);
      }

      release([old]);
      await h.poll();
      expect(h.get().local.state).not.toBe('confirmed');
    });
  }

  it('retains local and server history across unmount and failed offline refresh', async () => {
    const h = await fixture({ serverEnabled: true });
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify([h.proof()])),
    );
    h.store.injectFetch(fetcher);
    await h.poll();
    expect(h.get().local.state).toBe('confirmed');
    expect(h.get().server.state).toBe('confirmed');
    h.unsubscribe();
    h.respondWith(async () => {
      throw new Error('Offline storage query');
    });
    fetcher.mockImplementation(async () => {
      throw new Error('Offline server');
    });
    h.watch();
    expect(h.get().local.state).toBe('confirmed');
    expect(h.get().server.state).toBe('confirmed');
    await h.poll();
    expect(h.get().server.state).toBe('confirmed');
    h.unsubscribe();
    await h.resource.set(BLOB, `atomic:blob:${OTHER_HASH}`, false);
    await h.resource.set(INTERNAL_ID, OTHER_HASH, false);
    h.watch();
    expect(h.get().local.state).toBe('pending');
    expect(h.get().server.state).toBe('pending');
  });

  it.each(['agent', 'database'] as const)(
    'invalidates retained history across unobserved %s A→B→A',
    async changed => {
      const h = await fixture();
      await h.poll();
      expect(h.get().local.state).toBe('confirmed');
      h.unsubscribe();

      if (changed === 'agent') {
        h.store.setAgent(undefined);
        h.store.setAgent(h.agent);
      } else {
        h.store.setClientDb(undefined);
        h.store.setClientDb(h.db as unknown as ClientDbWorker);
      }

      h.respondWith(async () => {
        throw new Error('No fresh proof');
      });
      h.watch();
      expect(h.get().local.state).not.toBe('confirmed');
      await h.poll();
      expect(h.get().local.state).not.toBe('confirmed');
    },
  );

  it('does not reuse proof in a fresh renderer before durable re-verification', async () => {
    const first = await fixture();
    await first.poll();
    expect(first.get().local.state).toBe('confirmed');
    first.unsubscribe();
    const reloaded = await fixture();
    reloaded.respond([{ subject: SUBJECT, state: 'unknown' }]);
    expect(reloaded.get().local.state).not.toBe('confirmed');
    await reloaded.poll();
    expect(reloaded.get().local.state).not.toBe('confirmed');
  });
  it('requires an authenticated exact-manifest HTTP response, independently of local proof', async () => {
    const h = await fixture({ serverEnabled: true });
    h.respond([{ subject: SUBJECT, state: 'unknown' }]);
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify([h.proof()]), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    h.store.injectFetch(fetcher);
    await h.poll();
    expect(h.get().server.state).toBe('confirmed');
    expect(h.get().local.state).not.toBe('confirmed');
    const [url, request] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://embed.invalid/attachment-evidence');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(request?.body as string)).toEqual({
      subjects: [SUBJECT],
    });
    const headers = new Headers(request?.headers);
    expect(headers.get('x-atomic-signature-version')).toBe('2');
    expect(headers.get('x-atomic-agent')).toBe(AGENT);
    expect(headers.get('x-atomic-signature')).toBeTruthy();
    fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify([{ subject: SUBJECT, state: 'unknown' }])),
    );
    await h.poll();
    expect(h.get().server.state).not.toBe('confirmed');
  });

  for (const failure of ['unsupported', 'error', 'malformed'] as const) {
    it(`retains historical evidence on ${failure} verification`, async () => {
      const h = await fixture();
      await h.poll();
      expect(h.get().local.state).toBe('confirmed');
      if (failure === 'error')
        h.respondWith(async () => {
          throw new Error('Storage read failed');
        });
      else
        h.respond(
          failure === 'unsupported'
            ? undefined
            : [
                {
                  ...h.proof(),
                  manifest: {
                    files: [{ subject: SUBJECT, hash: 'wrong', chunks: [] }],
                  },
                },
              ],
        );
      await h.poll();
      expect(h.get().local).toMatchObject({
        state: 'confirmed',
        confirmedAt: 100,
      });
    });
  }

  it('binds peer byte proof to the storage identity and retains history on departure', async () => {
    const h = await fixture();
    const source = { storageId: '1'.repeat(64), generation: '2'.repeat(64) };
    const replica = { storageId: '3'.repeat(64), generation: '4'.repeat(64) };
    const close = h.store.registerResourcePeerSession(
      'browser',
      DRIVE,
      'atomic:agent:peer',
    );
    const proof = h.proof();
    h.store.acknowledgeResourcePeerReceipt({
      subject: SUBJECT,
      drive: DRIVE,
      version: proof.version!,
      confirmedAt: Date.now(),
      connectionId: 'browser',
      peerAgent: 'atomic:agent:peer',
      source,
      replica,
    });
    const contentProof = {
      subject: SUBJECT,
      version: proof.version!,
      manifest: h.manifest,
      confirmedAt: Date.now(),
      connectionId: 'browser',
      source,
      replica,
    };
    expect(h.store.getResourcePeerSyncStatus(h.resource).confirmedCount).toBe(
      1,
    );
    expect(h.get().peers[0].state).not.toBe('confirmed');
    h.store.acknowledgeResourceAttachmentReceipt({
      ...contentProof,
      replica: { ...replica, generation: '5'.repeat(64) },
    });
    expect(h.get().peers[0].state).not.toBe('confirmed');
    h.store.acknowledgeResourceAttachmentReceipt({
      ...contentProof,
      confirmedAt: Date.now(),
    });
    expect(h.get().peers[0].state).toBe('confirmed');
    close();
    h.store.acknowledgeResourceAttachmentReceipt({
      ...contentProof,
      confirmedAt: Date.now(),
    });
    expect(h.get().peers[0].state).toBe('confirmed');
    expect(h.store.getResourcePeerSyncStatus(h.resource).connectedCount).toBe(
      0,
    );
  });
  it('does not revive parent contents from a delayed query after child eviction and identical recreation', async () => {
    const h = await fixture();
    const child = await h.add('atomic:attached-file');
    await h.resource.set(server.properties.attachments, [child.subject], false);
    h.resource.sealPendingEdits();
    const manifest = {
      files: [
        { subject: child.subject, hash: HASH, chunks: [] },
        { subject: SUBJECT, hash: HASH, chunks: [] },
      ].sort((a, b) => a.subject.localeCompare(b.subject)),
    };
    const old = h.proof(h.resource, manifest);
    h.respond([old]);
    await h.poll();
    expect(h.get().local.state).toBe('confirmed');
    let release!: (value: unknown) => void;
    h.respondWith(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    await h.poll();
    h.store.evictResource(child.subject, false);
    expect(h.get().local.state).not.toBe('confirmed');
    h.store.resources.set(child.subject, child);
    h.respond([{ subject: SUBJECT, state: 'unknown' }]);
    release([old]);
    await h.poll();
    expect(h.get().local.state).not.toBe('confirmed');
  });

  it('reports no required contents only for a resolved empty manifest', async () => {
    const h = await fixture();
    const folder = await h.add('atomic:empty-folder', false);
    expect(h.get(folder).required).toBe(false);
    expect(h.get(folder).manifest).toEqual({ files: [] });
  });
  it('does not turn elapsed time into evidence of byte loss', async () => {
    const h = await fixture();
    h.watch();
    const source = { storageId: '1'.repeat(64), generation: '2'.repeat(64) };
    const replica = { storageId: '3'.repeat(64), generation: '4'.repeat(64) };
    const close = h.store.registerResourcePeerSession(
      'live-peer',
      DRIVE,
      'atomic:agent:peer',
    );
    cleanups.push(close);
    const proof = h.proof();
    h.store.acknowledgeResourcePeerReceipt({
      subject: SUBJECT,
      drive: DRIVE,
      version: proof.version!,
      confirmedAt: Date.now(),
      connectionId: 'live-peer',
      peerAgent: 'atomic:agent:peer',
      source,
      replica,
    });
    const content = {
      subject: SUBJECT,
      version: proof.version!,
      manifest: h.manifest,
      confirmedAt: Date.now(),
      connectionId: 'live-peer',
      source,
      replica,
    };
    h.store.acknowledgeResourceAttachmentReceipt(content);
    expect(h.get().peers[0].state).toBe('confirmed');
    // A silent peer supplies no new evidence about retention. Keep its
    // original observation time while normal refresh timers run.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.store.getResourcePeerSyncStatus(h.resource)).toMatchObject({
      state: 'confirmed',
      confirmedCount: 1,
    });
    expect(h.get().peers[0].state).toBe('confirmed');
    // A delayed replay cannot renew the observation time.
    const confirmedAt = h.get().peers[0].confirmedAt;
    h.store.acknowledgeResourceAttachmentReceipt(content);
    expect(h.get().peers[0].confirmedAt).toBe(confirmedAt);
    h.store.acknowledgeResourceAttachmentReceipt({
      ...content,
      confirmedAt: Date.now(),
    });
    expect(h.get().peers[0].state).toBe('confirmed');
  });
});
