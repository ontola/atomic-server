// [RECOVERY-RECONSTRUCTED] `helpers/managed/session.ts` was never captured in any
// transcript. Reconstructed from its call sites (reconcile.ts / enrollment.ts
// use `getManagedAccount()` and read `.email`) and the control-plane `GET /api/me`
// route. Mirrors the captured `getManagedUser()` in helpers/managedUsage.ts.

import { PRODUCT_NAME } from './product';
import { getManagedApiBase } from './api';

export type ManagedAccount = {
  email: string;
  created_at?: number;
};

/**
 * The signed-in Managed Sync account (cookie session against the control plane),
 * or null when not signed in. 204/401 both mean "no session".
 */
export async function getManagedAccount(): Promise<ManagedAccount | null> {
  const response = await fetch(`${getManagedApiBase()}/me`, {
    credentials: 'include',
  });

  if (response.status === 204 || response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Could not check ${PRODUCT_NAME} session.`);
  }

  return (await response.json()) as ManagedAccount;
}

/**
 * End the control-plane session too, so signing out on this device is a full
 * sign-out (not just the local Atomic agent). Best-effort: self-hosted / FOSS
 * nodes have no control plane, and an already-signed-out session is a no-op.
 */
export async function logoutManagedSession(): Promise<void> {
  try {
    await fetch(`${getManagedApiBase()}/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // No control plane reachable (self-hosted) — nothing to sign out of.
  }
}
