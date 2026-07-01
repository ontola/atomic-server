// [RECOVERY-RECONSTRUCTED] `helpers/cloud/session.ts` was never captured in any
// transcript. Reconstructed from its call sites (reconcile.ts / enrollment.ts
// use `getCloudAccount()` and read `.email`) and the control-plane `GET /api/me`
// route. Mirrors the captured `getCloudUser()` in helpers/cloudUsage.ts.

import { getCloudApiBase } from './api';

export type CloudAccount = {
  email: string;
  created_at?: number;
};

/**
 * The signed-in Cloud Sync account (cookie session against the control plane),
 * or null when not signed in. 204/401 both mean "no session".
 */
export async function getCloudAccount(): Promise<CloudAccount | null> {
  const response = await fetch(`${getCloudApiBase()}/me`, {
    credentials: 'include',
  });

  if (response.status === 204 || response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error('Could not check Cloud Sync session.');
  }

  return (await response.json()) as CloudAccount;
}
