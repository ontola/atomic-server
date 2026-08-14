import { PRODUCT_NAME } from './product';
import { managedFetch } from './api';
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

/**
 * Say what actually went wrong.
 *
 * This used to throw one sentence — "Could not enable Cloud Server" — for every
 * failure, discarding the status and the body. The control plane is more
 * forthcoming than that: it answers 402 with "Cloud Server requires a
 * subscription" and an upgrade URL, 401 when the session lapsed, and 500 when
 * the fleet has no node with free capacity. All three arrived as the same dead
 * end, which is how a full fleet in production read as a mysterious backup
 * failure with no next step.
 */
async function enrollmentError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    upgrade_url?: string;
  } | null;

  if (response.status === 401) {
    return new Error(
      `Your ${PRODUCT_NAME} session expired. Sign in and retry.`,
    );
  }

  // The server's own words when it has them: it knows why far better than a
  // status code does.
  if (body?.error && response.status !== 500) {
    return new Error(
      body.upgrade_url ? `${body.error} (${body.upgrade_url})` : body.error,
    );
  }

  if (response.status >= 500) {
    return new Error(
      `${PRODUCT_NAME} could not place this drive right now. This is usually ` +
        'capacity rather than anything you did — try again shortly.',
    );
  }

  return new Error(
    `Could not enable ${PRODUCT_NAME} hosting (HTTP ${response.status}).`,
  );
}

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
    throw await enrollmentError(response);
  }

  const managedAccount = await getManagedAccount().catch(() => null);

  if (managedAccount) {
    writeManagedAccountBinding(managedAccount.email, agentSubject);
  }

  return (await response.json()) as ManagedSyncEnrollmentResult;
}
