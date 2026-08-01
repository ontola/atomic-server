import { CollectionBuilder } from './collectionBuilder.js';
import {
  applyMentionsProperty,
  extractAgentMentionsFromText,
  extractAgentMentionsFromTipTap,
  isAgentSubject,
  mentionDedupeKey,
  resourceActor,
  type MentionScanNode,
  watchDedupeKey,
} from './mentions.js';
import { collections } from './ontologies/collections.js';
import { core } from './ontologies/core.js';
import { dataBrowser } from './ontologies/dataBrowser.js';
import { notifications } from './ontologies/notifications.js';
import type { Resource } from './resource.js';
import { Store, StoreEvents } from './store.js';

export type NotificationType =
  | 'mention'
  | 'watch-membership'
  | 'watch-content';

export type WatchKind = 'membership' | 'content' | 'both';

export interface NotificationEngineOptions {
  store: Store;
  /** Current agent subject (`did:ad:agent:…`). */
  agentSubject: string;
  /** Personal drive where NotificationItems / watches live. */
  personalDrive: string;
  /**
   * Resolve (and lazily create) the notifications folder under the personal
   * drive. Injected so the engine stays free of UI folder helpers.
   */
  getNotificationsFolder: (
    store: Store,
    personalDrive: string,
  ) => Promise<string>;
  /**
   * Watch-event coalesce window (ms). Default 2000. Tests may pass `0` (or a
   * small value) and call {@link NotificationEngine.flushPendingWatches}.
   */
  watchCoalesceMs?: number;
}

type Listener = () => void;

type WatchEntry = {
  subject: string;
  kind: WatchKind;
  mutedUntil?: number;
  enabled: boolean;
};

/**
 * Materializes personal `NotificationItem`s from drive traffic the recipient
 * can already read. Mentions: `mentions` contains me. Watches: membership /
 * content deltas against enabled `WatchSubscription`s.
 *
 * Idempotent via `dedupeKey`. Does not own push / OS delivery — callers
 * subscribe and present.
 */
export class NotificationEngine {
  private readonly store: Store;
  private readonly agentSubject: string;
  private readonly personalDrive: string;
  private readonly getNotificationsFolder: NotificationEngineOptions['getNotificationsFolder'];
  private readonly watchCoalesceMs: number;

  private unsubUpdated?: () => void;
  private unsubRemoved?: () => void;
  private folderSubject?: string;
  private started = false;
  private readonly listeners = new Set<Listener>();
  /** In-memory dedupe of keys we've already upserted this session. */
  private readonly seenKeys = new Set<string>();
  /** watchTarget → WatchSubscription */
  private watches = new Map<string, WatchEntry>();
  /** Coalesce bursts: `${type}|${watchTarget}` → pending */
  private readonly watchCoalesce = new Map<
    string,
    {
      count: number;
      about: string;
      actor: string;
      type: NotificationType;
      watchTarget: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Optional presenter hook (OS banner / toast). Fired only when a new
   * NotificationItem is created — not on dedupe hits or mark-read.
   */
  private onItemCreated?: (item: {
    subject: string;
    summary: string;
    about: string;
    type: NotificationType;
  }) => void;

  constructor(opts: NotificationEngineOptions) {
    this.store = opts.store;
    this.agentSubject = opts.agentSubject;
    this.personalDrive = opts.personalDrive;
    this.getNotificationsFolder = opts.getNotificationsFolder;
    this.watchCoalesceMs = opts.watchCoalesceMs ?? 2000;
  }

  /** Wire OS / toast presentation without coupling the engine to UI. */
  setOnItemCreated(
    cb?: (item: {
      subject: string;
      summary: string;
      about: string;
      type: NotificationType;
    }) => void,
  ): void {
    this.onItemCreated = cb;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.folderSubject = await this.getNotificationsFolder(
      this.store,
      this.personalDrive,
    );
    await this.reloadWatches();
    await this.reconcileMentionBacklog();

    this.unsubUpdated = this.store.on(
      StoreEvents.ResourceUpdated,
      resource => {
        void this.onResourceUpdated(resource);
      },
    );
    this.unsubRemoved = this.store.on(StoreEvents.ResourceRemoved, () => {
      // Membership leave deferred — enter is the valuable v1 signal.
    });
  }

  stop(): void {
    this.unsubUpdated?.();
    this.unsubRemoved?.();
    this.unsubUpdated = undefined;
    this.unsubRemoved = undefined;

    for (const pending of this.watchCoalesce.values()) {
      clearTimeout(pending.timer);
    }

    this.watchCoalesce.clear();
    this.started = false;
  }

  /**
   * Flush coalesced watch events immediately (clears timers). Used by tests
   * and e2e so they need not wait the full coalesce window.
   */
  async flushPendingWatches(): Promise<void> {
    const keys = [...this.watchCoalesce.keys()];

    for (const key of keys) {
      const pending = this.watchCoalesce.get(key);

      if (pending) {
        clearTimeout(pending.timer);
      }

      await this.flushWatchCoalesce(key);
    }
  }

  /** Refresh WatchSubscription cache from the personal drive. */
  async reloadWatches(): Promise<void> {
    const collection = await new CollectionBuilder(this.store)
      .setDrive(this.personalDrive)
      .setProperty(core.properties.isA)
      .setValue(notifications.classes.watchSubscription)
      .setPageSize(100)
      .buildAndFetch();

    const next = new Map<string, WatchEntry>();

    for (let i = 0; i < collection.totalMembers; i++) {
      const subject = await collection.getMemberWithIndex(i);

      if (!subject) {
        continue;
      }

      const res = await this.store.getResource(subject);
      const target = res.get(notifications.properties.watchTarget);

      if (typeof target !== 'string') {
        continue;
      }

      const kind =
        (res.get(notifications.properties.watchKind) as WatchKind | undefined) ??
        'membership';
      const enabled =
        (res.get(notifications.properties.notificationEnabled) as
          | boolean
          | undefined) ?? true;
      const mutedUntil = res.get(notifications.properties.mutedUntil) as
        | number
        | undefined;

      next.set(target, { subject, kind, mutedUntil, enabled });
    }

    this.watches = next;
  }

  /**
   * Boot-time reverse query: resources whose `mentions` contain me.
   * Creates missing NotificationItems (idempotent).
   */
  async reconcileMentionBacklog(): Promise<void> {
    const drives = new Set<string>();
    const current = this.store.getDrive();

    if (current) {
      drives.add(current);
    }

    drives.add(this.personalDrive);

    for (const drive of drives) {
      try {
        const collection = await new CollectionBuilder(this.store)
          .setDrive(drive)
          .setProperty(notifications.properties.mentions)
          .setValue(this.agentSubject)
          .setPageSize(50)
          .buildAndFetch();

        for (let i = 0; i < collection.totalMembers; i++) {
          const subject = await collection.getMemberWithIndex(i);

          if (!subject) {
            continue;
          }

          const res = await this.store.getResource(subject);
          await this.considerMentionResource(res);
        }
      } catch {
        // Drive may be unavailable offline — live updates still cover new ones.
      }
    }
  }

  private async onResourceUpdated(resource: Resource): Promise<void> {
    if (
      resource.getClasses().includes(notifications.classes.watchSubscription)
    ) {
      await this.reloadWatches();
    }

    await this.considerMentionResource(resource);
    await this.considerWatchResource(resource);
  }

  private isMuted(mutedUntil?: number): boolean {
    return typeof mutedUntil === 'number' && mutedUntil > Date.now();
  }

  private async considerMentionResource(resource: Resource): Promise<void> {
    if (
      resource.getClasses().includes(notifications.classes.notificationItem) ||
      resource
        .getClasses()
        .includes(notifications.classes.watchSubscription) ||
      resource
        .getClasses()
        .includes(notifications.classes.notificationPreferences)
    ) {
      return;
    }

    const mentioned = resource.get(notifications.properties.mentions) as
      | string[]
      | undefined;

    if (!Array.isArray(mentioned) || !mentioned.includes(this.agentSubject)) {
      return;
    }

    const actor = resourceActor(resource);

    if (!actor || actor === this.agentSubject) {
      return;
    }

    const key = mentionDedupeKey(
      resource.subject,
      actor,
      this.agentSubject,
    );

    if (this.seenKeys.has(key)) {
      return;
    }

    const title =
      (resource.get(core.properties.name) as string | undefined) ??
      resource.subject;
    const summary = `Mentioned you in ${title}`;

    await this.upsertItem({
      dedupeKey: key,
      type: 'mention',
      about: resource.subject,
      actor,
      mentionedAgent: this.agentSubject,
      summary,
      name: summary,
    });
  }

  private async resourceMatchesWatch(
    resource: Resource,
    target: string,
  ): Promise<boolean> {
    const parent = resource.get(core.properties.parent) as string | undefined;

    if (parent === target) {
      return true;
    }

    if (resource.subject === target) {
      return true;
    }

    try {
      const targetRes = await this.store.getResource(target);
      const targetClasses = targetRes.getClasses();

      if (targetClasses.includes(dataBrowser.classes.table)) {
        return parent === target;
      }

      if (targetClasses.includes(collections.classes.collection)) {
        const prop = targetRes.get(collections.properties.property) as
          | string
          | undefined;
        const value = targetRes.get(collections.properties.value) as
          | string
          | undefined;

        if (prop && value) {
          const actual = resource.get(prop);

          return Array.isArray(actual)
            ? actual.includes(value)
            : actual === value;
        }
      }
    } catch {
      return false;
    }

    return false;
  }

  private async considerWatchResource(resource: Resource): Promise<void> {
    if (this.watches.size === 0) {
      return;
    }

    const actor = resourceActor(resource);

    if (actor === this.agentSubject) {
      return;
    }

    for (const [target, watch] of this.watches) {
      if (!watch.enabled || this.isMuted(watch.mutedUntil)) {
        continue;
      }

      const matches = await this.resourceMatchesWatch(resource, target);

      if (!matches) {
        continue;
      }

      // Updating the watched resource itself is content; a new child is membership.
      const isTargetSelf = resource.subject === target;
      const type: NotificationType =
        isTargetSelf || watch.kind === 'content'
          ? 'watch-content'
          : 'watch-membership';

      if (watch.kind === 'membership' && isTargetSelf) {
        continue;
      }

      if (watch.kind === 'content' && !isTargetSelf) {
        // content-only watches still fire for member prop changes
      }

      this.queueWatchEvent(
        type,
        resource.subject,
        target,
        actor ?? 'unknown',
      );
    }
  }

  private queueWatchEvent(
    type: NotificationType,
    about: string,
    watchTarget: string,
    actor: string,
  ): void {
    const coalesceKey = `${type}|${watchTarget}`;
    const existing = this.watchCoalesce.get(coalesceKey);

    if (existing) {
      existing.count += 1;
      existing.about = about;
      existing.actor = actor;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        void this.flushWatchCoalesce(coalesceKey);
      }, this.watchCoalesceMs);

      return;
    }

    const timer = setTimeout(() => {
      void this.flushWatchCoalesce(coalesceKey);
    }, this.watchCoalesceMs);

    this.watchCoalesce.set(coalesceKey, {
      count: 1,
      about,
      actor,
      type,
      watchTarget,
      timer,
    });
  }

  private async flushWatchCoalesce(coalesceKey: string): Promise<void> {
    const pending = this.watchCoalesce.get(coalesceKey);
    this.watchCoalesce.delete(coalesceKey);

    if (!pending) {
      return;
    }

    const { type, watchTarget, about, actor, count } = pending;
    let targetTitle = watchTarget;

    try {
      const t = await this.store.getResource(watchTarget);
      targetTitle =
        (t.get(core.properties.name) as string | undefined) ?? watchTarget;
    } catch {
      // keep subject
    }

    const summary =
      count > 1 ? `${count} updates in ${targetTitle}` : `Update in ${targetTitle}`;

    const baseKey = watchDedupeKey(
      type === 'watch-content' ? 'watch-content' : 'watch-membership',
      about,
      watchTarget,
      actor,
    );
    // Time-bucket so coalesced groups don't collapse forever into one item.
    const bucketMs = Math.max(this.watchCoalesceMs, 1);
    const bucketKey = `${baseKey}|${Math.floor(Date.now() / bucketMs)}`;

    await this.upsertItem({
      dedupeKey: bucketKey,
      type,
      about,
      actor: actor === 'unknown' ? undefined : actor,
      watchTarget,
      summary,
      name: summary,
    });
  }

  private async upsertItem(input: {
    dedupeKey: string;
    type: NotificationType;
    about: string;
    actor?: string;
    mentionedAgent?: string;
    watchTarget?: string;
    summary: string;
    name: string;
  }): Promise<void> {
    if (this.seenKeys.has(input.dedupeKey)) {
      return;
    }

    this.seenKeys.add(input.dedupeKey);

    const folder =
      this.folderSubject ??
      (await this.getNotificationsFolder(this.store, this.personalDrive));
    this.folderSubject = folder;

    try {
      const existing = await new CollectionBuilder(this.store)
        .setDrive(this.personalDrive)
        .setProperty(notifications.properties.dedupeKey)
        .setValue(input.dedupeKey)
        .setPageSize(1)
        .buildAndFetch();

      if (existing.totalMembers > 0) {
        const subject = await existing.getMemberWithIndex(0);

        if (subject) {
          this.emit();

          return;
        }
      }
    } catch {
      // continue to create
    }

    const item = await this.store.newResource({
      parent: folder,
      isA: [notifications.classes.notificationItem],
      propVals: {
        [notifications.properties.notificationType]: input.type,
        [core.properties.name]: input.name,
        [dataBrowser.properties.about]: input.about,
        [notifications.properties.dedupeKey]: input.dedupeKey,
        [notifications.properties.notificationRead]: false,
        [notifications.properties.dismissed]: false,
        [notifications.properties.notificationSummary]: input.summary,
        ...(input.actor && {
          [notifications.properties.notificationActor]: input.actor,
        }),
        ...(input.mentionedAgent && {
          [notifications.properties.mentionedAgent]: input.mentionedAgent,
        }),
        ...(input.watchTarget && {
          [notifications.properties.watchTarget]: input.watchTarget,
        }),
      },
    });

    await item.save();
    this.onItemCreated?.({
      subject: item.subject,
      summary: input.summary,
      about: input.about,
      type: input.type,
    });
    this.emit();
  }

  async markRead(subject: string): Promise<void> {
    const res = await this.store.getResource(subject);
    await res.set(notifications.properties.notificationRead, true);
    await res.save();
    // Bump useSyncExternalStore snapshots (useResource) in addition to
    // LocalChange (useValue) so badge / list styling refresh reliably.
    this.store.notifyResourceUpdated(res);
    this.emit();
  }

  async markAllRead(subjects: string[]): Promise<void> {
    for (const subject of subjects) {
      const res = await this.store.getResource(subject);
      const read = res.get(notifications.properties.notificationRead);

      if (read === true) {
        continue;
      }

      await res.set(notifications.properties.notificationRead, true);
      await res.save();
      this.store.notifyResourceUpdated(res);
    }

    this.emit();
  }

  async dismiss(subject: string): Promise<void> {
    const res = await this.store.getResource(subject);
    await res.set(notifications.properties.dismissed, true);
    await res.set(notifications.properties.notificationRead, true);
    await res.save();
    this.store.notifyResourceUpdated(res);
    this.emit();
  }
}

/** Apply mentions from TipTap JSON onto a document resource (no save). */
export async function syncDocumentMentions(
  resource: Resource,
  tipTapDoc: MentionScanNode | null | undefined,
): Promise<boolean> {
  return applyMentionsProperty(
    resource,
    extractAgentMentionsFromTipTap(tipTapDoc),
  );
}

/** Apply mentions from chat/markdown text onto a message resource (no save). */
export async function syncTextMentions(
  resource: Resource,
  text: string,
): Promise<boolean> {
  return applyMentionsProperty(resource, extractAgentMentionsFromText(text));
}

export {
  applyMentionsProperty,
  extractAgentMentionsFromText,
  extractAgentMentionsFromTipTap,
  isAgentSubject,
  mentionDedupeKey,
  watchDedupeKey,
} from './mentions.js';
