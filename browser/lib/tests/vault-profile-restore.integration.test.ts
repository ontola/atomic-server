/**
 * The person's profile must come back with a Cloud Vault restore.
 *
 * Device 1 signs up, types a name, and gets a private drive. The profile lives
 * on the agent resource, which is nobody's child, so the vault export only
 * carries it because the drive grants the agent `read`/`write`. This runs the
 * browser's real order of events with a real (in-memory) wasm ClientDb on both
 * devices and no server: it is exactly the hosted, node-less case, where the
 * backup is the only way the profile can reach device 2.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
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
import { conversations } from '../src/ontologies/conversations.js';
import { agentPublicKey, agentSubject } from '../src/subject.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');
const SERVER = 'http://localhost:9899';
const PSEUDONYM = 'profile-restore-test';
const DEVICE = '03'.repeat(32);

const openStores: Store[] = [];

async function deviceFor(agent: Agent) {
  const clientDb = new NodeClientDb({ wasmPath, baseUrl: SERVER });
  await clientDb.init();
  const store = new Store({ serverUrl: SERVER, agent, connect: false });
  store.setClientDb(clientDb as unknown as ClientDbWorker);
  openStores.push(store);

  return { store, clientDb };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw = (clientDb: NodeClientDb): any => (clientDb as any).db;

describe('Cloud Vault restore and the agent profile', () => {
  afterAll(async () => {
    for (const store of openStores) store.disconnect();
    await delay(200);
  });

  it('brings the name typed on the first device to the second', async () => {
    const keys = await Agent.generateKeyPair();
    const did = agentSubject(
      await new JSCryptoProvider(keys.privateKey).getPublicKey(),
    );
    const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);

    // Device 1, as NewIdentitySection does it on the hosted origin.
    const one = await deviceFor(agent);
    one.store.registerLocalOnlyDrive(did);
    const profile = one.store.getResourceLoading(did, { newResource: true });
    await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    await profile.set(core.properties.isA, [core.classes.agent]);
    await profile.set(core.properties.name, 'Alice Returning');
    await profile.save();
    const drive = await one.store.createDrive("Alice Returning's Drive");
    await one.store.flushPendingClientDbWrites?.();
    await delay(300);
    await one.clientDb.flush();

    const stored = await one.clientDb.getResource(did);
    expect(stored, 'device 1 local database holds the profile').toContain(
      'Alice Returning',
    );

    const key = new Uint8Array(32).fill(7);
    const out = await raw(one.clientDb).vaultExport(
      drive.subject,
      key,
      1,
      PSEUDONYM,
      DEVICE,
      1,
      1n,
      false,
      undefined,
      undefined,
    );
    expect(out, 'the drive has something to back up').not.toBeNull();

    // Device 2: a fresh database, the vault is all it has.
    const two = await deviceFor(agent);
    // The sidebar looked the profile up before the restore: nothing there yet.
    two.store.setServerConnected(true);
    // A bare stub, as a node or an earlier sign-in leaves behind.
    await two.clientDb.putResource(
      JSON.stringify({
        '@id': did,
        [core.properties.isA]: [core.classes.agent],
        [core.properties.publicKey]: agentPublicKey(did),
      }),
    );
    const before = await two.store.getResource(did);
    expect(before.get(core.properties.name)).toBeUndefined();
    await raw(two.clientDb).vaultImport(key, 1, PSEUDONYM, DEVICE, [
      { objectKey: out.objectKey, sealed: out.sealed },
    ]);

    const restored = await two.clientDb.getResource(did);
    expect(restored, 'the restored database holds the profile').toContain(
      'Alice Returning',
    );

    // What `reopenRestoredDrive` does once the restore has landed.
    await two.store.reloadResource(did);
    const afterRestore = await two.store.getResource(did);
    expect(afterRestore.get(core.properties.name)).toBe('Alice Returning');
  }, 60_000);

  it.each([
    ['the current spelling', (pk: string) => `atomic:agent:${pk}`],
    ['the legacy spelling', (pk: string) => `did:ad:agent:${pk}`],
  ])('reads the restored profile under %s of the agent subject', async (_n, spell) => {
    const keys = await Agent.generateKeyPair();
    const pk = await new JSCryptoProvider(keys.privateKey).getPublicKey();
    const did = agentSubject(pk);
    const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);

    const one = await deviceFor(agent);
    one.store.registerLocalOnlyDrive(did);
    const profile = one.store.getResourceLoading(did, { newResource: true });
    await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    await profile.set(core.properties.isA, [core.classes.agent]);
    await profile.set(core.properties.name, 'Dana Returning');
    await profile.save();
    const drive = await one.store.createDrive("Dana's Drive");
    await delay(300);
    await one.clientDb.flush();
    const key = new Uint8Array(32).fill(5);
    const out = await raw(one.clientDb).vaultExport(
      drive.subject, key, 1, PSEUDONYM, DEVICE, 1, 1n, false, undefined, undefined,
    );

    const signedIn = new Agent(new JSCryptoProvider(keys.privateKey), spell(pk));
    const two = await deviceFor(signedIn);
    await two.store.getResource(spell(pk));
    await raw(two.clientDb).vaultImport(key, 1, PSEUDONYM, DEVICE, [
      { objectKey: out.objectKey, sealed: out.sealed },
    ]);
    await two.store.reloadResource(spell(pk));
    const after = await two.store.getResource(spell(pk));
    expect(after.get(core.properties.name)).toBe('Dana Returning');
  }, 60_000);

  it('merges the restored profile into one this device already created', async () => {
    const keys = await Agent.generateKeyPair();
    const did = agentSubject(
      await new JSCryptoProvider(keys.privateKey).getPublicKey(),
    );
    const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);

    const one = await deviceFor(agent);
    one.store.registerLocalOnlyDrive(did);
    const profile = one.store.getResourceLoading(did, { newResource: true });
    await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    await profile.set(core.properties.isA, [core.classes.agent]);
    await profile.set(core.properties.name, 'Erin Returning');
    await profile.save();
    const drive = await one.store.createDrive("Erin's Drive");
    await delay(300);
    await one.clientDb.flush();
    const key = new Uint8Array(32).fill(4);
    const out = await raw(one.clientDb).vaultExport(
      drive.subject, key, 1, PSEUDONYM, DEVICE, 1, 1n, false, undefined, undefined,
    );

    // Device 2 already wrote the agent resource itself, like a first sign-in
    // that saved the bare identity: its own commit, its own Loro history.
    const two = await deviceFor(agent);
    two.store.registerLocalOnlyDrive(did);
    const bare = two.store.getResourceLoading(did, { newResource: true });
    await bare.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    await bare.set(core.properties.isA, [core.classes.agent]);
    await bare.save();
    await delay(300);
    await two.clientDb.flush();

    await raw(two.clientDb).vaultImport(key, 1, PSEUDONYM, DEVICE, [
      { objectKey: out.objectKey, sealed: out.sealed },
    ]);
    await two.store.reloadResource(did);
    const after = await two.store.getResource(did);
    expect(after.get(core.properties.name)).toBe('Erin Returning');
  }, 60_000);

  it('merges the restored profile into an agent resource with an unsaved edit', async () => {
    const keys = await Agent.generateKeyPair();
    const did = agentSubject(
      await new JSCryptoProvider(keys.privateKey).getPublicKey(),
    );
    const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);

    const one = await deviceFor(agent);
    one.store.registerLocalOnlyDrive(did);
    const profile = one.store.getResourceLoading(did, { newResource: true });
    await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
    await profile.set(core.properties.isA, [core.classes.agent]);
    await profile.set(core.properties.name, 'Hana Returning');
    await profile.save();
    const drive = await one.store.createDrive("Hana's Drive");
    await delay(300);
    await one.clientDb.flush();
    const key = new Uint8Array(32).fill(8);
    const out = await raw(one.clientDb).vaultExport(
      drive.subject, key, 1, PSEUDONYM, DEVICE, 1, 1n, false, undefined, undefined,
    );

    // Device 2: the key publisher has set `encryptionKey` on the (empty) agent
    // resource and its save has not gone through (a managed node refuses a
    // standalone agent profile), so the edit is still unsaved when the vault
    // restore lands.
    const two = await deviceFor(agent);
    two.store.setServerConnected(true);
    await two.clientDb.putResource(
      JSON.stringify({
        '@id': did,
        [core.properties.isA]: [core.classes.agent],
        [core.properties.publicKey]: agentPublicKey(did),
      }),
    );
    const early = await two.store.getResource(did);
    await early.set(conversations.properties.encryptionKey, 'pubkey-3', false);
    expect(early.hasUnsavedChanges()).toBe(true);

    await raw(two.clientDb).vaultImport(key, 1, PSEUDONYM, DEVICE, [
      { objectKey: out.objectKey, sealed: out.sealed },
    ]);
    await two.store.reloadResource(did);

    const after = two.store.getResourceLoading(did);
    expect(after.loading).toBe(false);
    expect(after.get(core.properties.name)).toBe('Hana Returning');
    expect(after.get(conversations.properties.encryptionKey)).toBe('pubkey-3');
  }, 60_000);

  describe('with a node that has never heard of the profile', () => {
    let node: ServerHandle;

    beforeAll(async () => {
      node = await startServer();
    }, 180_000);

    afterAll(async () => {
      for (const store of openStores) store.disconnect();
      await delay(300);
      await node?.stop();
    });

    it('keeps the restored name after the store asks the node about the agent', async () => {
      const keys = await Agent.generateKeyPair();
      const did = agentSubject(
        await new JSCryptoProvider(keys.privateKey).getPublicKey(),
      );
      const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);

      const one = await deviceFor(agent);
      one.store.registerLocalOnlyDrive(did);
      const profile = one.store.getResourceLoading(did, { newResource: true });
      await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
      await profile.set(core.properties.isA, [core.classes.agent]);
      await profile.set(core.properties.name, 'Bob Returning');
      await profile.save();
      const drive = await one.store.createDrive("Bob's Drive");
      await delay(300);
      await one.clientDb.flush();

      const key = new Uint8Array(32).fill(9);
      const out = await raw(one.clientDb).vaultExport(
        drive.subject,
        key,
        1,
        PSEUDONYM,
        DEVICE,
        1,
        1n,
        false,
        undefined,
        undefined,
      );

      // Device 2 is connected to a node that holds nothing of this account.
      const clientDb = new NodeClientDb({ wasmPath, baseUrl: node.serverUrl });
      await clientDb.init();
      const two = new Store({ serverUrl: node.serverUrl, agent });
      two.setClientDb(clientDb as unknown as ClientDbWorker);
      openStores.push(two);
      await delay(1000);

      // The sidebar's lookup, before the restore.
      await two.getResource(did);
      await raw(clientDb).vaultImport(key, 1, PSEUDONYM, DEVICE, [
        { objectKey: out.objectKey, sealed: out.sealed },
      ]);
      two.registerLocalOnlyDrive(drive.subject);
      await two.reloadResource(drive.subject);
      await two.reloadResource(did);

      const after = await two.getResource(did);
      expect(after.get(core.properties.name)).toBe('Bob Returning');
    }, 120_000);

    // The node auto-creates a bare agent resource (its own Loro document) the
    // first time the agent signs a commit there, and `createDrive` /
    // `linkPrivateDrive` reads the personal drive's owner from the node.
    it('keeps the restored name when the node already holds a bare agent and the drive is relinked', async () => {
      const keys = await Agent.generateKeyPair();
      const did = agentSubject(
        await new JSCryptoProvider(keys.privateKey).getPublicKey(),
      );
      const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);

      const one = await deviceFor(agent);
      one.store.registerLocalOnlyDrive(did);
      const profile = one.store.getResourceLoading(did, { newResource: true });
      await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
      await profile.set(core.properties.isA, [core.classes.agent]);
      await profile.set(core.properties.name, 'Gus Returning');
      await profile.save();
      const drive = await one.store.createDrive("Gus's Drive", {
        localOnly: true,
      } as never);
      await delay(300);
      await one.clientDb.flush();
      const key = new Uint8Array(32).fill(2);
      const out = await raw(one.clientDb).vaultExport(
        drive.subject, key, 1, PSEUDONYM, DEVICE, 1, 1n, false, undefined, undefined,
      );

      // Hosting the drive on the node makes the node create the bare agent.
      const hostClientDb = new NodeClientDb({ wasmPath, baseUrl: node.serverUrl });
      await hostClientDb.init();
      const host = new Store({ serverUrl: node.serverUrl, agent });
      host.setClientDb(hostClientDb as unknown as ClientDbWorker);
      openStores.push(host);
      await delay(1000);
      const hosted = await host.newResource({
        isA: 'https://atomicdata.dev/classes/Drive',
        noParent: true,
        propVals: {
          [core.properties.name]: 'Hosted',
          [core.properties.write]: [did],
          [core.properties.read]: [did],
        },
      });
      await hosted.save();
      await delay(500);

      // Device 2 is fresh, restores, then the app relinks the personal drive.
      const clientDb = new NodeClientDb({ wasmPath, baseUrl: node.serverUrl });
      await clientDb.init();
      const two = new Store({ serverUrl: node.serverUrl, agent });
      two.setClientDb(clientDb as unknown as ClientDbWorker);
      openStores.push(two);
      await delay(1000);
      // EncryptionKeyPublisher, two seconds after the agent is set and before
      // the person has unlocked anything: it writes onto what the node has.
      const early = await two.getResource(did);
      await early.set(conversations.properties.encryptionKey, 'pubkey-2', false);
      await early.save().catch(() => undefined);
      await raw(clientDb).vaultImport(key, 1, PSEUDONYM, DEVICE, [
        { objectKey: out.objectKey, sealed: out.sealed },
      ]);
      await two.reloadResource(drive.subject);
      await two.reloadResource(did);
      await two.createDrive("Gus's Drive");
      await delay(1000);
      await two.reloadResource(did);

      const after = await two.getResource(did);
      expect(after.get(core.properties.name)).toBe('Gus Returning');
    }, 120_000);

    // The encryption-key publisher writes onto the agent resource of any
    // device whose agent is not local-only, which is every device with a
    // node-hosted drive, two seconds after the agent is set.
    it.each(['before', 'after'] as const)(
      'keeps the name and the encryption key when the publisher runs %s the import',
      async order => {
        const keys = await Agent.generateKeyPair();
        const did = agentSubject(
          await new JSCryptoProvider(keys.privateKey).getPublicKey(),
        );
        const agent = new Agent(new JSCryptoProvider(keys.privateKey), did);

        const one = await deviceFor(agent);
        one.store.registerLocalOnlyDrive(did);
        const profile = one.store.getResourceLoading(did, {
          newResource: true,
        });
        await profile.set(core.properties.publicKey, agentPublicKey(did) ?? '');
        await profile.set(core.properties.isA, [core.classes.agent]);
        await profile.set(core.properties.name, `Fay ${order}`);
        await profile.save();
        const drive = await one.store.createDrive("Fay's Drive");
        await delay(300);
        await one.clientDb.flush();
        const key = new Uint8Array(32).fill(3);
        const out = await raw(one.clientDb).vaultExport(
          drive.subject, key, 1, PSEUDONYM, DEVICE, 1, 1n, false, undefined, undefined,
        );

        const clientDb = new NodeClientDb({
          wasmPath,
          baseUrl: node.serverUrl,
        });
        await clientDb.init();
        const two = new Store({ serverUrl: node.serverUrl, agent });
        two.setClientDb(clientDb as unknown as ClientDbWorker);
        openStores.push(two);
        await delay(1000);

        const publish = async () => {
          const resource = await two.getResource(did);
          await resource.set(conversations.properties.encryptionKey, 'pubkey-1', false);
          await resource.save().catch(() => undefined);
        };
        const restore = async () => {
          await raw(clientDb).vaultImport(key, 1, PSEUDONYM, DEVICE, [
            { objectKey: out.objectKey, sealed: out.sealed },
          ]);
          two.registerLocalOnlyDrive(drive.subject);
          await two.reloadResource(drive.subject);
          await two.reloadResource(did);
        };

        if (order === 'before') {
          await publish();
          await restore();
        } else {
          await restore();
          await publish();
        }

        await delay(1500);
        await two.reloadResource(did);
        const after = await two.getResource(did);
        expect(after.get(core.properties.name)).toBe(`Fay ${order}`);
        expect(after.get(conversations.properties.encryptionKey)).toBe(
          'pubkey-1',
        );
      },
      120_000,
    );
  });
});
