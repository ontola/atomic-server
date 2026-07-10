import type { Store } from '@tomic/lib';

/**
 * Whether this device can actually load the drive.
 *
 * False on a device that just signed in with a secret: it holds the identity
 * but none of the account's data, which still lives wherever it was created.
 * Resolves locally first, so a local-only drive that never touched a server
 * still counts as present.
 *
 * Pass `refresh` once something should have changed — a peer sync landed, say.
 * The store cached the failed fetch that reported the drive missing in the
 * first place, and left alone would go on reporting it missing.
 */
export async function deviceHasDriveData(
  store: Store,
  drive: string,
  options?: { refresh?: boolean },
): Promise<boolean> {
  try {
    if (options?.refresh) {
      await store.fetchResourceFromServer(drive);

      return !store.getResourceLoading(drive).error;
    }

    const resource = await store.getResource(drive);

    return !resource.error;
  } catch {
    return false;
  }
}
