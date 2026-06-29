// [RECOVERY-RECONSTRUCTED] `helpers/cloud/enrollmentApi.ts` was never captured in
// any transcript. Reconstructed from its call sites:
//   - reconcile.ts: getCloudEnrollments() -> CloudEnrollmentSummary[]
//        reads `.status` (compared to 'Disabled') and `.agent_subject`
//   - getDriveUsage() in saasRecovery.ts reads the same shape (drive_subject,
//        drive_name, resource_count, blob_bytes, loro_bytes, quota_bytes)
// against the atomic-saas `GET /api/sync-enrollments` route.

import { getCloudApiBase } from './api';

export type CloudEnrollmentStatus = 'Active' | 'Disabled' | string;

export type CloudEnrollmentSummary = {
  drive_subject: string;
  agent_subject: string | null;
  status: CloudEnrollmentStatus;
  drive_name?: string | null;
  resource_count?: number;
  blob_bytes?: number;
  loro_bytes?: number;
  quota_bytes?: number | null;
};

/**
 * Sync enrollments for the signed-in Cloud account. Returns an empty list when
 * there is no session or the control plane is unreachable (callers treat "no
 * enrollments" as "nothing to reconcile").
 */
export async function getCloudEnrollments(): Promise<CloudEnrollmentSummary[]> {
  const response = await fetch(`${getCloudApiBase()}/sync-enrollments`, {
    credentials: 'include',
  });

  if (!response.ok) return [];

  const body = (await response.json()) as unknown;

  const list = Array.isArray(body)
    ? body
    : ((body as { enrollments?: unknown[] })?.enrollments ?? []);

  return list as CloudEnrollmentSummary[];
}
