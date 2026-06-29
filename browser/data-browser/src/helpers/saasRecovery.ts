// [RECOVERY] This file was truncated in the recovery (only ~73 of ~268 lines
// survived in the transcripts). The `getSaasApiBase` helper (used throughout but
// lost from the original top of the file) and the `createSaasEnrollment` body
// below are reconstructed. `getSaasApiBase` resolves the same atomic-saas
// control-plane `/api` base as the cloud helpers, so it delegates to them.
import { getCloudApiBase } from './cloud/api';

/** Base URL of the atomic-saas control plane (same endpoint as the cloud helpers). */
function getSaasApiBase(): string {
  return getCloudApiBase();
}

export type SaasUser = {
  email: string;
  created_at: number;
};

export async function getSaasUser(): Promise<SaasUser | null> {
  const response = await fetch(`${getSaasApiBase()}/me`, {
    credentials: 'include',
  });

  if (response.status === 204 || response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error('Could not check SaaS session.');
  }

  return response.json();
}

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
 * not signed in to Cloud Sync, or when this drive isn't enrolled.
 */
export async function getDriveUsage(
  driveSubject: string,
): Promise<DriveUsageInfo | null> {
  if (!driveSubject) return null;

  const response = await fetch(`${getSaasApiBase()}/sync-enrollments`, {
    credentials: 'include',
  });

  if (!response.ok) return null;

  const body = (await response.json()) as unknown;
  const list = (
    Array.isArray(body)
      ? body
      : ((body as { enrollments?: unknown[] })?.enrollments ?? [])
  ) as Array<{
    drive_subject?: string;
    drive_name?: string;
    resource_count?: number;
    blob_bytes?: number;
    loro_bytes?: number;
    quota_bytes?: number;
  }>;

  const match = list.find(e => e.drive_subject === driveSubject);

  if (!match) return null;

  return {
    driveName: match.drive_name ?? null,
    resourceCount: match.resource_count ?? 0,
    blobBytes: match.blob_bytes ?? 0,
    loroBytes: match.loro_bytes ?? 0,
    quotaBytes: match.quota_bytes ?? null,
  };
}

// [RECOVERY-RECONSTRUCTED] Only the signature `createSaasEnrollment({` survived.
// Reconstructed from the equivalent helpers/cloud/enrollment.ts:createCloudSyncEnrollment
// (POST /sync-enrollments). No code currently imports this export.
export async function createSaasEnrollment({
  driveSubject,
  agentSubject,
}: {
  driveSubject: string;
  agentSubject: string;
}): Promise<unknown> {
  const response = await fetch(`${getSaasApiBase()}/sync-enrollments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      drive_subject: driveSubject,
      agent_subject: agentSubject,
    }),
  });

  if (!response.ok) {
    throw new Error('Could not enable cloud sync backup.');
  }

  return response.json();
}