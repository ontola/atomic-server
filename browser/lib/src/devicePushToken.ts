import { CollectionBuilder } from './collectionBuilder.js';
import { core } from './ontologies/core.js';
import { notifications } from './ontologies/notifications.js';
import type { Store } from './store.js';

export type PushPlatform = 'ios' | 'android' | 'web' | 'desktop';

export interface RegisterDevicePushTokenOpts {
  store: Store;
  /** Parent folder (usually the personal-drive Notifications folder). */
  parent: string;
  agentSubject: string;
  platform: PushPlatform;
  token: string;
  /** Bundle / package / origin. Optional for web until web-push is wired. */
  appId?: string;
}

/**
 * Upsert a {@link notifications.classes.devicePushToken} for this install.
 *
 * Tokens rotate; call on every launch once a platform token is available.
 * Matching key: `(devicePushAgent, pushPlatform, pushAppId)` — same install
 * updates `pushToken` / `pushTokenUpdatedAt` instead of creating duplicates.
 *
 * Phase 5: register a platform token on the personal-drive
 * {@link notifications.classes.devicePushToken} the hub fans out to.
 */
export async function registerDevicePushToken(
  opts: RegisterDevicePushTokenOpts,
): Promise<string> {
  const { store, parent, agentSubject, platform, token, appId } = opts;
  const now = Date.now();

  const existing = await findExistingToken(
    store,
    agentSubject,
    platform,
    appId,
  );

  if (existing) {
    const res = await store.getResource(existing);
    await res.set(notifications.properties.pushToken, token, false);
    await res.set(notifications.properties.pushTokenUpdatedAt, now, false);

    if (appId) {
      await res.set(notifications.properties.pushAppId, appId, false);
    }

    await res.save();

    return existing;
  }

  const resource = await store.newResource({
    parent,
    isA: [notifications.classes.devicePushToken],
    propVals: {
      [core.properties.name]: `Push (${platform})`,
      [notifications.properties.devicePushAgent]: agentSubject,
      [notifications.properties.pushPlatform]: platform,
      [notifications.properties.pushToken]: token,
      [notifications.properties.pushTokenUpdatedAt]: now,
      ...(appId && { [notifications.properties.pushAppId]: appId }),
    },
  });
  await resource.save();

  return resource.subject;
}

async function findExistingToken(
  store: Store,
  agentSubject: string,
  platform: PushPlatform,
  appId: string | undefined,
): Promise<string | undefined> {
  try {
    const collection = await new CollectionBuilder(store)
      .setProperty(core.properties.isA)
      .setValue(notifications.classes.devicePushToken)
      .setPageSize(50)
      .buildAndFetch();

    for (let i = 0; i < collection.totalMembers; i++) {
      const subject = await collection.getMemberWithIndex(i);

      if (!subject) {
        continue;
      }

      const res = await store.getResource(subject);
      const agent = res.get(notifications.properties.devicePushAgent);
      const plat = res.get(notifications.properties.pushPlatform);
      const storedApp = res.get(notifications.properties.pushAppId) as
        | string
        | undefined;

      if (agent !== agentSubject || plat !== platform) {
        continue;
      }

      if ((appId ?? '') !== (storedApp ?? '')) {
        continue;
      }

      return subject;
    }
  } catch {
    // no index / empty — create fresh
  }

  return undefined;
}

/**
 * Wake-only **data** bag (social-apps P2.3). Hub never puts document body here.
 * Visible OS banners use {@link visiblePushCopy} (generic title/body).
 */
export function buildPushWakePayload(input: {
  about: string;
  type: string;
}): { about: string; type: string } {
  return { about: input.about, type: input.type };
}

/** Generic lock-screen copy. Keep in sync with `push_wake::visible_body_for_type`. */
export function visiblePushCopy(type: string): { title: string; body: string } {
  const title = 'Atomic';

  switch (type) {
    case 'mention':
      return { title, body: 'Someone mentioned you' };
    case 'message':
      return { title, body: 'You have a new message' };
    case 'access-request':
      return { title, body: 'Someone requested access' };
    case 'watch-membership':
      return { title, body: 'A list you follow changed' };
    case 'watch-content':
      return { title, body: 'Something you follow was updated' };
    default:
      return { title, body: 'You have a new notification' };
  }
}

/**
 * After a push wake + sync, only surface if the personal NotificationItem is
 * still unread and not dismissed (mirrors `push_wake::should_surface_after_sync`).
 */
export function shouldSurfaceAfterPushSync(
  read: boolean,
  dismissed: boolean,
): boolean {
  return !read && !dismissed;
}

/**
 * Client path for a remote push wake: suppress UI presentation if already
 * read/dismissed. Returns whether the UI should still open `about`.
 */
export function shouldOpenAfterPushWake(opts: {
  itemRead?: boolean;
  itemDismissed?: boolean;
}): boolean {
  return shouldSurfaceAfterPushSync(
    opts.itemRead === true,
    opts.itemDismissed === true,
  );
}

export type PushWakeItemFlags = {
  subject: string;
  read: boolean;
  dismissed: boolean;
  summary?: string;
};

export type PushWakeHandleResult =
  | { action: 'suppress'; reason: 'read' | 'dismissed' }
  | {
      action: 'surface';
      about: string;
      type: string;
      itemSubject?: string;
      summary?: string;
    };

export interface HandlePushWakeOpts {
  store: Store;
  about: string;
  type: string;
  /**
   * Run {@link NotificationEngine.reconcileMentionBacklog} (and any other
   * materialization) after fetching `about`.
   */
  reconcile: () => Promise<void>;
  /**
   * Locate the personal-drive NotificationItem for `about` after reconcile.
   * Return undefined if none yet (still allow surface so the client can open
   * `about` / inbox).
   */
  findItemForAbout: (about: string) => Promise<PushWakeItemFlags | undefined>;
}

/**
 * Client path for an incoming push wake (data / silent):
 * fetch `about` → reconcile engine → suppress if already read/dismissed.
 *
 * Transport-agnostic — call from FCM/APNs/web-push handlers once a plugin
 * delivers the wake payload. Does not show UI; callers present locally when
 * `action === 'surface'`.
 */
export async function handlePushWake(
  opts: HandlePushWakeOpts,
): Promise<PushWakeHandleResult> {
  const { store, about, type, reconcile, findItemForAbout } = opts;

  try {
    await store.fetchResourceFromServer(about);
  } catch {
    // Offline / missing — reconcile may still find a local item.
  }

  await reconcile();

  const item = await findItemForAbout(about);

  if (item && !shouldSurfaceAfterPushSync(item.read, item.dismissed)) {
    return {
      action: 'suppress',
      reason: item.dismissed ? 'dismissed' : 'read',
    };
  }

  return {
    action: 'surface',
    about,
    type,
    itemSubject: item?.subject,
    summary: item?.summary,
  };
}
