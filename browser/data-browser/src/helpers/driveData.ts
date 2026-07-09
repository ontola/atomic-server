import type { Store } from '@tomic/lib';

/**
 * Whether this device can actually load the drive.
 *
 * False on a device that just signed in with a secret: it holds the identity
 * but none of the account's data, which still lives wherever it was created.
 * Resolves locally first, so a local-only drive that never touched a server
 * still counts as present.
 */
export async function deviceHasDriveData(
  store: Store,
  drive: string,
): Promise<boolean> {
  try {
    const resource = await store.getResource(drive);

    return !resource.error;
  } catch {
    return false;
  }
}
