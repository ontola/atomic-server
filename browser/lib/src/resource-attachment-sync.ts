import { StoreEvents, type Store } from './store.js';
import { ResourceEvents, type Resource } from './resource.js';
import type { ReplicaIdentity } from './peer-receipts.js';
import {
  attachmentManifestKey,
  parseResourceAttachmentEvidence,
  resourceAttachmentDescriptor,
  type AttachmentManifest,
  type ResourceAttachmentEvidenceProvider,
  type ResourceAttachmentSyncStatus,
  type AttachmentCopyStatus,
} from './resource-attachment-evidence.js';

export interface AttachmentPeerReceipt {
  subject: string;
  version: string;
  manifest: AttachmentManifest;
  confirmedAt: number;
  connectionId: string;
  source: ReplicaIdentity;
  replica: ReplicaIdentity;
}
type Proof = { manifest: AttachmentManifest; confirmedAt: number };
type Watch = {
  resource: Resource;
  callbacks: Set<() => void>;
  subscriptions: (() => void)[];
  dependencies: string[];
  boundResources?: (Resource | undefined)[];
  token: object;
};
const UNKNOWN: AttachmentCopyStatus = Object.freeze({ state: 'unknown' });

/** Byte evidence has its own identity; a metadata-only edit does not alter it. */
export class ResourceAttachmentSync {
  private watches = new Map<Resource, Watch>();
  private local = new Map<string, Proof>();
  private server = new Map<string, Proof>();
  private peers = new Map<string, Map<string, AttachmentPeerReceipt>>();
  private snapshots = new WeakMap<Resource, ResourceAttachmentSyncStatus>();
  private scope?: string;
  private db?: ReturnType<Store['getClientDb']>;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private disposed = false;
  private cursor = 0;
  private abort?: AbortController;
  private global: (() => void)[] = [];
  private pending = new WeakMap<object, Promise<unknown>>();
  constructor(
    private store: Store,
    private fetchServer: (
      subjects: string[],
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}

  private currentScope(): string {
    return JSON.stringify([
      this.store.getPeerSyncGeneration(),
      this.store.getAgent()?.subject,
      this.store.getServerUrl(),
    ]);
  }
  private syncScope(): void {
    const scope = this.currentScope();
    const db = this.store.getClientDb();
    if (scope === this.scope && db === this.db) return;
    this.scope = scope;
    this.db = db;
    this.epoch++;
    this.local.clear();
    this.server.clear();
    this.peers.clear();
  }
  private notify(subject?: string): void {
    for (const watch of this.watches.values())
      if (
        !subject ||
        watch.dependencies.includes(this.store.normalizeSubject(subject))
      )
        for (const callback of watch.callbacks) {
          try {
            callback();
          } catch {
            /* Diagnostics cannot fail a save. */
          }
        }
  }
  private refresh = (): void => {
    this.syncScope();
    for (const watch of this.watches.values()) this.bind(watch);
    this.notify();
    this.schedule();
  };
  private bind(watch: Watch): void {
    const descriptor = resourceAttachmentDescriptor(this.store, watch.resource);
    const boundResources = descriptor.dependencies.map(subject =>
      this.store.resources.get(subject),
    );
    if (
      JSON.stringify(descriptor.dependencies) ===
        JSON.stringify(watch.dependencies) &&
      watch.subscriptions.length &&
      boundResources.every(
        (resource, index) => resource === watch.boundResources?.[index],
      )
    )
      return;
    watch.boundResources = boundResources;
    watch.subscriptions.forEach(off => off());
    watch.dependencies = descriptor.dependencies;

    const changed = () => {
      this.bind(watch);
      this.notify(watch.resource.subject);
      this.schedule();
    };

    watch.subscriptions = [
      this.store.subscribeResourcePeerSyncStatus(watch.resource, () =>
        this.notify(watch.resource.subject),
      ),
    ];

    for (const subject of watch.dependencies) {
      watch.subscriptions.push(this.store.subscribe(subject, changed));
      const resource = this.store.resources.get(subject);
      if (resource)
        watch.subscriptions.push(
          resource.on(ResourceEvents.LocalChange, changed),
        );
    }

    // Resolve direct attachment references once outside the snapshot getter.
    for (const subject of watch.dependencies)
      if (!this.store.resources.has(subject))
        void this.store.getResource(subject).catch(() => {});
  }
  subscribe(resource: Resource, callback: () => void): () => void {
    resource = resource.__internalObject;
    this.disposed = false;
    this.syncScope();
    let watch = this.watches.get(resource);

    if (!watch) {
      watch = {
        resource,
        callbacks: new Set(),
        subscriptions: [],
        dependencies: [],
        token: {},
      };
      this.watches.set(resource, watch);
      this.bind(watch);
    }

    watch.callbacks.add(callback);
    if (!this.global.length)
      this.global = [
        this.store.on(StoreEvents.SyncStatusChanged, this.refresh),
        this.store.on(StoreEvents.AgentChanged, this.refresh),
        this.store.on(StoreEvents.ServerURLChanged, this.refresh),
        this.store.on(StoreEvents.ResourceUpdated, updated => {
          const subject = this.store.normalizeSubject(updated.subject);
          for (const watched of this.watches.values())
            if (watched.dependencies.includes(subject)) this.bind(watched);
          this.notify(subject);
          this.schedule();
        }),
      ];
    this.schedule();

    return () => {
      watch!.callbacks.delete(callback);

      if (!watch!.callbacks.size) {
        watch!.subscriptions.forEach(off => off());
        this.watches.delete(resource);
        const subject = this.store.normalizeSubject(resource.subject);

        if (
          ![...this.watches.keys()].some(
            other => this.store.normalizeSubject(other.subject) === subject,
          )
        ) {
          this.local.delete(subject);
          this.server.delete(subject);
        }
      }

      if (!this.watches.size) {
        this.global.forEach(off => off());
        this.global = [];
        clearTimeout(this.timer);
        this.timer = undefined;
        this.epoch++;
        this.abort?.abort();
        this.disposed = true;
        this.local.clear();
        this.server.clear();
      }
    };
  }
  remove(subject: string): void {
    subject = this.store.normalizeSubject(subject);
    for (const rows of [this.local, this.server, ...this.peers.values()])
      for (const [root, proof] of rows)
        if (
          root === subject ||
          proof.manifest.files.some(
            file => this.store.normalizeSubject(file.subject) === subject,
          )
        )
          rows.delete(root);

    for (const watch of this.watches.values())
      if (watch.dependencies.includes(subject)) {
        watch.token = {};
        const root = this.store.normalizeSubject(watch.resource.subject);
        this.local.delete(root);
        this.server.delete(root);
        for (const receipts of this.peers.values()) receipts.delete(root);
      }

    this.notify();
  }
  closePeer(connection: string): void {
    this.peers.delete(connection);
    this.notify();
  }
  acknowledge(receipt: AttachmentPeerReceipt): void {
    this.syncScope();
    if (
      this.store.isDestroyed(receipt.subject) ||
      this.store.hasPendingDestroy(receipt.subject) ||
      receipt.source.storageId === receipt.replica.storageId
    )
      return;
    let rows = this.peers.get(receipt.connectionId);

    if (!rows) {
      rows = new Map();
      this.peers.set(receipt.connectionId, rows);
    }

    const old = rows.get(receipt.subject);
    if (old && old.confirmedAt > receipt.confirmedAt) return;
    rows.set(this.store.normalizeSubject(receipt.subject), receipt);
    while (rows.size > 128) rows.delete(rows.keys().next().value!);
    this.notify(receipt.subject);
  }
  replaceNative(subject: string, receipts: AttachmentPeerReceipt[]): void {
    for (const [id, rows] of this.peers)
      if (id.startsWith('iroh:')) rows.delete(subject);
    for (const receipt of receipts) this.acknowledge(receipt);
    this.notify(subject);
  }
  get(resource: Resource): ResourceAttachmentSyncStatus {
    resource = resource.__internalObject;
    const descriptor = resourceAttachmentDescriptor(this.store, resource);
    const subject = this.store.normalizeSubject(resource.subject);
    const current =
      this.scope === this.currentScope() &&
      this.db === this.store.getClientDb();
    const state = (proof: Proof | undefined): AttachmentCopyStatus =>
      !current || !proof
        ? UNKNOWN
        : descriptor.manifest &&
            attachmentManifestKey(proof.manifest) ===
              attachmentManifestKey(descriptor.manifest)
          ? { state: 'confirmed', confirmedAt: proof.confirmedAt }
          : { state: 'pending', confirmedAt: proof.confirmedAt };
    const serverUrl = this.store.getResourceSyncStatus(resource).server.url;
    const peers = this.store
      .getResourcePeerSyncStatus(resource)
      .peers.map(peer => {
        const receipt = this.peers.get(peer.connectionId)?.get(subject);
        const matching =
          receipt &&
          receipt.replica.storageId === peer.storageId &&
          receipt.replica.generation === peer.generation &&
          receipt.confirmedAt <= Date.now() &&
          Date.now() - receipt.confirmedAt < 30_000;

        return {
          ...state(matching ? receipt : undefined),
          connectionId: peer.connectionId,
          storageId: peer.storageId,
          generation: peer.generation,
        };
      });
    const value: ResourceAttachmentSyncStatus = {
      required: descriptor.required,
      manifest: descriptor.manifest,
      local: this.store.getClientDb()
        ? state(this.local.get(subject))
        : { state: 'unavailable' },
      server: serverUrl
        ? { ...state(this.server.get(subject)), url: serverUrl }
        : { state: 'not-configured' },
      peers,
    };
    const old = this.snapshots.get(resource);
    if (old && JSON.stringify(old) === JSON.stringify(value)) return old;
    this.snapshots.set(resource, Object.freeze(value));

    return value;
  }
  private schedule(): void {
    if (this.running || this.timer || !this.watches.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, 0);
  }
  private async poll(): Promise<void> {
    if (this.running || !this.watches.size) return;
    this.running = true;
    this.syncScope();
    const epoch = this.epoch;
    const candidates = [...this.watches.values()].filter(
      w => resourceAttachmentDescriptor(this.store, w.resource).required,
    );
    const watched = Array.from(
      { length: Math.min(128, candidates.length) },
      (_, index) => candidates[(this.cursor + index) % candidates.length],
    );
    this.cursor = candidates.length
      ? (this.cursor + watched.length) % candidates.length
      : 0;
    const subjects = watched.map(w =>
      this.store.normalizeSubject(w.resource.subject),
    );
    const tokens = new Map(watched.map(w => [w, w.token]));
    const valid = (subject: string) =>
      epoch === this.epoch &&
      !this.disposed &&
      watched.some(
        w =>
          this.watches.get(w.resource) === w &&
          w.token === tokens.get(w) &&
          this.store.normalizeSubject(w.resource.subject) === subject,
      ) &&
      !this.store.isDestroyed(subject) &&
      !this.store.hasPendingDestroy(subject);

    const apply = (raw: unknown, target: Map<string, Proof>) => {
      const rows = parseResourceAttachmentEvidence(raw);
      for (const subject of subjects)
        if (valid(subject)) target.delete(subject);

      for (const row of rows ?? []) {
        const subject = this.store.normalizeSubject(row.subject);
        if (valid(subject) && row.state === 'confirmed' && row.manifest)
          target.set(subject, {
            manifest: row.manifest,
            confirmedAt: row.confirmedAt!,
          });
      }
    };

    const controller = new AbortController();
    this.abort = controller;
    const deadline = setTimeout(() => controller.abort(), 5000);
    const bounded = async (promise: Promise<unknown>) =>
      Promise.race([
        promise,
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('Attachment query timed out')),
            { once: true },
          ),
        ),
      ]);

    try {
      const provider = this.store.getClientDb() as
        | (ResourceAttachmentEvidenceProvider & object)
        | undefined;

      const local = async () => {
        if (!subjects.length || !provider?.getResourceAttachmentEvidence)
          return;
        if (this.pending.has(provider)) return;
        const promise = provider.getResourceAttachmentEvidence(subjects);
        this.pending.set(provider, promise);
        void promise
          .finally(() => {
            if (this.pending.get(provider) === promise)
              this.pending.delete(provider);
          })
          .catch(() => {});

        try {
          apply(await bounded(promise), this.local);
        } catch {
          apply(undefined, this.local);
        }
      };

      const remote = async () => {
        const remoteSubjects = subjects.filter(subject => {
          const resource = this.store.resources.get(subject);

          return (
            resource && !!this.store.getResourceSyncStatus(resource).server.url
          );
        });
        if (
          !remoteSubjects.length ||
          !this.store.getAgent() ||
          !this.store.getServerUrl()
        )
          return;

        try {
          apply(
            await bounded(this.fetchServer(remoteSubjects, controller.signal)),
            this.server,
          );
        } catch {
          apply(undefined, this.server);
        }
      };

      await Promise.all([local(), remote()]);
    } finally {
      clearTimeout(deadline);
      if (this.abort === controller) this.abort = undefined;
      this.running = false;
      if (epoch === this.epoch) this.notify();
      if (this.watches.size)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.poll();
        }, 2000);
    }
  }
}
