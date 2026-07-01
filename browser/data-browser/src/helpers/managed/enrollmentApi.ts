// [RECOVERY-RECONSTRUCTED] `helpers/managed/enrollmentApi.ts` was never captured in
// any transcript. Reconstructed from its call sites:
//   - reconcile.ts: getManagedEnrollments() -> ManagedEnrollmentSummary[]
//        reads `.status` (compared to 'Disabled') and `.agent_subject`
//   - getDriveUsage() in managedUsage.ts reads the same shape (drive_subject,
//        drive_name, resource_count, blob_bytes, loro_bytes, quota_bytes)
// against the control-plane `GET /api/sync-enrollments` route.

import { getManagedApiBase } from './api';

export type ManagedEnrollmentStatus = 'Active' | 'Disabled' | string;

export type ManagedEnrollmentSummary = {
  drive_subject: string;
  agent_subject: string | null;
  status: ManagedEnrollmentStatus;
  drive_name?: string | null;
  resource_count?: number;
  blob_bytes?: number;
  loro_bytes?: number;
  quota_bytes?: number | null;
};

/**
 * Sync enrollments for the signed-in Managed account. Returns an empty list when
 * there is no session or the control plane is unreachable (callers treat "no
 * enrollments" as "nothing to reconcile").
 */
export async function getManagedEnrollments(): Promise<ManagedEnrollmentSummary[]> {
  const response = await fetch(`${getManagedApiBase()}/sync-enrollments`, {
    credentials: 'include',
  });

  if (!response.ok) return [];

  const body = (await response.json()) as unknown;

  const list = Array.isArray(body)
    ? body
    : ((body as { enrollments?: unknown[] })?.enrollments ?? []);

  return list as ManagedEnrollmentSummary[];
}
