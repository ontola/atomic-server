/**
 * A profile picture is a File whose parent is the agent's own resource, like
 * the profile header does it. The File must reach the node that holds the
 * agent's drive, or every other device sees an icon pointing at nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer, type ServerHandle } from './server-fixture.js';
import { Agent } from '../src/agent.js';
import { JSCryptoProvider } from '../src/CryptoProvider.js';
import { Store } from '../src/store.js';
import { fileClientDb, disposeFileClientDbs } from './file-client-db.js';
import type { ClientDbWorker } from '../src/client-db.js';
import { core } from '../src/ontologies/core.js';
import { server as serverOnt } from '../src/ontologies/server.js';
import { agentPublicKey, agentSubject } from '../src/subject.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');
const openStores: Store[] = [];

describe('profile picture upload', () => {
  let node: ServerHandle;

  beforeAll(async () => {
    node = await startServer();
  }, 180_000);

  afterAll(async () => {
    for (const store of openStores) {
      store.disconnect();
      store.setServerConnected(false);
    }

    await delay(300);
    await node?.stop();
  });

  async function filesOnServer(agent: Agent, file: string) {
    const viewer = new Store({
      serverUrl: node.serverUrl,
      agent,
      connect: false,
    });
    openStores.push(viewer);
    const deadline = Date.now() + 20_000;
    let last: Record<string, unknown> = {};

    while (Date.now() < deadline) {
      try {
        last = await viewer.readServerSnapshot(file);
        if (last[serverOnt.properties.downloadUrl]) return last;
      } catch (e) {
        last = { error: String(e) };
      }

      await delay(500);
    }

    return last;
  }

  for (const hosted of [true, false]) {
    it(`the File reaches the server (profile ${hosted ? 'hosted' : 'was local-only first'})`, async () => {
      const keys = await Agent.generateKeyPair();
      const did = agentSubject(
        await new JSCryptoProvider(keys.privateKey).getPublicKey(),
      );
      const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);
      const clientDb = fileClientDb({ wasmPath, baseUrl: node.serverUrl });
      await clientDb.init();
      const store = new Store({ serverUrl: node.serverUrl, agent });
      store.setClientDb(clientDb as unknown as ClientDbWorker);
      openStores.push(store);
      await store.waitForServerConnected(10_000);

      if (!hosted) store.registerLocalOnlyDrive(did);

      const profile = store.getResourceLoading(did, { newResource: true });
      await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
      await profile.set(core.properties.isA, [core.classes.agent]);
      await profile.set(core.properties.name, 'Pat');
      await profile.save();
      await store.ensurePrivateDrive();

      const png = new File([new Uint8Array([1, 2, 3, 4, 5])], 'me.png', {
        type: 'image/png',
      });
      const [file] = await store.uploadFiles([png], did);
      profile.set('https://atomicdata.dev/properties/icon', file);
      await profile.save();

      if (!hosted) {
        await store.publishAgentProfile();
      }

      const onServer = await filesOnServer(agent, file);
      expect(onServer[serverOnt.properties.downloadUrl]).toBeTruthy();
      expect(onServer[serverOnt.properties.mimetype]).toBe('image/png');
      expect(onServer[serverOnt.properties.filesize]).toBe(5);
    }, 90_000);
  }
});

afterAll(disposeFileClientDbs);
