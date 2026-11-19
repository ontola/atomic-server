import { afterEach, expect, it, vi } from 'vitest';
import { testStore } from './test-store.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { StoreEvents } from './store.js';
import { LoroLoader } from './loro-loader.js';
import { encodeB64 } from './base64.js';
import { PEER_STORAGE_BARRIER } from './ws-v2.js';
import type { ServerReceiptTransport } from './server-receipts.js';
import type { ClientDbWorker } from './client-db.js';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const context = await testStore();
  const resource = await context.store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: { [core.properties.name]: 'First' },
  });
  const request = vi
    .fn<ServerReceiptTransport['request']>()
    .mockImplementation(async r => ({
      ...r,
      replica: { storageId: 'a'.repeat(64), generation: 'b'.repeat(64) },
      barrier: PEER_STORAGE_BARRIER,
    }));
  vi.spyOn(context.store, 'getServerReceiptTransport').mockImplementation(
    endpoint => ({
      endpoint: new URL('/storage-receipt', endpoint).href,
      transport: 'http',
      connectionId: 'test-session',
      current: () => true,
      request,
    }),
  );

  return { ...context, resource, request };
}

it('automatically observes background delta acceptance without an explicit save', async () => {
  const { store, resource, request } = await fixture();
  await resource.save();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mockClear();
  await resource.set(core.properties.name, 'Background', false);
  resource.getLoroDoc()!.commit();
  const expected = encodeB64(resource.getLoroDoc()!.oplogVersion().encode());
  const saves = vi.fn();
  store.on(StoreEvents.SaveReceipt, saves);
  await store.syncDirtyResources();

  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0][0].version).toBe(expected);
    expect(saves).not.toHaveBeenCalled();
  } finally {
    store.disconnect();
    store.setServerConnected(false);
  }
});
it('captures cold genesis acceptance from its signed envelope with no loaded resource', async () => {
  const { store, resource, request } = await fixture();
  const genesis = await resource.signChanges();
  const expected = encodeB64(
    LoroLoader.Loro.decodeImportBlobMeta(
      genesis.loroUpdate!,
      false,
    ).partialEndVersionVector.encode(),
  );
  store.outbox.setGenesisCommit(resource.subject, genesis);
  store.resources.delete(resource.subject);
  await store.syncDirtyResources();

  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0][0]).toMatchObject({
      subject: resource.subject,
      drive: resource.subject,
      version: expected,
    });
  } finally {
    store.disconnect();
    store.setServerConnected(false);
  }
});

it('keeps the accepted background version when another edit arrives during delivery', async () => {
  const { store, resource, request, postCommitSpy } = await fixture();
  await resource.save();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mockClear();
  const original = postCommitSpy.getMockImplementation()!;
  let release!: () => void;
  let posting!: () => void;
  const posted = new Promise<void>(resolve => {
    posting = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  postCommitSpy.mockImplementationOnce(async (...args) => {
    posting();
    await gate;

    return original(...args);
  });

  try {
    await resource.set(core.properties.name, 'C1', false);
    resource.getLoroDoc()!.commit();
    const expected = encodeB64(resource.getLoroDoc()!.oplogVersion().encode());
    const drain = store.syncDirtyResources();
    await posted;
    await resource.set(core.properties.name, 'C2', false);
    resource.getLoroDoc()!.commit();
    const later = encodeB64(resource.getLoroDoc()!.oplogVersion().encode());
    expect(later).not.toBe(expected);
    release();
    await drain;
    await vi.waitFor(() =>
      expect(
        request.mock.calls.some(([target]) => target.version === expected),
      ).toBe(true),
    );
  } finally {
    release();
    store.disconnect();
    store.setServerConnected(false);
  }
});

it('accepts a background commit but suppresses its receipt after database replacement', async () => {
  const { store, resource, request, postCommitSpy } = await fixture();
  await resource.save();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mockClear();
  const original = postCommitSpy.getMockImplementation()!;
  let release!: () => void;
  let posting!: () => void;
  const posted = new Promise<void>(resolve => {
    posting = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  postCommitSpy.mockImplementationOnce(async (...args) => {
    posting();
    await gate;

    return original(...args);
  });

  try {
    await resource.set(core.properties.name, 'C1', false);
    resource.getLoroDoc()!.commit();
    const drain = store.syncDirtyResources();
    await posted;
    const replacement = {
      isReady: false,
      unsupportedEnvironment: true,
    } as unknown as ClientDbWorker;
    store.setClientDb(replacement);
    store.setClientDb(undefined);
    release();
    await drain;
    expect(store.outbox.hasPending(resource.subject)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(request).not.toHaveBeenCalled();
  } finally {
    release();
    store.disconnect();
    store.setServerConnected(false);
  }
});
