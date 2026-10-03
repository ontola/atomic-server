// @wc-ignore-file
import type { LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { managedFetch } from '@helpers/managed/api';
import { HOSTED_AI_USAGE_EVENT } from '@helpers/managed/ai';

// Lives here rather than in helpers/managed/ai.ts so the AI SDK is only
// downloaded together with the AI chunks, not on the first page load.
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
