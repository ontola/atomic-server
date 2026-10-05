import type { MessageMetadata } from './types';

type Usage = { inputTokens?: number; outputTokens?: number };

/** The stream parts `toUIMessageStream` hands to `messageMetadata`. */
export type UsagePart =
  | { type: 'finish-step'; usage: Usage }
  | { type: 'finish'; totalUsage: Usage }
  | { type: string };

/**
 * Metadata a reply's stream part contributes.
 *
 * Each tool step resends the whole context, so the summed usage on `finish`
 * is far above the real context size. The last step's input is what the next
 * request will start from, so that is what compaction uses (`contextTokens`).
 * The AI SDK merges each part's metadata into the message, so the last
 * `finish-step` wins and `finish` adds the totals beside it.
 */
export function usageMetadata(
  part: UsagePart,
): Partial<MessageMetadata> | undefined {
  if (part.type === 'finish-step' && 'usage' in part) {
    return { contextTokens: part.usage.inputTokens };
  }

  if (part.type === 'finish' && 'totalUsage' in part) {
    return {
      inputTokensUsed: part.totalUsage.inputTokens,
      outputTokensUsed: part.totalUsage.outputTokens,
    };
  }

  return undefined;
}

/**
 * The context size to compare against the auto-compact threshold: the last
 * step's input, or for messages saved before `contextTokens` existed, the
 * summed input.
 */
export function compactionTokens(
  metadata: MessageMetadata | undefined,
): number {
  return metadata?.contextTokens ?? metadata?.inputTokensUsed ?? 0;
}
