// @wc-ignore-file
import {
  StoreEvents,
  LoroLoader,
  canonicalizeScheme,
  core,
  normalizeVaultSyncScope,
  parseSerializedVaultReceipt,
  type Resource,
  type Store,
  type VaultSyncScope,
  type SerializedVaultReceipt,
  type ResourceVaultEvidence,
} from '@tomic/lib';
import { getManagedApiBase } from './api';
import {
  getManagedAccount,
  onManagedLogout,
  onManagedSessionChanged,
} from './session';

/** A confirmed resource document, not its attachments or retained edit history. */
export type ResourceVaultSyncStatus = Readonly<{
  state: 'unknown' | 'pending' | 'confirmed';
  confirmedAt?: number;
  scope?: VaultSyncScope;
}>;

export type ConfirmedVaultExport = {
  objectKey: string;
  resourceVersions: Record<string, Record<string, number>>;
  confirmedAt: number;
};

export type VaultReceiptDb = {
  getResourceVaultGeneration?: (
    scope: VaultSyncScope,
  ) => Promise<number | undefined>;
  getResourceVaultEvidence?: (
    subjects: string[],
    scope: VaultSyncScope,
  ) => Promise<ResourceVaultEvidence[] | undefined>;
  putResourceVaultReceipts?: (
    scope: VaultSyncScope,
    receipts: SerializedVaultReceipt[],
    generation: number,
  ) => Promise<boolean>;
  clearResourceVaultReceipts?: (scope: VaultSyncScope) => Promise<void>;
};
type Context = {
  scope: VaultSyncScope;
  db: VaultReceiptDb;
  storeDb: ReturnType<Store['getClientDb']>;
  receipts: Map<string, SerializedVaultReceipt>;
  reads: Map<string, object>;
  queued: Map<string, object>;
  ready: Promise<number | undefined>;
};
type Ledger = {
  contexts: Map<string, Context>;
  listeners: Set<{ resource: Resource; callback: () => void }>;
  snapshots: WeakMap<Resource, ResourceVaultSyncStatus>;
  epoch: number;
};
const ledgers = new WeakMap<Store, Ledger>();
const UNKNOWN: ResourceVaultSyncStatus = Object.freeze({ state: 'unknown' });

function notify(ledger: Ledger) {
  for (const listener of ledger.listeners) {
    try {
      listener.callback();
    } catch {
      /* A view must not fail a backup. */
    }
  }
}

export function clearResourceVaultScopes(store: Store): void {
  const ledger = ledgers.get(store);
  if (!ledger) return;
  ledger.epoch++;
  ledger.contexts.clear();
  notify(ledger);
}

/** A known disabled destination must not recover old confirmations on reenable. */
export async function invalidateResourceVaultProof(
  store: Store,
  drivePseudonym: string,
  explicit?: { scope: VaultSyncScope; db: VaultReceiptDb },
): Promise<void> {
  const ledger = ledgerFor(store);
  const removed = [...ledger.contexts.values()].filter(
    context => context.scope.drivePseudonym === drivePseudonym,
  );
  ledger.epoch++;
  for (const context of removed) ledger.contexts.delete(context.scope.drive);

  for (const context of ledger.contexts.values()) {
    context.reads.clear();
    context.queued.clear();
  }

  notify(ledger);
  const scopes = removed.map(context => ({
    scope: context.scope,
    db: context.db,
  }));
  if (
    explicit &&
    !scopes.some(value => scopeKey(value.scope) === scopeKey(explicit.scope))
  )
    scopes.push(explicit);
  await Promise.all(
    scopes.map(({ scope, db }) => db.clearResourceVaultReceipts?.(scope)),
  );
}

function ledgerFor(store: Store): Ledger {
  let ledger = ledgers.get(store);
  if (ledger) return ledger;
  ledger = {
    contexts: new Map(),
    listeners: new Set(),
    snapshots: new WeakMap(),
    epoch: 0,
  };
  ledgers.set(store, ledger);
  const clear = () => clearResourceVaultScopes(store);
  store.on(StoreEvents.AgentChanged, clear);
  onManagedLogout(clear);
  onManagedSessionChanged(clear);

  // Cookie accounts can change in another tab. Do not keep displaying an old
  // scope when returning until the account-wide backup path verifies it again.
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', clear);
    window.addEventListener('storage', event => {
      if (
        !event.key ||
        [
          'atomic-managed-device-token',
          'atomic-managed-portal-url',
          'atomic-managed-portal-origin-linked',
          'atomic.vault.optOut',
        ].includes(event.key)
      )
        clear();
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) clear();
    });
  }

  const current = ledger;
  store.on(StoreEvents.SyncStatusChanged, () => {
    if (
      [...current.contexts.values()].some(
        ctx =>
          ctx.storeDb !== store.getClientDb() ||
          ctx.scope.portalUrl !== normalizedPortal(),
      )
    )
      clear();
  });
  store.on(StoreEvents.ResourceRemoved, subject => {
    const normalized = store.normalizeSubject(subject);

    for (const ctx of current.contexts.values()) {
      ctx.receipts.delete(normalized);
      ctx.reads.delete(normalized);
      ctx.queued.delete(normalized);
    }

    notify(current);
  });

  return ledger;
}

function normalizedPortal(): string {
  try {
    const url = new URL(getManagedApiBase());

    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function contextFor(
  store: Store,
  ledger: Ledger,
  resource: Resource,
): Context | undefined {
  let subject = store.normalizeSubject(resource.subject);
  const seen = new Set<string>();

  while (!seen.has(subject)) {
    const found = ledger.contexts.get(subject);
    if (found) return found;
    seen.add(subject);
    const current =
      subject === store.normalizeSubject(resource.subject)
        ? resource
        : store.resources.get(subject);
    const parent = current?.get(core.properties.parent);
    if (typeof parent !== 'string') break;
    subject = store.normalizeSubject(parent);
  }

  return undefined;
}

function scopeKey(scope: VaultSyncScope): string {
  return JSON.stringify([
    scope.managedAccount,
    scope.agent,
    scope.portalUrl,
    scope.drive,
    scope.drivePseudonym,
    scope.keyEpoch,
  ]);
}

function contextCurrent(
  store: Store,
  ledger: Ledger,
  context: Context,
  epoch: number,
): boolean {
  return (
    ledger.epoch === epoch &&
    ledger.contexts.get(context.scope.drive) === context &&
    canonicalizeScheme(store.getAgent()?.subject ?? '') ===
      context.scope.agent &&
    store.getClientDb() === context.storeDb &&
    normalizedPortal() === context.scope.portalUrl
  );
}

function mergeReceipt(
  context: Context,
  incoming: SerializedVaultReceipt,
): void {
  const previous = context.receipts.get(incoming.subject);
  const version = { ...previous?.version };
  for (const [peer, count] of Object.entries(incoming.version))
    version[peer] = Math.max(version[peer] ?? 0, count);
  context.receipts.set(incoming.subject, {
    subject: incoming.subject,
    version,
    confirmedAt: Math.max(previous?.confirmedAt ?? 0, incoming.confirmedAt),
  });
}

function validSnapshot(snapshot: Uint8Array | null): boolean {
  if (!snapshot?.length || !LoroLoader.isLoaded()) return false;

  try {
    return (
      LoroLoader.Loro.decodeImportBlobMeta(
        snapshot,
        true,
      ).partialEndVersionVector.toJSON().size > 0
    );
  } catch {
    return false;
  }
}

function ensureEvidence(
  store: Store,
  ledger: Ledger,
  resource: Resource,
): void {
  const context = contextFor(store, ledger, resource);
  const subject = store.normalizeSubject(resource.subject);
  if (
    !context ||
    !context.db.getResourceVaultEvidence ||
    context.reads.has(subject) ||
    store.isDestroyed(subject) ||
    store.hasPendingDestroy(subject)
  )
    return;
  const token = {};
  context.reads.set(subject, token);
  context.queued.set(subject, token);
  if (context.queued.size > 1) return;
  const epoch = ledger.epoch;
  queueMicrotask(() => {
    const queued = new Map(context.queued);
    const subjects = [...queued.keys()];
    context.queued.clear();
    if (!contextCurrent(store, ledger, context, epoch) || !subjects.length)
      return;
    void context.db.getResourceVaultEvidence!(subjects, context.scope)
      .then(async rows => {
        const generation = await context.ready;
        const now =
          generation === undefined
            ? undefined
            : await context.db.getResourceVaultGeneration?.(context.scope);
        if (
          generation === undefined ||
          now !== generation ||
          !contextCurrent(store, ledger, context, epoch)
        )
          return;

        for (const row of rows ?? []) {
          const receipt = parseSerializedVaultReceipt(row.vaultReceipt);
          const rowSubject = store.normalizeSubject(row.subject);
          if (
            !validSnapshot(row.snapshot) ||
            !receipt ||
            !queued.has(rowSubject) ||
            context.reads.get(rowSubject) !== queued.get(rowSubject) ||
            store.isDestroyed(rowSubject) ||
            store.hasPendingDestroy(rowSubject) ||
            store.normalizeSubject(receipt.subject) !== rowSubject
          )
            continue;
          mergeReceipt(context, { ...receipt, subject: rowSubject });
        }

        notify(ledger);
      })
      .catch(() => {
        /* Missing durable proof remains unknown. */
      });
  });
}

/** Pure snapshot read. Neither account requests nor database RPCs run here. */
export function getResourceVaultSyncStatus(
  store: Store,
  resource: Resource,
): ResourceVaultSyncStatus {
  const ledger = ledgers.get(store);
  if (
    !ledger ||
    store.isDestroyed(resource.subject) ||
    store.hasPendingDestroy(resource.subject)
  )
    return UNKNOWN;
  const context = contextFor(store, ledger, resource);
  if (!context || !contextCurrent(store, ledger, context, ledger.epoch))
    return UNKNOWN;
  const receipt = context.receipts.get(
    store.normalizeSubject(resource.subject),
  );
  let state: ResourceVaultSyncStatus['state'] = 'unknown';

  if (receipt) {
    const doc = resource.hasLoroDoc() ? resource.getLoroDoc() : undefined;
    const current = doc?.oplogVersion().toJSON();
    state =
      current?.size &&
      doc!.getPendingTxnLength() === 0 &&
      [...current].every(
        ([peer, count]) => (receipt.version[peer] ?? 0) >= count,
      )
        ? 'confirmed'
        : 'pending';
  }

  const next = {
    state,
    scope: context.scope,
    confirmedAt: receipt?.confirmedAt,
  };
  const previous = ledger.snapshots.get(resource);
  if (previous && JSON.stringify(previous) === JSON.stringify(next))
    return previous;
  const result = Object.freeze(next);
  ledger.snapshots.set(resource, result);

  return result;
}

export function subscribeResourceVaultSyncStatus(
  store: Store,
  resource: Resource,
  callback: () => void,
): () => void {
  const ledger = ledgerFor(store);
  const listener = { resource, callback };
  ledger.listeners.add(listener);
  ensureEvidence(store, ledger, resource);
  const stop = store.subscribeResourceSyncStatus(resource, () => {
    ensureEvidence(store, ledger, resource);
    callback();
  });

  return () => {
    stop();
    ledger.listeners.delete(listener);
  };
}

/** Called only after checking the current account and active enrollment. */
export function bindResourceVaultScope(
  store: Store,
  db: VaultReceiptDb,
  value: VaultSyncScope,
): void {
  const scope = normalizeVaultSyncScope(value);
  if (
    !scope ||
    scope.agent !== canonicalizeScheme(store.getAgent()?.subject ?? '')
  )
    return;
  scope.drive = store.normalizeSubject(scope.drive);
  const ledger = ledgerFor(store);
  const sameAccount = [...ledger.contexts.values()].every(
    ctx =>
      ctx.scope.agent === scope.agent &&
      ctx.scope.managedAccount === scope.managedAccount &&
      ctx.scope.portalUrl === scope.portalUrl,
  );
  if (!sameAccount) clearResourceVaultScopes(store);
  const old = ledger.contexts.get(scope.drive);
  if (
    old &&
    old.db === db &&
    old.storeDb === store.getClientDb() &&
    scopeKey(old.scope) === scopeKey(scope)
  )
    return;
  const context: Context = {
    scope: Object.freeze(scope),
    db,
    storeDb: store.getClientDb(),
    receipts: new Map(),
    reads: new Map(),
    queued: new Map(),
    ready: Promise.resolve(undefined),
  };
  // A generation read is diagnostic: unsupported or broken storage withholds
  // new proof while the existing backup flow remains available.
  context.ready =
    db.getResourceVaultGeneration?.(scope).catch(() => undefined) ??
    Promise.resolve(undefined);
  ledger.contexts.set(scope.drive, context);
  for (const listener of ledger.listeners)
    ensureEvidence(store, ledger, listener.resource);
  notify(ledger);
}

/** Fence setup too: logout/disable while account/enrollment/key reads await
 * must not let their old continuation establish a fresh context afterward. */
export function captureResourceVaultOperation(store: Store): () => boolean {
  const ledger = ledgerFor(store);
  const epoch = ledger.epoch;
  const agent = store.getAgent();
  const db = store.getClientDb();
  const portal = normalizedPortal();

  return () =>
    ledger.epoch === epoch &&
    store.getAgent() === agent &&
    store.getClientDb() === db &&
    normalizedPortal() === portal;
}

/** Capture context before exporting. Its returned callback can only confirm
 * the immutable manifest of the object that actually completed publication.
 */
export function captureResourceVaultBackup(
  store: Store,
  db: VaultReceiptDb,
  scope: VaultSyncScope,
) {
  bindResourceVaultScope(store, db, scope);
  const ledger = ledgerFor(store);
  const context = ledger.contexts.get(store.normalizeSubject(scope.drive));
  const epoch = ledger.epoch;
  const normalized = normalizeVaultSyncScope(scope);
  if (normalized) normalized.drive = store.normalizeSubject(normalized.drive);
  const accepted =
    !!context &&
    context.db === db &&
    !!normalized &&
    scopeKey(normalized) === scopeKey(context.scope);
  const current = () =>
    accepted && !!context && contextCurrent(store, ledger, context, epoch);

  let proofAvailable = true;

  return {
    async isCurrent(): Promise<boolean> {
      if (!current()) return false;
      const account = await getManagedAccount({ fresh: true });
      if (!current()) return false;

      if (account?.email !== scope.managedAccount) {
        clearResourceVaultScopes(store);

        return false;
      }

      const generation = await context!.ready;
      if (!current()) return false;

      if (generation !== undefined) {
        let now: number | undefined;

        try {
          now = await context!.db.getResourceVaultGeneration?.(context!.scope);
        } catch {
          proofAvailable = false;

          return current();
        }

        if (!current()) return false;

        if (now === undefined) {
          proofAvailable = false;

          return true;
        }

        if (now !== generation) {
          ledger.contexts.delete(context!.scope.drive);
          notify(ledger);

          return false;
        }
      }

      return true;
    },
    async confirm(proof: ConfirmedVaultExport): Promise<void> {
      if (
        !proofAvailable ||
        !current() ||
        !context ||
        !context.db.putResourceVaultReceipts
      )
        return;
      const generation = await context.ready;
      if (!current() || generation === undefined) return;
      const receipts: SerializedVaultReceipt[] = [];

      for (const [rawSubject, version] of Object.entries(
        proof.resourceVersions,
      )) {
        const subject = store.normalizeSubject(rawSubject);
        const receipt = parseSerializedVaultReceipt({
          subject,
          version,
          confirmedAt: proof.confirmedAt,
        });
        if (
          !receipt ||
          store.isDestroyed(subject) ||
          store.hasPendingDestroy(subject)
        )
          continue;
        receipts.push(receipt);
      }

      if (!receipts.length) return;
      store.startScheduledSave();

      try {
        const persisted = await context.db.putResourceVaultReceipts(
          context.scope,
          receipts,
          generation,
        );
        if (!current()) return;

        if (!persisted) {
          ledger.contexts.delete(context.scope.drive);
          notify(ledger);

          return;
        }

        for (const receipt of receipts) {
          if (
            !store.isDestroyed(receipt.subject) &&
            !store.hasPendingDestroy(receipt.subject)
          )
            mergeReceipt(context, receipt);
        }

        notify(ledger);
      } catch {
        // Successful remote publication is not failed by diagnostic storage;
        // without an accepted generation-bound write we withhold new proof.
      } finally {
        store.finishScheduledSave();
      }
    },
  };
}
