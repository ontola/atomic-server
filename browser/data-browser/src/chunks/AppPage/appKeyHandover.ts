// @wc-ignore-file
import { del, entries, set } from 'idb-keyval';
import {
  Agent,
  errorMessageFromResponse,
  signRequest,
  StoreEvents,
  type Store,
} from '@tomic/react';
import {
  getOrCreateSessionDbKey,
  getSessionDbKey,
} from '../../helpers/localDbKey';

const PREFIX = 'atomic.app-key-handover.';
const PROTOCOL = 'initialize-only-v1';
const encoder = new TextEncoder();
interface PendingKey {
  version: 1;
  id: string;
  owner: string;
  endpoint: string;
  drive: string;
  app: string;
  iv: Uint8Array<ArrayBuffer>;
  encrypted: ArrayBuffer;
}
type Delivered = Pick<PendingKey, 'drive' | 'app'>;
const listeners = new WeakMap<Store, Set<(app: Delivered) => void>>();
const wakeups = new WeakMap<Store, () => void>();

function endpoint(store: Store): string {
  return `${store.getServerUrl().replace(/\/$/, '')}/app-agent`;
}

function contextMatches(store: Store, pending: PendingKey): boolean {
  return (
    store.getAgent()?.subject === pending.owner &&
    endpoint(store) === pending.endpoint
  );
}

function ready(store: Store): boolean {
  const status = store.getSyncStatus();

  return (
    status.serverConnected &&
    !status.syncInProgress &&
    status.pendingDirtyCount === 0
  );
}

function binding(pending: PendingKey): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([
      pending.version,
      pending.id,
      pending.owner,
      pending.endpoint,
      pending.drive,
      pending.app,
    ]),
  );
}

async function encryptionKey(raw: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(raw),
    'HKDF',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('atomic.app-key-handover.v1'),
      info: encoder.encode('pending-app-key'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Never a synced resource: only encrypted, owner-bound browser storage. */
export async function handOverAppKey(
  store: Store,
  options: { drive: string; app: string; secret: string },
): Promise<void> {
  const owner = store.getAgent()?.subject;
  if (!owner) throw new Error('Sign in to give an app its key');
  const pending: PendingKey = {
    version: 1,
    id: PREFIX + crypto.randomUUID(),
    owner,
    endpoint: endpoint(store),
    drive: options.drive,
    app: options.app,
    iv: crypto.getRandomValues(new Uint8Array(12)),
    encrypted: new ArrayBuffer(0),
  };
  const key = await encryptionKey(await getOrCreateSessionDbKey(owner));
  pending.encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: pending.iv, additionalData: binding(pending) },
    key,
    encoder.encode(options.secret),
  );
  // Persist before the first request: a reload or a lost response must not
  // discard the only copy that can complete this installation.
  await set(pending.id, pending);

  try {
    await deliver(store, pending, options.secret, true);
  } finally {
    wakeups.get(store)?.();
  }
}

async function deliver(
  store: Store,
  pending: PendingKey,
  secret: string,
  initial = false,
): Promise<boolean> {
  if (!contextMatches(store, pending) || !ready(store)) return false;
  const agent = store.getAgent()!;
  const query = new URL(pending.endpoint);
  query.searchParams.set('drive', pending.drive);
  query.searchParams.set('app', pending.app);
  query.searchParams.set('handover', 'true');
  const probe = await fetch(query.href, {
    headers: await signRequest(query.href, agent, {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!probe.ok)
    throw new Error('App identity handover is waiting for this node.');
  const capability = await probe.json();
  // Old nodes silently ignore unknown POST fields. Never replay a secret to
  // one: it could overwrite a replacement or resurrect a revoked identity.
  if (capability?.handover !== PROTOCOL && !initial)
    throw new Error('Update this node to resume app identity handovers.');
  const appAgent = await Agent.fromSecret(secret);

  if (
    capability?.state === 'revoked' ||
    (capability?.state === 'active' && capability.agent !== appAgent.subject)
  ) {
    await del(pending.id);

    return false;
  }

  if (!contextMatches(store, pending) || !ready(store)) return false;
  const payload = JSON.stringify({
    drive: pending.drive,
    app: pending.app,
    secret,
    initializeOnly: true,
  });
  const headers = await signRequest(
    pending.endpoint,
    agent,
    {},
    { method: 'POST', body: payload },
  );
  if (!contextMatches(store, pending) || !ready(store)) return false;
  const response = await fetch(pending.endpoint, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 409) {
    await del(pending.id);

    return false;
  }

  if (!response.ok)
    throw new Error(
      errorMessageFromResponse(await response.text(), response.status),
    );
  await del(pending.id);

  if (contextMatches(store, pending)) {
    for (const listener of listeners.get(store) ?? []) listener(pending);
  }

  return true;
}

/** Retry only the active owner's handovers to the node they selected at install. */
export async function retryPendingAppKeys(store: Store): Promise<boolean> {
  if (!store.getAgent() || !ready(store)) return false;
  let retry = false;

  for (const [id, value] of await entries()) {
    if (typeof id !== 'string' || !id.startsWith(PREFIX) || !value) continue;
    const pending = value as PendingKey;
    if (
      pending.version !== 1 ||
      pending.id !== id ||
      !contextMatches(store, pending)
    )
      continue;

    try {
      const rawKey = await getSessionDbKey(pending.owner);
      if (!rawKey) continue; // Signed out/locked: never create a replacement key.
      const key = await encryptionKey(rawKey);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: pending.iv, additionalData: binding(pending) },
        key,
        pending.encrypted,
      );
      await deliver(store, pending, new TextDecoder().decode(plaintext));
    } catch {
      // Keep the encrypted record. Neither a secret nor an HTTP body belongs
      // in a reconnect log or repeated notification.
      retry = true;
    }
  }

  return retry;
}

export function subscribeAppKeyHandover(
  store: Store,
  listener: (app: Delivered) => void,
): () => void {
  let current = listeners.get(store);
  if (!current) listeners.set(store, (current = new Set()));
  current.add(listener);

  return () => {
    current.delete(listener);
  };
}

/** Startup/reconnect recovery also survives navigation and a full page reload. */
export function startAppKeyRecovery(store: Store): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let stopped = false;
  let again = false;
  let delay = 1000;

  const schedule = () => {
    if (stopped) return;

    if (busy) {
      again = true;

      return;
    }

    clearTimeout(timer);
    timer = setTimeout(run, 0);
  };

  const run = async () => {
    busy = true;
    again = false;
    let retry = true;

    try {
      retry = await retryPendingAppKeys(store);
    } catch {
      /* IDB can be temporarily unavailable. */
    }

    busy = false;
    if (stopped) return;

    if (again) {
      schedule();

      return;
    }

    if (retry) {
      timer = setTimeout(run, delay);
      delay = Math.min(delay * 2, 30_000);
    } else delay = 1000;
  };

  const off = [
    StoreEvents.AgentChanged,
    StoreEvents.ServerURLChanged,
    StoreEvents.ConnectionChanged,
    StoreEvents.SyncStatusChanged,
  ] as const;
  const unsubscribeAll = off.map(event => store.on(event, schedule));
  wakeups.set(store, schedule);
  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribeAll.forEach(unsubscribe => unsubscribe());
    if (wakeups.get(store) === schedule) wakeups.delete(store);
  };
}
