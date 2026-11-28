import { describe, expect, it, vi } from 'vitest';
import { Store, StoreEvents } from './store.js';
import { Resource } from './resource.js';
import { Agent } from './agent.js';
import { core } from './ontologies/core.js';
import { encodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import type { ClientDbWorker } from './client-db.js';
import type { BrowserReplicaReceipt } from './peer-receipts.js';

const drive = 'atomic:drive';
const source = { storageId: 'a'.repeat(64), generation: 'b'.repeat(64) };
const replica = { storageId: 'c'.repeat(64), generation: 'd'.repeat(64) };

function setup() {
  const store = new Store({
    serverUrl: 'https://example.com',
    connect: false,
    noServer: true,
  });
  const resource = new Resource('atomic:resource');
  resource.setStore(store);
  const props = resource.getLoroDoc()!.getMap('properties');
  props.set(core.properties.name, 'First');
  void resource.set('https://atomicdata.dev/properties/drive', drive, false);
  resource.sealPendingEdits();
  store.resources.set(resource.subject, resource);
  const version = () =>
    encodeB64(resource.getLoroDoc()!.oplogVersion().encode());
  const open = (id = 'connection') =>
    store.registerResourcePeerSession(id, drive, 'atomic:agent:remote');
  const receipt = (
    changes: Partial<BrowserReplicaReceipt> = {},
  ): BrowserReplicaReceipt => ({
    subject: resource.subject,
    drive,
    source,
    replica,
    peerAgent: 'atomic:agent:remote',
    connectionId: 'connection',
    confirmedAt: 10,
    version: version(),
    ...changes,
  });
  const get = () => store.getResourcePeerSyncStatus(resource);

  return { store, resource, open, receipt, get, version };
}

describe('live resource peer copies', () => {
  it('never infers storage from a connection or another subject and returns stable snapshots', () => {
    const h = setup();
    h.open();
    expect(h.get()).toMatchObject({
      state: 'unknown',
      connectedCount: 1,
      confirmedCount: 0,
    });
    h.store.acknowledgeResourcePeerReceipt(
      h.receipt({ subject: 'atomic:elsewhere' }),
    );
    expect(h.get().confirmedCount).toBe(0);
    expect(h.get()).toBe(h.get());
    expect(Object.isFrozen(h.get())).toBe(true);
    expect(Object.isFrozen(h.get().peers)).toBe(true);
  });

  it('confirms only the requested version and becomes pending for an unsaved or newer edit', () => {
    const h = setup();
    h.open();
    const old = h.receipt();
    h.store.acknowledgeResourcePeerReceipt(old);
    expect(h.get().state).toBe('confirmed');
    h.resource
      .getLoroDoc()!
      .getMap('properties')
      .set(core.properties.name, 'Later');
    expect(h.get().state).toBe('pending');
    h.resource.sealPendingEdits();
    h.store.acknowledgeResourcePeerReceipt(old);
    expect(h.get().state).toBe('pending');
    h.store.acknowledgeResourcePeerReceipt(h.receipt({ confirmedAt: 20 }));
    expect(h.get().state).toBe('confirmed');
    // A delayed older acknowledgment cannot replace newer coverage/time.
    h.store.acknowledgeResourcePeerReceipt(old);
    expect(h.get().peers[0].confirmedAt).toBe(20);
    expect(h.get().state).toBe('confirmed');
  });

  it('uses the timestamp of the receipt covering the displayed version', () => {
    const h = setup();
    h.open();
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    const peer = h.resource.getLoroDoc()!.peerIdStr === '1' ? '2' : '1';
    const unrelated = new LoroLoader.Loro.VersionVector(new Map([[peer, 1]]));
    h.store.acknowledgeResourcePeerReceipt(
      h.receipt({
        version: encodeB64(unrelated.encode()),
        confirmedAt: 20,
      }),
    );

    expect(h.get().peers[0]).toMatchObject({
      state: 'confirmed',
      confirmedAt: 10,
    });
  });

  it('deduplicates connections sharing remote storage and excludes the source database', () => {
    const h = setup();
    h.open();
    h.open('duplicate');
    h.open('same-browser');
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    h.store.acknowledgeResourcePeerReceipt(
      h.receipt({ connectionId: 'duplicate', confirmedAt: 20 }),
    );
    h.store.acknowledgeResourcePeerReceipt(
      h.receipt({ connectionId: 'same-browser', replica: source }),
    );
    expect(h.get()).toMatchObject({ confirmedCount: 1, connectedCount: 3 });
    expect(h.get().peers).toHaveLength(1);
    expect(h.get().peers[0].confirmedAt).toBe(20);
  });

  it('prefers a duplicate session covering the latest version over an older copy', () => {
    const h = setup();
    h.open();
    h.open('duplicate');
    h.store.acknowledgeResourcePeerReceipt(h.receipt({ confirmedAt: 30 }));
    h.resource
      .getLoroDoc()!
      .getMap('properties')
      .set(core.properties.name, 'Later');
    h.resource.sealPendingEdits();
    h.store.acknowledgeResourcePeerReceipt(
      h.receipt({ connectionId: 'duplicate', confirmedAt: 20 }),
    );
    expect(h.get().confirmedCount).toBe(1);
    expect(h.get().peers).toHaveLength(1);
    expect(h.get().peers[0].connectionId).toBe('duplicate');
  });

  it('retains historical proof on departure and ignores a late response from the closed session', () => {
    const h = setup();
    const close = h.open();
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    close();
    const prior = h.get();
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    expect(h.get()).toEqual(prior);
    expect(h.get().peers[0].connected).toBe(false);
    expect(h.get()).toMatchObject({
      state: 'confirmed',
      connectedCount: 0,
      confirmedCount: 1,
    });
  });

  it('clears receipts immediately on source replacement and cannot reuse another remote generation', () => {
    const h = setup();
    h.open();
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    h.store.invalidateResourcePeerSession('connection');
    expect(h.get().state).toBe('unknown');
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    h.store.acknowledgeResourcePeerReceipt(
      h.receipt({
        subject: 'atomic:other',
        replica: { ...replica, generation: 'e'.repeat(64) },
      }),
    );
    expect(h.get().state).toBe('unknown');
  });

  it.each(['agent', 'database'])(
    'fences old connections on %s A→B→A and notifies mounted rows synchronously',
    kind => {
      const h = setup();
      const agent = new Agent('secret', 'atomic:agent:source');
      const db = {} as ClientDbWorker;
      h.store.setAgent(agent);
      h.store.setClientDb(db);
      h.open();
      h.store.acknowledgeResourcePeerReceipt(h.receipt());
      const states: string[] = [];
      const unsubscribe = h.store.subscribeResourcePeerSyncStatus(
        h.resource,
        () => states.push(h.get().state),
      );
      const epoch = h.store.getPeerSyncGeneration();

      if (kind === 'agent') {
        h.store.setAgent(undefined);
        h.store.setAgent(agent);
      } else {
        h.store.setClientDb(undefined);
        h.store.setClientDb(db);
      }

      expect(h.store.getPeerSyncGeneration()).toBeGreaterThan(epoch);
      h.store.acknowledgeResourcePeerReceipt(h.receipt());
      expect(h.get().state).toBe('unknown');
      expect(states.at(-1)).toBe('unknown');
      unsubscribe();
    },
  );

  it('does not borrow the active drive when resource ancestry is unresolved', () => {
    const h = setup();
    h.open();
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    h.resource.removeUnsafe('https://atomicdata.dev/properties/drive');
    void h.resource.set(core.properties.parent, 'atomic:missing-parent', false);
    h.resource.sealPendingEdits();
    expect(h.get().connectedCount).toBe(0);
  });

  it('follows known ancestry and canonical drive aliases without treating unrelated resources as copies', () => {
    const h = setup();
    h.store.registerResourcePeerSession(
      'connection',
      'did:ad:drive',
      'atomic:agent:remote',
    );
    const parent = new Resource('atomic:parent');
    parent.setStore(h.store);
    void parent.set(core.properties.parent, drive, false);
    parent.sealPendingEdits();
    const driveResource = new Resource(drive);
    driveResource.setStore(h.store);
    h.store.resources.set(parent.subject, parent);
    h.store.resources.set(drive, driveResource);
    h.resource.removeUnsafe('https://atomicdata.dev/properties/drive');
    void h.resource.set(core.properties.parent, parent.subject, false);
    h.resource.sealPendingEdits();
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    expect(h.get().confirmedCount).toBe(1);
  });

  it('clears proof on silent eviction and isolates throwing subscribers', () => {
    const h = setup();
    h.open();
    const unsubscribe = h.store.subscribeResourcePeerSyncStatus(
      h.resource,
      () => {
        throw new Error('view failed');
      },
    );
    expect(() =>
      h.store.acknowledgeResourcePeerReceipt(h.receipt()),
    ).not.toThrow();
    const removed = vi.fn();
    const stop = h.store.on(StoreEvents.ResourcePeerEvidenceRemoved, removed);
    h.store.evictResource(h.resource.subject, false);
    expect(removed).toHaveBeenCalledWith(h.resource.subject);
    expect(h.get().state).toBe('unknown');
    unsubscribe();
    stop();
  });
  it('notifies only the affected resource on later acknowledgments and immediately shows unsaved edits', () => {
    const h = setup();
    h.open();
    h.store.acknowledgeResourcePeerReceipt(h.receipt());
    const unrelated = new Resource('atomic:unrelated');
    unrelated.setStore(h.store);
    void unrelated.set('https://atomicdata.dev/properties/drive', drive, false);
    unrelated.sealPendingEdits();
    h.store.resources.set(unrelated.subject, unrelated);
    const changed = vi.fn();
    const stopOther = h.store.subscribeResourcePeerSyncStatus(
      unrelated,
      changed,
    );
    const states: string[] = [];
    const stop = h.store.subscribeResourcePeerSyncStatus(h.resource, () =>
      states.push(h.get().state),
    );
    h.store.acknowledgeResourcePeerReceipt(h.receipt({ confirmedAt: 30 }));
    expect(changed).not.toHaveBeenCalled();
    void h.resource.set(core.properties.name, 'Unsaved', false);
    expect(states.at(-1)).toBe('pending');
    stopOther();
    stop();
  });
});
