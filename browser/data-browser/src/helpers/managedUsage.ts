// Per-drive usage, read from the signed-in account's Cloud Server enrollments.
import { getManagedEnrollments } from './managed/enrollmentApi';

export type DriveUsageInfo = {
  driveName: string | null;
  resourceCount: number;
  blobBytes: number;
  loroBytes: number;
  quotaBytes: number | null;
};

/**
 * Per-drive usage the managed node reports to the control plane (resource count
 * + bytes used), read from the signed-in user's enrollments. Returns null when
 * not signed in to Managed Sync, or when this drive isn't enrolled.
 *
 * Goes through `managedFetch`, so it shares the enrollment read other parts of
 * the page make at the same moment and carries a linked device's token.
 */
export async function getDriveUsage(
  driveSubject: string,
): Promise<DriveUsageInfo | null> {
  if (!driveSubject) return null;

  const match = (await getManagedEnrollments()).find(
    e => e.drive_subject === driveSubject,
  );

  if (!match) return null;

  return {
    driveName: match.drive_name ?? null,
    resourceCount: match.resource_count ?? 0,
    blobBytes: match.blob_bytes ?? 0,
    loroBytes: match.loro_bytes ?? 0,
    quotaBytes: match.quota_bytes ?? null,
  };
}
