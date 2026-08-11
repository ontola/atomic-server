import { PRODUCT_NAME } from './product';
import { getManagedApiBase, managedFetch } from './api';
import { writeManagedAccountBinding } from './binding';
import { getManagedAccount } from './session';

/**
 * What the control plane returns from `POST /api/sync-enrollments`
 * (`SyncEnrollmentCreated` in the backend). `http_origin` is the managed node
 * the drive was assigned to — where the browser then points to sync it.
 */
export type ManagedSyncEnrollmentResult = {
  drive: string;
  /** Iroh node id of the assigned node, when known. */
  node: string | null;
  /** HTTP origin of the assigned managed node, e.g. `https://node1.example`. */
  http_origin: string | null;
};

export async function createManagedSyncEnrollment({
  driveSubject,
  agentSubject,
}: {
  driveSubject: string;
  agentSubject: string;
}): Promise<ManagedSyncEnrollmentResult> {
  // Identity convergence happens silently at app boot (IdentityReconcileGate);
  // by the time we enroll, the active agent is the account's agent. Enrolling
  // also (re)binds it below, so the account adopts the agent in use here — we
  // never block enrollment with a mismatch error.
  const response = await managedFetch(`/sync-enrollments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drive_subject: driveSubject,
      agent_subject: agentSubject,
    }),
  });

  if (!response.ok) {
    throw new Error(`Could not enable ${PRODUCT_NAME} backup.`);
  }

  const managedAccount = await getManagedAccount().catch(() => null);

  if (managedAccount) {
    writeManagedAccountBinding(managedAccount.email, agentSubject);
  }

  return (await response.json()) as ManagedSyncEnrollmentResult;
}
