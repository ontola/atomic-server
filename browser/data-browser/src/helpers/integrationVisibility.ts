// @wc-ignore-file
function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
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
