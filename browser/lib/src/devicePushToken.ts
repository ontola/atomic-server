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
 * Phase 5 scaffold: no FCM/APNs transport yet — this only writes the registry
 * resource the hub will fan out to later.
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
 * Wake-only push payload contract (social-apps P2.3 / notifications Phase 5).
 * Hub must never put summary/body in the push; client syncs then materializes.
 */
export function buildPushWakePayload(input: {
  about: string;
  type: string;
}): { about: string; type: string } {
  return { about: input.about, type: input.type };
}
