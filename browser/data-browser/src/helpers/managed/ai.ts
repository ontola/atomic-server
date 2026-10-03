// @wc-ignore-file
import { hasManagedApi, managedFetch, getManagedDeviceToken } from './api';
import { getManagedAccount } from './session';
import { isHostedDistribution } from '@helpers/managedServer';

export interface HostedAIStatus {
  enabled: boolean;
  consent: boolean;
  model: string;
  paid: boolean;
  allowance_micros: number;
  used_micros: number;
  remaining_micros: number;
  purchased_remaining_micros?: number;
  purchases_enabled?: boolean;
  resets_at: number;
}

export function canPurchaseHostedAICredits(
  status: HostedAIStatus | undefined,
): boolean {
  return isHostedDistribution() && status?.purchases_enabled === true;
}

export async function getHostedAIStatus(): Promise<HostedAIStatus | undefined> {
  if (
    !hasManagedApi() ||
    (!getManagedDeviceToken() && !(await getManagedAccount()))
  )
    return undefined;
  const response = await managedFetch('/ai/status', { cache: 'no-store' });
  if (response.status === 404 || response.status === 401) return undefined;
  if (!response.ok) throw new Error('Could not check included AI credits.');

  return response.json();
}

export async function enableHostedAI(): Promise<HostedAIStatus> {
  const response = await managedFetch('/ai/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accepted: true }),
  });
  if (!response.ok)
    throw new Error('Could not enable included AI. Please try again.');

  return response.json();
}

export const HOSTED_AI_USAGE_EVENT = 'atomic-hosted-ai-usage';
