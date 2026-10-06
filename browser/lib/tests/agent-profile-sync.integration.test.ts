/**
 * A rename must reach a server that only ever received the agent's drive.
 *
 * The profile is written on server A, then the same browser works against
 * server B, which auto-creates a bare agent stub on the first commit. The first
 * rename is refused there (it depends on ops B never had); the outbox retries
 * with a self-contained snapshot, which B can merge. This pins that recovery.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer, type ServerHandle } from './server-fixture.js';
import { Agent } from '../src/agent.js';
import { JSCryptoProvider } from '../src/CryptoProvider.js';
import { Store } from '../src/store.js';
import { NodeClientDb } from '../src/client-db.node.js';
import type { ClientDbWorker } from '../src/client-db.js';
import { core } from '../src/ontologies/core.js';
import { server as serverOnt } from '../src/ontologies/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');

async function storeFor(url: string, agent: Agent): Promise<Store> {
  const clientDb = new NodeClientDb({ wasmPath, baseUrl: url });
  await clientDb.init();
  const store = new Store({ serverUrl: url, agent });
  store.setClientDb(clientDb as unknown as ClientDbWorker);
  await delay(500);

  return store;
}

async function nameOn(url: string, viewer: Agent, subject: string) {
  const store = await storeFor(url, viewer);
  const resource = await store.getResource(subject);

  return resource.get(core.properties.name);
}

describe('agent profile across servers', () => {
  let a: ServerHandle;
  let b: ServerHandle;

  beforeAll(async () => {
    [a, b] = await Promise.all([startServer(), startServer()]);
  }, 180_000);

  afterAll(async () => {
    await a?.stop();
    await b?.stop();
  });

  it('shows the owner name and renames on a server that only got the drive', async () => {
    const keys = await Agent.generateKeyPair();
    const owner = new Agent(
      new JSCryptoProvider(keys.privateKey),
      `did:ad:agent:${keys.publicKey}`,
    );
    const viewer = await Agent.fromSecret(a.agentSecret);

    // The owner's profile is written on server A.
    const storeA = await storeFor(a.serverUrl, owner);
    const home = await storeA.ensurePrivateDrive('Owner home', {
      agentName: 'Old name',
    });
    expect(home.error).toBeUndefined();
    await delay(1500);
    expect(await nameOn(a.serverUrl, viewer, owner.subject!)).toBe('Old name');

    // The same browser then works against server B, which has never seen the
    // agent resource.
    storeA.setServerUrl(b.serverUrl, { connect: true });
    await delay(1000);
    const driveOnB = await storeA.newResource({
      isA: serverOnt.classes.drive,
      noParent: true,
      propVals: {
        [core.properties.name]: 'Team drive',
        [core.properties.write]: [owner.subject],
        [core.properties.read]: [owner.subject],
      },
    });
    await driveOnB.save();

    const agentResource = await storeA.getResource(owner.subject!);
    await agentResource.set(core.properties.name, 'New name');
    await agentResource.save().catch(() => undefined);
    await delay(12_000);

    const viewerB = await Agent.fromSecret(b.agentSecret);
    expect(await nameOn(b.serverUrl, viewerB, owner.subject!)).toBe('New name');
  }, 120_000);
});
