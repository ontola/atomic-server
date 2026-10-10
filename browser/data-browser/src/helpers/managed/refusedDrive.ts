import type { Store } from '@tomic/react';
import {
  getManagedEnrollments,
  type ManagedEnrollmentSummary,
} from './enrollmentApi';

type RefusedDriveStore = Pick<
  Store,
  'isLocalOnlyDrive' | 'makeDriveLocal' | 'normalizeSubject'
>;

/**
 * A node refused `drive` as "not enrolled". Switch the drive to browser-only
 * when that is the whole story: the account's enrollments were fetched, and
 * none of them (on any node) hosts the drive. Resolves `true` when the drive
 * is, or already was, browser-only, `false` to leave the refusal to be
 * reported.
 *
 * "Could not find out" is never "nothing hosts it". A lookup that fails, or
 * that cannot run because nobody is signed in, leaves the drive alone, as does
 * an enrollment on another node, a pending or paused one, and a local copy
 * `makeDriveLocal` cannot vouch for. Nothing is deleted from the server, and
 * the drive's data stays on this device.
 */
export async function healRefusedDrive(
  store: RefusedDriveStore,
  drive: string,
  lookup: () => Promise<
    Pick<ManagedEnrollmentSummary, 'drive_subject' | 'status'>[]
  > = () => getManagedEnrollments(true),
): Promise<boolean> {
  if (store.isLocalOnlyDrive(drive)) return true;

  let enrollments: Pick<ManagedEnrollmentSummary, 'drive_subject' | 'status'>[];

  try {
    // Strict: no session, an unreachable control plane and a malformed answer
    // all throw rather than read as an empty list.
    enrollments = await lookup();
  } catch {
    return false;
  }

  const wanted = store.normalizeSubject(drive);
  const hosted = enrollments.some(
    enrollment =>
      store.normalizeSubject(enrollment.drive_subject) === wanted &&
      enrollment.status !== 'Disabled',
  );

  if (hosted) return false;

  try {
    await store.makeDriveLocal(drive);

    return true;
  } catch (e) {
    console.warn('[Sync] Could not move a refused drive to this browser:', e);

    return false;
  }
}

/** Resolve drives the node refuses as "not enrolled" before the store reports
 *  them. See {@link healRefusedDrive}. */
export function registerRefusedDriveHealing(store: Store): () => void {
  return store.setRefusedDriveHandler(drive => healRefusedDrive(store, drive));
}
