import { getCloudApiBase } from './api';
import { writeCloudAccountBinding } from './binding';
import { getCloudAccount } from './session';

export async function createCloudSyncEnrollment({
  driveSubject,
  agentSubject,
}: {
  driveSubject: string;
  agentSubject: string;
}): Promise<unknown> {
  // Identity convergence happens silently at app boot (IdentityReconcileGate);
  // by the time we enroll, the active agent is the account's agent. Enrolling
  // also (re)binds it below, so the account adopts the agent in use here — we
  // never block enrollment with a mismatch error.
  const response = await fetch(`${getCloudApiBase()}/sync-enrollments`, {
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

  const cloudAccount = await getCloudAccount().catch(() => null);

  if (cloudAccount) {
    writeCloudAccountBinding(cloudAccount.email, agentSubject);
  }

  return response.json();
}
