import {
  clearCloudAccountBinding,
  readCloudAccountBinding,
} from './binding';
import { getCloudEnrollments, type CloudEnrollmentSummary } from './enrollmentApi';
import { getRecoverySecret } from './recovery';
import { getCloudAccount, type CloudAccount } from './session';

export type IdentityMismatchReason =
  | 'recovery_agent'
  | 'enrollment_agent'
  | 'binding_agent'
  | 'stale_local_agent';

export type IdentityReconcileIssue = {
  cloudAccountEmail: string;
  localAgentSubject: string | null;
  expectedAgentSubject: string | null;
  reason: IdentityMismatchReason;
};

export type IdentityReconcileResult =
  | { ok: true; cloudAccount: CloudAccount | null }
  | { ok: false; issue: IdentityReconcileIssue };

function activeEnrollmentAgents(
  enrollments: CloudEnrollmentSummary[],
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

function pickExpectedAgent({
  recoveryAgent,
  enrollmentAgents,
  bindingAgent,
}: {
  recoveryAgent: string | null;
  enrollmentAgents: string[];
  bindingAgent: string | null;
}): string | null {
  if (recoveryAgent) return recoveryAgent;
  if (enrollmentAgents.length === 1) return enrollmentAgents[0] ?? null;
  if (bindingAgent) return bindingAgent;

  return enrollmentAgents[0] ?? null;
}

/**
 * Returns whether the local Atomic agent aligns with the signed-in Cloud Sync
 * account. When there is no Cloud session, always ok (self-hosted / local-only).
 */
export async function evaluateIdentityReconciliation(
  localAgentSubject: string | undefined,
): Promise<IdentityReconcileResult> {
  const cloudAccount = await getCloudAccount().catch(() => null);

  if (!cloudAccount) {
    return { ok: true, cloudAccount: null };
  }

  const [recovery, enrollments] = await Promise.all([
    getRecoverySecret().catch(() => null),
    getCloudEnrollments().catch(() => [] as CloudEnrollmentSummary[]),
  ]);

  const binding = readCloudAccountBinding();
  const bindingAgent =
    binding?.owner_email === cloudAccount.email
      ? binding.expected_agent_subject
      : null;

  if (binding && binding.owner_email !== cloudAccount.email) {
    clearCloudAccountBinding();
  }

  const enrollmentAgents = activeEnrollmentAgents(enrollments);
  const recoveryAgent = recovery?.agent_subject ?? null;
  const expectedAgentSubject = pickExpectedAgent({
    recoveryAgent,
    enrollmentAgents,
    bindingAgent,
  });

  if (!localAgentSubject) {
    return { ok: true, cloudAccount };
  }

  if (recoveryAgent && recoveryAgent !== localAgentSubject) {
    return {
      ok: false,
      issue: {
        cloudAccountEmail: cloudAccount.email,
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
        cloudAccountEmail: cloudAccount.email,
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
        cloudAccountEmail: cloudAccount.email,
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
        cloudAccountEmail: cloudAccount.email,
        localAgentSubject,
        expectedAgentSubject: null,
        reason: 'stale_local_agent',
      },
    };
  }

  return { ok: true, cloudAccount };
}

export async function assertAgentMatchesCloudAccount(
  agentSubject: string,
): Promise<void> {
  const result = await evaluateIdentityReconciliation(agentSubject);

  if (result.ok) return;

  throw new Error(
    'This device is signed in to a different Atomic agent than your Cloud Sync account. Resolve the identity mismatch before continuing.',
  );
}

export function shortDid(subject: string): string {
  if (subject.length <= 28) return subject;

  return `${subject.slice(0, 18)}…${subject.slice(-8)}`;
}
