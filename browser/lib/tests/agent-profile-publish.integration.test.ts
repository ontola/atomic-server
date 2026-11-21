/**
 * The owner's profile must reach a node that hosts one of their drives.
 *
 * Onboarding on a node-less origin keeps the agent resource (name, picture)
 * local-only, next to the drive. When that drive is later hosted on a node the
 * drive is promoted, but the agent resource used to stay behind, so a second
 * device and every collaborator on the hosted drive saw no name.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer, type ServerHandle } from './server-fixture.js';
import { LoroDoc } from 'loro-crdt';
import { Agent } from '../src/agent.js';
import { JSCryptoProvider } from '../src/CryptoProvider.js';
import { Store } from '../src/store.js';
import { NodeClientDb } from '../src/client-db.node.js';
import type { ClientDbWorker } from '../src/client-db.js';
import { core } from '../src/ontologies/core.js';
import { agentPublicKey, agentSubject } from '../src/subject.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');
const openStores: Store[] = [];

async function nameOnServer(
  url: string,
  viewer: Agent,
  subject: string,
  expected: string,
  wallMs = 20_000,
) {
  const store = new Store({ serverUrl: url, agent: viewer, connect: false });
  openStores.push(store);
  const deadline = Date.now() + wallMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      last = (await store.readServerSnapshot(subject))[core.properties.name];
      if (last === expected) return last;
    } catch (e) {
      last = `read failed: ${String(e)}`;
    }

    await delay(500);
  }

  return last;
}

describe('agent profile and a hosted drive', () => {
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

  async function deviceOne(name: string) {
    const keys = await Agent.generateKeyPair();
    const did = agentSubject(
      await new JSCryptoProvider(keys.privateKey).getPublicKey(),
    );
    const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);
    const clientDb = new NodeClientDb({ wasmPath, baseUrl: node.serverUrl });
    await clientDb.init();
    const store = new Store({ serverUrl: node.serverUrl, agent });
    store.setClientDb(clientDb as unknown as ClientDbWorker);
    openStores.push(store);
    await store.waitForServerConnected(10_000);
    for (let i = 0; i < 50 && store.getDefaultWebSocket()?.readyState !== 1; i++)
      await delay(100);

    // Onboarding on an origin without a node: everything stays local.
    store.registerLocalOnlyDrive(did);
    const profile = store.getResourceLoading(did, { newResource: true });
    await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    await profile.set(core.properties.isA, [core.classes.agent]);
    await profile.set(core.properties.name, name);
    await profile.save();
    const drive = await store.createDrive(`${name}'s drive`, {
      localOnly: true,
    });

    return { store, did, agent, drive };
  }

  it('never replaces a local profile with the node\'s bare agent document', async () => {
    const keys = await Agent.generateKeyPair();
    const did = agentSubject(
      await new JSCryptoProvider(keys.privateKey).getPublicKey(),
    );
    const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);

    // Another client (a second device) made the node create its bare agent.
    const second = new Store({ serverUrl: node.serverUrl, agent });
    openStores.push(second);
    await second.waitForServerConnected(10_000);
    const bare = await second.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
      propVals: {
        [core.properties.name]: 'Bare',
        [core.properties.write]: [did],
        [core.properties.read]: [did],
      },
    });
    await bare.save();
    await delay(500);
    const viewer = await Agent.fromSecret(node.agentSecret);
    const onNode = new Store({
      serverUrl: node.serverUrl,
      agent: viewer,
      connect: false,
    });
    openStores.push(onNode);
    expect((await onNode.readServerSnapshot(did))[core.properties.name]).toBe(
      undefined,
    );

    // Device one holds the real profile locally and then talks to the node.
    const clientDb = new NodeClientDb({ wasmPath, baseUrl: node.serverUrl });
    await clientDb.init();
    const store = new Store({ serverUrl: node.serverUrl, agent });
    store.setClientDb(clientDb as unknown as ClientDbWorker);
    openStores.push(store);
    await store.waitForServerConnected(10_000);
    store.registerLocalOnlyDrive(did);
    const profile = store.getResourceLoading(did, { newResource: true });
    await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    await profile.set(core.properties.isA, [core.classes.agent]);
    await profile.set(core.properties.name, 'Kim Local');
    await profile.save();
    await delay(300);
    await clientDb.flush();
    store.unregisterLocalOnlyDrive(did);
    const before = new LoroDoc();
    before.import((await clientDb.getLoroSnapshot(did))!);

    // A reload: a cold store over the same local database, drive hosted.
    const reloaded = new Store({ serverUrl: node.serverUrl, agent });
    reloaded.setClientDb(clientDb as unknown as ClientDbWorker);
    openStores.push(reloaded);
    await reloaded.waitForServerConnected(10_000);
    await reloaded.getResource(did);
    await reloaded.fetchResourceFromServer(did);
    await reloaded.reloadResource(did);
    await delay(1500);
    await clientDb.flush();

    expect(reloaded.getResourceLoading(did).get(core.properties.name)).toBe(
      'Kim Local',
    );
    expect(await clientDb.getResource(did)).toContain('Kim Local');
    // The history survived, not just the value: a profile rebuilt from its
    // current values under a new peer cannot merge with the original later.
    const after = new LoroDoc();
    after.import((await clientDb.getLoroSnapshot(did))!);
    expect(before.version().compare(after.version())).toBeLessThanOrEqual(0);
  }, 120_000);

  it('keeps a profile with history when a full snapshot of a bare agent arrives', async () => {
    const keys = await Agent.generateKeyPair();
    const did = agentSubject(
      await new JSCryptoProvider(keys.privateKey).getPublicKey(),
    );
    const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);
    const clientDb = new NodeClientDb({ wasmPath, baseUrl: node.serverUrl });
    await clientDb.init();
    const store = new Store({ serverUrl: node.serverUrl, agent });
    store.setClientDb(clientDb as unknown as ClientDbWorker);
    openStores.push(store);
    await store.waitForServerConnected(10_000);
    store.registerLocalOnlyDrive(did);
    const profile = store.getResourceLoading(did, { newResource: true });
    await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    await profile.set(core.properties.isA, [core.classes.agent]);
    await profile.set(core.properties.name, 'Lee Local');
    await profile.save();
    await delay(300);
    await clientDb.flush();
    store.unregisterLocalOnlyDrive(did);
    const before = new LoroDoc();
    before.import((await clientDb.getLoroSnapshot(did))!);

    // What the node sends for the agent it made itself: its own document,
    // flagged as a full snapshot (a GET answer or a SYNC push).
    const stub = new LoroDoc();
    const props = stub.getMap('properties');
    props.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    props.set(core.properties.read, 'https://atomicdata.dev/agents/publicAgent');
    stub.commit();
    store.applyIncoming({
      subject: did,
      loroBytes: stub.export({ mode: 'snapshot' }),
      source: 'ws-pending-get',
      replaceLoroDocsFromRemote: true,
    });
    await delay(500);
    await clientDb.flush();

    expect(store.getResourceLoading(did).get(core.properties.name)).toBe(
      'Lee Local',
    );
    const after = new LoroDoc();
    after.import((await clientDb.getLoroSnapshot(did))!);
    expect(before.version().compare(after.version())).toBeLessThanOrEqual(0);
  }, 60_000);

  it('publishes the profile when the drive is hosted on the node', async () => {
    const { store, did, drive } = await deviceOne('Ivy Hosted');

    await store.syncDriveToServerAndVerify(drive.subject);

    const viewer = await Agent.fromSecret(node.agentSecret);
    expect(await nameOnServer(node.serverUrl, viewer, did, 'Ivy Hosted')).toBe(
      'Ivy Hosted',
    );
  }, 120_000);

  it('heals a node that holds a name-less agent from another device', async () => {
    const { store, did, agent, drive } = await deviceOne('Jo Healed');
    await store.syncDriveToServerAndVerify(drive.subject);
    const viewer = await Agent.fromSecret(node.agentSecret);
    await nameOnServer(node.serverUrl, viewer, did, 'Jo Healed');

    // A second device wrote its own agent document (no name) over the node's
    // copy before device one ever pushed: simulate by a fresh node + stub.
    const other = await startServer();

    try {
      const second = new Store({ serverUrl: other.serverUrl, agent });
      openStores.push(second);
      await second.waitForServerConnected(10_000);
      const stub = second.getResourceLoading(did, { newResource: true });
      await stub.set(core.properties.publicKey, agentPublicKey(did) ?? '');
      await stub.set(core.properties.isA, [core.classes.agent]);
      await stub.save();

      // Device one, next session: its drive is already hosted, its agent is
      // still registered local-only, and it now talks to that node.
      const clientDb = new NodeClientDb({
        wasmPath,
        baseUrl: other.serverUrl,
      });
      await clientDb.init();
      const rejoin = new Store({ serverUrl: other.serverUrl, agent });
      rejoin.setClientDb(clientDb as unknown as ClientDbWorker);
      openStores.push(rejoin);
      rejoin.registerLocalOnlyDrive(did);
      const profile = rejoin.getResourceLoading(did, { newResource: true });
      await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
      await profile.set(core.properties.isA, [core.classes.agent]);
      await profile.set(core.properties.name, 'Jo Healed');
      await profile.save();
      await rejoin.waitForServerConnected(10_000);
      // The connection that opens a session.
      await rejoin.publishAgentProfile();

      const otherViewer = await Agent.fromSecret(other.agentSecret);
      const otherStore = new Store({ serverUrl: other.serverUrl, agent: otherViewer, connect: false });
      openStores.push(otherStore);
      expect(
        await nameOnServer(other.serverUrl, otherViewer, did, 'Jo Healed'),
      ).toBe('Jo Healed');
      // Merged, not replaced: the other device's own ops are still there.
      const merged = await otherStore.readServerSnapshot(did);
      expect(merged[core.properties.publicKey]).toBe(agentPublicKey(did));
    } finally {
      for (const s of openStores) s.disconnect();
      await delay(300);
      await other.stop();
    }
  }, 180_000);
});
