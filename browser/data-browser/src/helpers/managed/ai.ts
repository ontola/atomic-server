// @wc-ignore-file
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { hasManagedApi, managedFetch, getManagedDeviceToken } from './api';
import { getManagedAccount } from './session';
import type { LanguageModel } from 'ai';

export interface HostedAIStatus {
  enabled: boolean;
  consent: boolean;
  model: string;
  paid: boolean;
  allowance_micros: number;
  used_micros: number;
  remaining_micros: number;
  resets_at: number;
}

export async function getHostedAIStatus(): Promise<HostedAIStatus | undefined> {
  if (
    !hasManagedApi() ||
    (!getManagedDeviceToken() && !(await getManagedAccount()))
  )
    return undefined;
  const response = await managedFetch('/ai/status');
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
export function createHostedModel(model: string): LanguageModel {
  return createOpenRouter({
    apiKey: 'account-session',
    baseURL: 'https://hosted.invalid',
    compatibility: 'strict',
    fetch: async (_input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('Authorization');
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
      const stream = response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
          flush() {
            window.dispatchEvent(new Event(HOSTED_AI_USAGE_EVENT));
          },
        }),
      );

      return new Response(stream, {
        status: response.status,
        headers: response.headers,
      });
    },
  })(model);
}
