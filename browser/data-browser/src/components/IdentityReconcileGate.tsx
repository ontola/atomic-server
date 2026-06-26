import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '@tomic/react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useSettings } from '../helpers/AppSettings';
import {
  evaluateIdentityReconciliation,
  writeCloudAccountBinding,
} from '../helpers/cloud';
import { paths } from '../routes/paths';

type GateProps = {
  children: React.ReactNode;
};

/**
 * Keeps the device's Atomic agent aligned with the signed-in Cloud Sync account
 * — **silently**. There is no "resolve mismatch" screen: the agent layer is
 * never surfaced to a user who only thinks in terms of their Cloud Sync account.
 * (See atomic-saas/planning/SAAS_ATOMIC_SERVER_CONTRACT.md, decision 2026-06-25.)
 *
 * On a Cloud Sync session whose account agent differs from the device agent:
 * - **Account has a restorable backup** (`recovery_agent`) → send the user to
 *   the welcome/recover flow ("unlock your data"), which replaces the local
 *   agent. Nothing is dropped here; the local agent stays until recovery lands.
 * - **Otherwise** → adopt this device's agent (bind it to the account) so it
 *   becomes the account's agent. No prompt, no logout.
 *
 * With no Cloud session (self-hosted / local-only), reconciliation is a no-op
 * and the agent is simply primary.
 */
export function IdentityReconcileGate({
  children,
}: GateProps): React.JSX.Element {
  const store = useStore();
  const { agent } = useSettings();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  // The welcome/recover flow does its own convergence; don't double-handle it.
  const skip =
    pathname === paths.welcome || pathname.startsWith(`${paths.welcome}/`);

  const converge = useCallback(async () => {
    if (skip) {
      setChecking(false);

      return;
    }

    setChecking(true);

    const localAgent = agent?.subject ?? store.getAgent()?.subject ?? undefined;
    const result = await evaluateIdentityReconciliation(localAgent);

    if (!result.ok && result.issue.reason === 'recovery_agent') {
      // The account has a restorable identity. Unlock it via the recover flow;
      // it replaces the local agent. Keep `checking` true so we render nothing
      // during the redirect rather than flashing the app as the wrong agent.
      navigate({ to: paths.welcome, replace: true });

      return;
    }

    if (!result.ok && result.issue.localAgentSubject) {
      // Adopt this device's agent as the account's agent — no UI.
      writeCloudAccountBinding(
        result.issue.cloudAccountEmail,
        result.issue.localAgentSubject,
      );
    }

    setChecking(false);
  }, [agent?.subject, skip, store, navigate]);

  useEffect(() => {
    void converge();
  }, [converge]);

  if (skip) {
    return <>{children}</>;
  }

  if (checking) {
    return <></>;
  }

  return <>{children}</>;
}
