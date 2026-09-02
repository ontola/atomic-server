import { PRODUCT_NAME } from './product';
import {
  clearManagedAccountBinding,
  readManagedAccountBinding,
} from './binding';
import {
  getManagedEnrollments,
  type ManagedEnrollmentSummary,
} from './enrollmentApi';
import { getRecoverySecret } from './recovery';
import { getManagedAccount, type ManagedAccount } from './session';

export type IdentityMismatchReason =
  | 'recovery_agent'
  | 'enrollment_agent'
  | 'binding_agent'
  | 'stale_local_agent';

export type IdentityReconcileIssue = {
  managedAccountEmail: string;
  localAgentSubject: string | null;
  expectedAgentSubject: string | null;
  reason: IdentityMismatchReason;
};

export type IdentityReconcileResult =
  | { ok: true; managedAccount: ManagedAccount | null }
  | { ok: false; issue: IdentityReconcileIssue };

function activeEnrollmentAgents(
  enrollments: ManagedEnrollmentSummary[],
): string[] {
  const agents = new Set<string>();

  for (const enrollment of enrollments) {
    if (enrollment.status === 'Disabled') continue;

    if (enrollment.agent_subject) {
      agents.add(enrollment.agent_subject);
    }
  }

  return [...agents];
}

/**
 * Returns whether the local Atomic agent aligns with the signed-in Managed Sync
 * account. When there is no Managed session, always ok (self-hosted / local-only).
 */
export async function evaluateIdentityReconciliation(
  localAgentSubject: string | undefined,
): Promise<IdentityReconcileResult> {
  const managedAccount = await getManagedAccount().catch(() => null);

  if (!managedAccount) {
    return { ok: true, managedAccount: null };
  }

  const [recovery, enrollments] = await Promise.all([
    getRecoverySecret().catch(() => null),
    getManagedEnrollments().catch(() => [] as ManagedEnrollmentSummary[]),
  ]);

  const binding = readManagedAccountBinding();
  const bindingAgent =
    binding?.owner_email === managedAccount.email
      ? binding.expected_agent_subject
      : null;

  if (binding && binding.owner_email !== managedAccount.email) {
    clearManagedAccountBinding();
  }

  const enrollmentAgents = activeEnrollmentAgents(enrollments);
  const recoveryAgent = recovery?.agent_subject ?? null;

  if (!localAgentSubject) {
    return { ok: true, managedAccount };
  }

  if (recoveryAgent && recoveryAgent !== localAgentSubject) {
    return {
      ok: false,
      issue: {
        managedAccountEmail: managedAccount.email,
        localAgentSubject,
        expectedAgentSubject: recoveryAgent,
        reason: 'recovery_agent',
      },
    };
  }

  if (
    enrollmentAgents.length > 0 &&
    !enrollmentAgents.includes(localAgentSubject)
  ) {
    return {
      ok: false,
      issue: {
        managedAccountEmail: managedAccount.email,
        localAgentSubject,
        expectedAgentSubject: enrollmentAgents[0] ?? null,
        reason: 'enrollment_agent',
      },
    };
  }

  if (bindingAgent && bindingAgent !== localAgentSubject) {
    return {
      ok: false,
      issue: {
        managedAccountEmail: managedAccount.email,
        localAgentSubject,
        expectedAgentSubject: bindingAgent,
        reason: 'binding_agent',
      },
    };
  }

  if (
    !recoveryAgent &&
    enrollmentAgents.length === 0 &&
    !bindingAgent &&
    localAgentSubject
  ) {
    return {
      ok: false,
      issue: {
        managedAccountEmail: managedAccount.email,
        localAgentSubject,
        expectedAgentSubject: null,
        reason: 'stale_local_agent',
      },
    };
  }

  return { ok: true, managedAccount };
}

export type ServerReconcileResult =
  | { ok: true }
  | { ok: false; expectedOrigin: string };

/**
 * Returns whether the Store's current `serverUrl` origin matches the node
 * actually hosting the active drive, per the signed-in account's
 * enrollments. When there is no Managed session, always ok (self-hosted /
 * local-only) — mirrors `evaluateIdentityReconciliation`'s short-circuit.
 *
 * This exists because `serverUrl` is a single client-side setting (see
 * `Store.setServerUrl`) that isn't derived from a drive's `did:` subject —
 * once the app is served from a fixed origin instead of the node's own
 * domain, nothing else keeps it pointed at the right node across a fresh
 * device (no stored value yet) or a drive migration (stored value goes
 * stale). `enrollment.http_origin` is the source of truth for "where does
 * this drive actually live right now."
 */
export async function evaluateServerReconciliation(
  currentServerUrl: string,
  currentDriveSubject: string | undefined,
): Promise<ServerReconcileResult> {
  const managedAccount = await getManagedAccount().catch(() => null);

  if (!managedAccount) {
    return { ok: true };
  }

  const enrollments = await getManagedEnrollments().catch(
    () => [] as ManagedEnrollmentSummary[],
  );

  const withOrigin = enrollments.filter(
    e => e.status !== 'Disabled' && e.http_origin,
  );

  // Match by the drive currently in view; with no drive in view yet, only
  // resolve when there's exactly one candidate — with several, guessing
  // wrong is worse than waiting for a drive subject to disambiguate.
  const match = currentDriveSubject
    ? withOrigin.find(e => e.drive_subject === currentDriveSubject)
    : withOrigin.length === 1
      ? withOrigin[0]
      : undefined;

  if (!match?.http_origin) {
    return { ok: true };
  }

  let expectedOrigin: string;
  let actualOrigin: string;

  try {
    expectedOrigin = new URL(match.http_origin).origin;
    actualOrigin = new URL(currentServerUrl).origin;
  } catch {
    // A malformed URL on either side isn't this function's problem to fix.
    return { ok: true };
  }

  if (expectedOrigin === actualOrigin) {
    return { ok: true };
  }

  return { ok: false, expectedOrigin };
}

export async function assertAgentMatchesManagedAccount(
  agentSubject: string,
): Promise<void> {
  const result = await evaluateIdentityReconciliation(agentSubject);

  if (result.ok) return;

  throw new Error(
    `This device is signed in to a different Atomic agent than your ${PRODUCT_NAME} account. Resolve the identity mismatch before continuing.`,
  );
}

export function shortDid(subject: string): string {
  if (subject.length <= 28) return subject;

  return `${subject.slice(0, 18)}…${subject.slice(-8)}`;
}
