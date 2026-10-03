// @wc-ignore-file
import type { LanguageModel } from 'ai';
import { createHostedModel } from '@helpers/managed/ai';

/** Managed voice tasks share the hosted transport's auth and credit updates. */
export function hostedVoiceModel(): Extract<
  LanguageModel,
  { specificationVersion: 'v3' }
> {
  return createHostedModel('google/gemini-2.5-flash');
}
