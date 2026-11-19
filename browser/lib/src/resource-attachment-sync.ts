import { StoreEvents, type Store } from './store.js';
import { ResourceEvents, type Resource } from './resource.js';
import { resourceAttachmentDescriptor } from './attachment-manifest.js';
import {
  parseResourceAttachmentEvidence,
  type Receipt,
  type ResourceAttachmentEvidenceProvider,
} from './resource-receipts.js';
import type { ResourceCopiesTracker } from './resource-copies.js';
import { withDeadline } from './withDeadline.js';

type Watch = {
  resource: Resource;
  count: number;
  subscriptions: (() => void)[];
  dependencies: string[];
  boundResources?: (Resource | undefined)[];
};

/** Transport for file-contents proof of the local database and the server: it
 * only produces receipts. Byte evidence has its own identity; a metadata-only
 * edit does not alter it.
 */
export class ResourceAttachmentSync {
  private watches = new Map<Resource, Watch>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private cursor = 0;
  private abort?: AbortController;
  private global: (() => void)[] = [];
  private pending = new WeakMap<object, Promise<unknown>>();
  constructor(
    private store: Store,
    private tracker: ResourceCopiesTracker,
    private fetchServer: (
      subjects: string[],
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}

  private notify(subject?: string): void {
    const normalized = subject && this.store.normalizeSubject(subject);

    for (const watch of this.watches.values())
      if (!normalized || watch.dependencies.includes(normalized))
        this.tracker.changed(
          this.store.normalizeSubject(watch.resource.subject),
        );
  }
  private refresh = (): void => {
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

    watch.subscriptions = [];

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
  /** Start proving this resource's contents; the result is the stop function. */
  watch(resource: Resource): () => void {
    resource = resource.__internalObject;
    let watch = this.watches.get(resource);

    if (!watch) {
      watch = { resource, count: 0, subscriptions: [], dependencies: [] };
      this.watches.set(resource, watch);
      this.bind(watch);
    }

    watch.count++;
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
    const own = watch;

    return () => {
      if (--own.count) return;
      own.subscriptions.forEach(off => off());
      this.watches.delete(resource);

      if (!this.watches.size) {
        this.global.forEach(off => off());
        this.global = [];
        clearTimeout(this.timer);
        this.timer = undefined;
        this.abort?.abort();
      }
    };
  }
  /** An evicted resource invalidates the proof of every root listing it. */
  remove(subject: string): void {
    subject = this.store.normalizeSubject(subject);

    for (const watch of this.watches.values())
      if (watch.dependencies.includes(subject))
        this.tracker.remove(
          this.store.normalizeSubject(watch.resource.subject),
        );
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
    const fences = new Map(
      subjects.flatMap(subject =>
        ['local', 'server'].map(
          destination =>
            [
              destination + subject,
              this.tracker.fence(destination, subject),
            ] as const,
        ),
      ),
    );
    const valid = (destination: string, subject: string) =>
      this.tracker.fence(destination, subject) ===
        fences.get(destination + subject) &&
      subjects.includes(subject) &&
      [...this.watches.keys()].some(
        r => this.store.normalizeSubject(r.subject) === subject,
      ) &&
      !this.store.isDestroyed(subject) &&
      !this.store.hasPendingDestroy(subject);

    const apply = (destination: string, raw: unknown) => {
      const rows = parseResourceAttachmentEvidence(raw);
      const accepted = subjects.filter(s => valid(destination, s));
      const receipts: Receipt[] = [];

      for (const row of rows ?? []) {
        const subject = this.store.normalizeSubject(row.subject);
        if (
          accepted.includes(subject) &&
          row.state === 'confirmed' &&
          row.manifest
        )
          receipts.push({
            destination,
            subject,
            version: {},
            manifest: row.manifest,
            confirmedAt: row.confirmedAt!,
          });
      }

      this.tracker.replace(destination, accepted, receipts, true);
    };

    const controller = new AbortController();
    this.abort = controller;

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
        apply('local', await withDeadline<unknown>(promise, 5000, undefined));
      };

      const remote = async () => {
        const remoteSubjects = subjects.filter(subject => {
          const resource = this.store.resources.get(subject);

          return (
            resource && !!this.store.getResourceCopies(resource).server.url
          );
        });
        if (
          !remoteSubjects.length ||
          !this.store.getAgent() ||
          !this.store.getServerUrl()
        )
          return;
        apply(
          'server',
          await withDeadline<unknown>(
            this.fetchServer(remoteSubjects, controller.signal),
            5000,
            undefined,
          ),
        );
      };

      await Promise.all([local(), remote()]);
    } finally {
      if (this.abort === controller) this.abort = undefined;
      this.running = false;
      this.notify();
      if (this.watches.size)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.poll();
        }, 2000);
    }
  }
}
