import {
  Agent,
  ClientDbWorker,
  LoroLoader,
  Store,
  StoreEvents,
  core,
  decodeB64,
  type ServerReplicaReceipt,
} from '../../lib/src/index.js';

/** Real worker/OPFS and server transports; no receipt probes or persistence mocks. */
export async function openClient(serverUrl: string, secret?: string) {
  await LoroLoader.initializeLoro();

  if (!secret) {
    const keys = await Agent.generateKeyPair();
    secret = Agent.buildSecret(
      keys.privateKey,
      `did:ad:agent:${keys.publicKey}`,
    );
  }

  const agent = await Agent.fromSecret(secret);
  const db = new ClientDbWorker(
    '/wasm/pkg/atomic_wasm.js',
    '/browser/lib/src/client-db.worker.ts',
    { dbName: 'server-receipts-acceptance.redb' },
  );
  await db.init(serverUrl);
  await db.populate();
  const captured: Array<{ subject: string; version: [string, number][] }> = [];
  const readSnapshot = db.getResourceWithSnapshot.bind(db);

  db.getResourceWithSnapshot = async subject => {
    const stored = await readSnapshot(subject);

    if (stored.snapshot) {
      captured.push({ subject, version: snapshotVersion(stored.snapshot) });
    }

    return stored;
  };

  const store = new Store({ serverUrl, agent });
  store.setClientDb(db);
  const receipts: ServerReplicaReceipt[] = [];
  store.on(StoreEvents.ServerReplicaReceipt, receipt => receipts.push(receipt));
  await store.outbox.whenHydrated();

  return { store, db, agent, secret, receipts, captured };
}

export function snapshotVersion(snapshot: Uint8Array): [string, number][] {
  const doc = new LoroLoader.Loro.LoroDoc();

  try {
    doc.import(snapshot);

    return [...doc.version().toJSON()]
      .filter(([, counter]) => counter > 0)
      .sort(([a], [b]) => a.localeCompare(b));
  } finally {
    doc.free();
  }
}

export function receiptVersion(
  receipt: ServerReplicaReceipt,
): [string, number][] {
  const vector = LoroLoader.Loro.VersionVector.decode(
    decodeB64(receipt.observation.barrier!.version!),
  );

  try {
    return [...vector.toJSON()]
      .filter(([, counter]) => counter > 0)
      .sort(([a], [b]) => a.localeCompare(b));
  } finally {
    vector.free();
  }
}

export function receiptCovers(
  receipt: ServerReplicaReceipt,
  version: [string, number][],
): boolean {
  const actual = new Map(receiptVersion(receipt));

  return version.every(([peer, counter]) => (actual.get(peer) ?? 0) >= counter);
}

export { core, Store, StoreEvents };
