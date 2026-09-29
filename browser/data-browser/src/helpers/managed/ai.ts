// @wc-ignore-file
import type { LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
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

/** The placeholder key is discarded: only the user's SaaS session leaves the browser. */
export function createHostedModel(
  model: string,
): Extract<LanguageModel, { specificationVersion: 'v3' }> {
  return createOpenRouter({
    apiKey: 'account-session',
    baseURL: 'https://hosted.invalid',
    compatibility: 'strict',
    fetch: async (_input, init) => {
      // SDK transport headers (notably User-Agent in Firefox) must not leak
      // into the cross-origin control-plane request. managedFetch adds auth.
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const response = await managedFetch('/ai/chat/completions', {
        ...init,
        headers,
      });

      if (!response.ok) {
        window.dispatchEvent(new Event(HOSTED_AI_USAGE_EVENT));
        const body = await response.json().catch(() => ({}));
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : 'Included AI is unavailable. Please try again.',
        );
      }

      if (!response.body)
        throw new Error('Included AI returned an empty response.');
      const reader = response.body.getReader();
      let notified = false;

      const notifyUsage = () => {
        if (notified) return;
        notified = true;
        window.dispatchEvent(new Event(HOSTED_AI_USAGE_EVENT));
      };

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();

            if (done) {
              controller.close();
              notifyUsage();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            controller.error(error);
            notifyUsage();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            notifyUsage();
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        headers: response.headers,
      });
    },
  })(model);
}
