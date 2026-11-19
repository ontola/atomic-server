// @wc-ignore-file
import {
  StoreEvents,
  parseAttachmentManifest,
  resourceAttachmentDescriptor,
  type AttachmentManifest,
  LoroLoader,
  canonicalizeScheme,
  core,
  normalizeVaultSyncScope,
  parseSerializedReceipt,
  type Resource,
  type Store,
  type VaultSyncScope,
  type SerializedReceipt,
  type ResourceReceipts,
} from '@tomic/lib';
import { getManagedApiBase } from './api';
import {
  getManagedAccount,
  onManagedLogout,
  onManagedSessionChanged,
} from './session';

export type ConfirmedVaultExport = {
  objectKey: string;
  resourceVersions: Record<string, Record<string, number>>;
  confirmedAt: number;
};

export type VaultReceiptDb = {
  vaultAttachmentManifests?: (
    drive: string,
  ) => Promise<{ subject: string; manifest: AttachmentManifest }[] | undefined>;
  getResourceVaultGeneration?: (
    scope: VaultSyncScope,
  ) => Promise<number | undefined>;
  getResourceReceipts?: (
    subjects: string[],
    scope: { vault: VaultSyncScope },
  ) => Promise<ResourceReceipts[] | undefined>;
  putResourceReceipts?: (
    scope: { vault: VaultSyncScope },
    receipts: SerializedReceipt[],
    generation: number,
  ) => Promise<boolean>;
  clearResourceVaultReceipts?: (scope: VaultSyncScope) => Promise<void>;
};
type Context = {
  scope: VaultSyncScope;
  db: VaultReceiptDb;
  storeDb: ReturnType<Store['getClientDb']>;
  attachmentReads: Map<string, object>;
  attachmentQueued: Map<string, object>;
  reads: Map<string, object>;
  queued: Map<string, object>;
  ready: Promise<number | undefined>;
};
type Ledger = {
  contexts: Map<string, Context>;
  listeners: Set<{ resource: Resource }>;
  epoch: number;
  attachmentEpoch: number;
};
const ledgers = new WeakMap<Store, Ledger>();

/** The tracker's destination for one drive's Vault; its receipts live there. */
const destination = (drive: string) => `vault:${drive}`;

/** Forget a drive's Vault context together with everything it proved. */
function forget(store: Store, ledger: Ledger, drive: string): void {
  ledger.contexts.delete(drive);
  store.resetReceipts(destination(drive));
}

export function clearResourceVaultScopes(store: Store): void {
  const ledger = ledgers.get(store);
  if (!ledger) return;
  ledger.epoch++;
  ledger.contexts.clear();
  store.resetReceipts('vault');
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
  for (const context of removed) forget(store, ledger, context.scope.drive);

  for (const context of ledger.contexts.values()) {
    context.reads.clear();
    context.queued.clear();
  }

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
    epoch: 0,
    attachmentEpoch: 0,
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
  // The tracker drops the receipts of an evicted resource; here only the
  // reads in flight for it (and for roots listing it) must not land.
  store.on(StoreEvents.ResourcePeerEvidenceRemoved, subject => {
    current.attachmentEpoch++;
    const normalized = store.normalizeSubject(subject);

    for (const ctx of current.contexts.values()) {
      for (const root of [normalized, ...ctx.attachmentReads.keys()]) {
        ctx.attachmentReads.delete(root);
        ctx.attachmentQueued.delete(root);
      }

      ctx.reads.delete(normalized);
      ctx.queued.delete(normalized);
    }
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
  ensureAttachmentEvidence(store, ledger, resource);
  const context = contextFor(store, ledger, resource);
  const subject = store.normalizeSubject(resource.subject);
  if (
    !context ||
    !context.db.getResourceReceipts ||
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
    void context.db.getResourceReceipts!(subjects, { vault: context.scope })
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
          const receipt = row.receipts
            .map(stored => parseSerializedReceipt(stored))
            .find(parsed => parsed && !parsed.manifest);
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
          store.acknowledgeReceipt({
            destination: destination(context.scope.drive),
            ...receipt,
            subject: rowSubject,
          });
        }
      })
      .catch(() => {
        /* Missing durable proof remains unknown. */
      });
  });
}

/** Subscribe to a resource's copies and, for as long as it is watched, recover
 * its durable Vault proof once the scope is bound. Rendering never starts a
 * backup; proof is read from the database, never requested from the account.
 */
export function subscribeResourceCopiesWithVault(
  store: Store,
  resource: Resource,
  callback: () => void,
): () => void {
  const ledger = ledgerFor(store);
  const listener = { resource };
  ledger.listeners.add(listener);
  ensureEvidence(store, ledger, resource);
  const stop = store.subscribeResourceCopies(resource, () => {
    ensureEvidence(store, ledger, resource);
    callback();
  });

  return () => {
    stop();
    ledger.listeners.delete(listener);
  };
}

function ensureAttachmentEvidence(
  store: Store,
  ledger: Ledger,
  resource: Resource,
): void {
  const context = contextFor(store, ledger, resource);
  const requestedSubject = store.normalizeSubject(resource.subject);
  if (
    !context?.db.getResourceReceipts ||
    context.attachmentReads.has(requestedSubject) ||
    store.isDestroyed(requestedSubject) ||
    store.hasPendingDestroy(requestedSubject)
  )
    return;
  const readToken = {};
  context.attachmentReads.set(requestedSubject, readToken);
  context.attachmentQueued.set(requestedSubject, readToken);
  if (context.attachmentQueued.size > 1) return;
  const epoch = ledger.epoch;
  const attachmentEpoch = ledger.attachmentEpoch;
  queueMicrotask(() => {
    const queued = new Map(context.attachmentQueued);
    context.attachmentQueued.clear();
    if (!contextCurrent(store, ledger, context, epoch)) return;
    const subjects = [...queued.keys()];

    const read = async () => {
      const receipts: SerializedReceipt[] = [];

      for (let offset = 0; offset < subjects.length; offset += 128) {
        if (!contextCurrent(store, ledger, context, epoch)) return [];
        const rows = await context.db.getResourceReceipts!(
          subjects.slice(offset, offset + 128),
          { vault: context.scope },
        );
        receipts.push(
          ...(rows ?? []).flatMap(row =>
            row.receipts.filter(receipt => receipt.manifest),
          ),
        );
      }

      return receipts;
    };

    void read()
      .then(async receipts => {
        const generation = await context.ready;
        const now = await context.db.getResourceVaultGeneration?.(
          context.scope,
        );
        if (
          generation === undefined ||
          generation !== now ||
          !contextCurrent(store, ledger, context, epoch)
        )
          return;

        // An eviction while reading may have removed a file a listed root
        // depends on; let the next watcher read again instead.
        if (ledger.attachmentEpoch !== attachmentEpoch) {
          for (const [subject, token] of queued)
            if (context.attachmentReads.get(subject) === token)
              context.attachmentReads.delete(subject);

          return;
        }

        for (const receipt of receipts ?? []) {
          const subject = store.normalizeSubject(receipt.subject);
          const manifest = parseAttachmentManifest(receipt.manifest);
          if (
            !manifest ||
            !Number.isSafeInteger(receipt.confirmedAt) ||
            receipt.confirmedAt < 0 ||
            !queued.has(subject) ||
            context.attachmentReads.get(subject) !== queued.get(subject) ||
            store.isDestroyed(subject) ||
            store.hasPendingDestroy(subject)
          )
            continue;
          store.acknowledgeReceipt({
            destination: destination(context.scope.drive),
            subject,
            version: {},
            manifest,
            confirmedAt: receipt.confirmedAt,
          });
        }
      })
      .catch(() => {
        for (const [subject, token] of queued)
          if (context.attachmentReads.get(subject) === token)
            context.attachmentReads.delete(subject);
      });
  });
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
    attachmentReads: new Map(),
    attachmentQueued: new Map(),
    reads: new Map(),
    queued: new Map(),
    ready: Promise.resolve(undefined),
  };
  // A generation read is diagnostic: unsupported or broken storage withholds
  // new proof while the existing backup flow remains available.
  context.ready =
    db.getResourceVaultGeneration?.(scope).catch(() => undefined) ??
    Promise.resolve(undefined);
  // A context replaced for the same drive starts with no proof of its own.
  store.resetReceipts(destination(scope.drive));
  ledger.contexts.set(scope.drive, context);
  for (const listener of ledger.listeners)
    ensureEvidence(store, ledger, listener.resource);
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

  // Capture identities before upload; never infer an exported file from a later edit.
  const attachmentEpoch = ledger.attachmentEpoch;
  let attachmentCandidates = [...store.resources.values()].flatMap(resource => {
    if (!context || contextFor(store, ledger, resource) !== context) return [];
    const manifest = resourceAttachmentDescriptor(store, resource).manifest;

    return manifest?.files.length
      ? [{ subject: store.normalizeSubject(resource.subject), manifest }]
      : [];
  });
  const attachmentReady =
    db
      .vaultAttachmentManifests?.(scope.drive)
      .then(rows => {
        if (!current() || ledger.attachmentEpoch !== attachmentEpoch || !rows)
          return;
        attachmentCandidates = rows.flatMap(row => {
          const manifest = parseAttachmentManifest(row.manifest);

          return manifest?.files.length
            ? [{ subject: store.normalizeSubject(row.subject), manifest }]
            : [];
        });
      })
      .catch(() => {
        attachmentCandidates = [];
      }) ?? Promise.resolve();
  let proofAvailable = true;

  return {
    async isCurrent(): Promise<boolean> {
      await attachmentReady;
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
          forget(store, ledger, context!.scope.drive);

          return false;
        }
      }

      return true;
    },
    async confirmAttachments(hashes: readonly string[]): Promise<void> {
      await attachmentReady;
      if (
        !proofAvailable ||
        !current() ||
        ledger.attachmentEpoch !== attachmentEpoch ||
        !context?.db.putResourceReceipts
      )
        return;
      const generation = await context.ready;
      if (
        generation === undefined ||
        !current() ||
        ledger.attachmentEpoch !== attachmentEpoch
      )
        return;
      const verified = new Set(hashes);
      const receipts: SerializedReceipt[] = attachmentCandidates
        .filter(
          row =>
            row.manifest.files.every(
              file =>
                verified.has(file.hash) &&
                file.chunks.every(hash => verified.has(hash)),
            ) &&
            !store.isDestroyed(row.subject) &&
            !store.hasPendingDestroy(row.subject),
        )
        .map(row => ({ ...row, version: {}, confirmedAt: Date.now() }));
      if (!receipts.length) return;
      store.startScheduledSave();

      try {
        for (let offset = 0; offset < receipts.length; offset += 128) {
          if (!current() || ledger.attachmentEpoch !== attachmentEpoch) return;
          const attachmentAccepted = await context.db.putResourceReceipts(
            { vault: context.scope },
            receipts.slice(offset, offset + 128),
            generation,
          );

          if (!current() || ledger.attachmentEpoch !== attachmentEpoch) return;

          if (!attachmentAccepted) {
            forget(store, ledger, context.scope.drive);

            return;
          }
        }

        for (const receipt of receipts)
          store.acknowledgeReceipt({
            destination: destination(context.scope.drive),
            ...receipt,
          });
      } catch {
        /* Diagnostic failure cannot fail successful encrypted storage. */
      } finally {
        store.finishScheduledSave();
      }
    },
    async confirm(proof: ConfirmedVaultExport): Promise<void> {
      if (
        !proofAvailable ||
        !current() ||
        !context ||
        !context.db.putResourceReceipts
      )
        return;
      const generation = await context.ready;
      if (!current() || generation === undefined) return;
      const receipts: SerializedReceipt[] = [];

      for (const [rawSubject, version] of Object.entries(
        proof.resourceVersions,
      )) {
        const subject = store.normalizeSubject(rawSubject);
        const receipt = parseSerializedReceipt({
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
        const persisted = await context.db.putResourceReceipts(
          { vault: context.scope },
          receipts,
          generation,
        );
        if (!current()) return;

        if (!persisted) {
          forget(store, ledger, context.scope.drive);

          return;
        }

        for (const receipt of receipts)
          store.acknowledgeReceipt({
            destination: destination(context.scope.drive),
            ...receipt,
          });
      } catch {
        // Successful remote publication is not failed by diagnostic storage;
        // without an accepted generation-bound write we withhold new proof.
      } finally {
        store.finishScheduledSave();
      }
    },
  };
}
