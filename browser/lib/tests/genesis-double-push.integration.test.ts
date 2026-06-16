/**
 * Reproduces the dagger-CI symptom:
 *
 *     Commit for did:ad:... has is_genesis: true, but the resource
 *     already exists.
 *
 * Root cause hypothesis: when the WebSocket reconnects twice in quick
 * succession (which dagger's slow single-core actix container makes
 * common), `WSClient.handleOpen` fires `Store.syncDirtyResources` twice
 * in parallel. Each call iterates the dirty subjects and reaches:
 *
 *     if (resource.hasUnsavedChanges()) await resource.save();
 *     else                              await resource.pushCommits();
 *
 * `save()` has a `hasQueue` guard (via `inProgressCommit`), so two
 * parallel `save()`s on the same resource serialise. `pushCommits()`
 * has no such guard — both invocations enter the
 * `while (this._pendingCommits.length > 0)` loop, both read
 * `pendingCommits[0]`, both `await postCommit()`. The first POST
 * creates the resource server-side; the second POST fails with the
 * "is_genesis: true, but resource already exists" error.
 *
 * The repro below skips the WebSocket layer entirely. It manually
 * queues a genesis commit (mimicking the offline → reconnect path),
 * then calls `pushCommits()` twice in parallel against the real
 * server's `/commit` endpoint and checks how many POSTs the server
 * actually rejected. Without the fix this fails with the genesis
 * already-exists error coming back from the second push.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer, type ServerHandle } from './server-fixture.js';
import { Agent } from '../src/agent.js';
import { Store } from '../src/store.js';
import { NodeClientDb } from '../src/client-db.node.js';
import type { ClientDbWorker } from '../src/client-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');

describe('parallel pushCommits race on genesis commits', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('two parallel pushCommits() calls on a queued genesis commit must not double-POST', async () => {
    const agent = await Agent.fromSecret(server.agentSecret);

    const clientDb = new NodeClientDb({
      wasmPath,
      baseUrl: server.serverUrl,
    });
    await clientDb.init();

    const store = new Store({ serverUrl: server.serverUrl, agent });
    store.setClientDb(clientDb as unknown as ClientDbWorker);

    // Let WS handshake settle (we won't use WS for the actual race,
    // but the resource subscribe path may try to use it).
    await delay(300);

    const drive = server.initialDrive ?? `${server.serverUrl}/`;

    // Count `/commit` POSTs at the HTTP layer. The race is "two
    // pushCommits both fire postCommit", so we instrument fetch.
    const realFetch = globalThis.fetch.bind(globalThis);
    let commitPostCount = 0;
    let alreadyExistsCount = 0;
    store.injectFetch((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === 'string' ? input : (input as Request | URL).toString();

      if (url.endsWith('/commit') && init?.method === 'POST') {
        commitPostCount++;
        // Add a small delay so the second parallel push has a chance
        // to enter the while-loop before the first's POST resolves.
        // Without this delay the race window is too small to repro
        // reliably under Node's single-threaded scheduler.
        await delay(80);
        const res = await realFetch(input as RequestInfo, init);

        if (!res.ok) {
          const body = await res.clone().text();

          if (body.includes('but the resource already exists')) {
            alreadyExistsCount++;
          }
        }

        return res;
      }

      return realFetch(input as RequestInfo, init);
    }) as typeof fetch);

    // Build a brand-new DID-eligible resource. `store.newResource` with
    // `did: true` does the placeholder + properties + initial signChanges
    // dance for us, and crucially does NOT push — the signed genesis
    // commit is sitting in `_pendingCommits` waiting for a `pushCommits`
    // / `save` call.
    const resource = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Folder',
      parent: drive,
      did: true,
      propVals: {
        'https://atomicdata.dev/properties/name': 'parallel-push race repro',
      },
    });

    // Confirm the resource really has a queued genesis commit before we
    // race it — without this we could be testing "two pushes against an
    // empty queue both no-op" which is uninteresting.
    expect(resource.hasPendingCommits, 'resource must have a queued genesis commit').toBe(true);

    // The signed genesis commit is now sitting in resource._pendingCommits.
    // Mirror what `syncDirtyResources` does on a re-entrant call: invoke
    // pushCommits() twice in parallel. Both should resolve to the same
    // server-recorded commit and only one /commit POST should reach the
    // server (the second call should observe the empty queue or wait on
    // the first).
    const [a, b] = await Promise.allSettled([
      resource.pushCommits(),
      resource.pushCommits(),
    ]);

    // Diagnostic dump on failure so the next reader knows what to look at.
    const summary = {
      commitPostCount,
      alreadyExistsCount,
      resultA: a.status === 'fulfilled' ? a.value : (a.reason as Error).message,
      resultB: b.status === 'fulfilled' ? b.value : (b.reason as Error).message,
    };

    expect(
      alreadyExistsCount,
      `server rejected at least one duplicate genesis: ${JSON.stringify(summary)}`,
    ).toBe(0);
    expect(
      commitPostCount,
      `expected exactly one /commit POST, got ${commitPostCount}: ${JSON.stringify(summary)}`,
    ).toBe(1);

    store.disconnect();
  }, 60_000);
});
