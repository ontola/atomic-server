// @wc-ignore-file
import { preferencesSchema } from '@tomic/lib';

export type IntegrationVisibilityKey =
  | 'show-api-plugins'
  | 'show-experimental-plugins';

/** The fixed property each preference is stored under on the private drive. */
export const visibilityProperties: Record<IntegrationVisibilityKey, string> = {
  'show-api-plugins': preferencesSchema.properties.showApiPlugins,
  'show-experimental-plugins':
    preferencesSchema.properties.showExperimentalPlugins,
};

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Where `useUserSetting` keeps this agent's local copy of a preference. */
export function visibilityLocalKey(
  actor: string | undefined,
  key: IntegrationVisibilityKey,
): string {
  return `integration-visibility:${actor ?? 'anonymous'}:${key}`;
}

/**
 * Before these preferences had fixed properties, one object per agent cached
 * both choices under `integration-visibility:<agent>`. Copies an opt-in from
 * it into the per-preference key, unless that already holds a value, so
 * `useUserSetting` moves it onto the drive. Only `true` is carried: `false` is
 * the default. Never throws.
 */
export function carryOverLegacyOptIn(
  actor: string | undefined,
  key: IntegrationVisibilityKey,
  storage: Storage | undefined = defaultStorage(),
): void {
  try {
    const target = visibilityLocalKey(actor, key);

    if (!storage || storage.getItem(target) !== null) return;

    const legacy = JSON.parse(
      storage.getItem(`integration-visibility:${actor ?? 'anonymous'}`) ??
        'null',
    );

    if (legacy?.[key] === true) storage.setItem(target, 'true');
  } catch {
    // Without storage the opt-in is simply not carried.
  }
}

/**
 * The `?preview=` value on `/integrations` that unlocks the experimental
 * toggle. A facilitator opens it once on the tester's device during a
 * user-testing session.
 */
export const PLUGIN_PREVIEW_PARAM = 'plugins';

function previewKey(actor: string | undefined): string {
  return `integration-preview-unlocked:${actor ?? 'anonymous'}`;
}

/** Whether this agent unlocked the experimental toggle on this device. Never throws. */
export function readPreviewUnlocked(
  actor: string | undefined,
  storage: Storage | undefined = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(previewKey(actor)) === 'true';
  } catch {
    return false;
  }
}

/** Remembers the unlock for this agent on this device. Never throws. */
export function writePreviewUnlocked(
  actor: string | undefined,
  storage: Storage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(previewKey(actor), 'true');
  } catch {
    // Without storage the unlock lasts as long as the page does.
  }
}
