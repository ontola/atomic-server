import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@tomic/react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useSettings } from '../helpers/AppSettings';
import {
  evaluateIdentityReconciliation,
  syncDeviceDirectory,
  writeManagedAccountBinding,
} from '../helpers/managed';
import { paths } from '../routes/paths';

type GateProps = {
  children: React.ReactNode;
};

/**
 * Keeps the device's Atomic agent aligned with the signed-in Managed Sync account
 * — **silently**. There is no "resolve mismatch" screen: the agent layer is
 * never surfaced to a user who only thinks in terms of their Managed Sync account.
 * (See the control-plane contract doc, decision 2026-06-25.)
 *
 * On a Managed Sync session whose account agent differs from the device agent:
 * - **Account has a restorable backup** (`recovery_agent`) → send the user to
 *   the welcome/recover flow ("unlock your data"), which replaces the local
 *   agent. Nothing is dropped here; the local agent stays until recovery lands.
 * - **Otherwise** → adopt this device's agent (bind it to the account) so it
 *   becomes the account's agent. No prompt, no logout.
 *
 * With no Managed session (self-hosted / local-only), reconciliation is a no-op
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
  // Re-checks fire on every `agent?.subject` change (e.g. a device
  // creating/accepting-as a brand new local agent, not just managed-sync
  // sign-in/out). Blanking `children` on every one of those unmounts the
  // whole `<Outlet/>` subtree — including in-flight async flows lower down
  // (the invite accept dialog is one) — which is the opposite of "silent".
  // Only the very first check (initial mount) blanks the screen, matching
  // the doc comment's intent of not flashing the wrong agent; later
  // re-checks resolve in the background without disturbing the mounted UI.
  const hasCheckedOnceRef = useRef(false);

  // The welcome/recover flow does its own convergence; don't double-handle it.
  const skip =
    pathname === paths.welcome || pathname.startsWith(`${paths.welcome}/`);

  const converge = useCallback(async () => {
    if (skip) {
      setChecking(false);
      hasCheckedOnceRef.current = true;

      return;
    }

    if (!hasCheckedOnceRef.current) {
      setChecking(true);
    }

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
      writeManagedAccountBinding(
        result.issue.managedAccountEmail,
        result.issue.localAgentSubject,
      );
    }

    // Announce this device to the account's device directory, seed KnownPeers
    // from it, and auto-connect the account's other devices with the active
    // drive (zero-scan pairing — no manual "Sync now"). Fire-and-forget:
    // routing hints only, must never delay or gate the app.
    void syncDeviceDirectory(store.getDrive());

    setChecking(false);
    hasCheckedOnceRef.current = true;
  }, [agent?.subject, skip, store, navigate]);

  useEffect(() => {
    void converge();
  }, [converge]);

  if (skip) {
    return <>{children}</>;
  }

  if (checking && !hasCheckedOnceRef.current) {
    return <></>;
  }

  return <>{children}</>;
}
