import type { AtomicUIMessage } from './types';

const indexingWarningContext = `<atomic-indexing-state status="indexing">
The drive's search/vector indexes are still updating. You may answer the user now, but search-dependent tools such as semantic_search can return incomplete or stale results until indexing finishes. If you use search and results look sparse or surprising, say that indexing is still in progress and the answer may be incomplete.
</atomic-indexing-state>`;

export const buildIndexingWarningContext = (): string => indexingWarningContext;

export function appendTransientContextToLastUser(
  messages: AtomicUIMessage[],
  transientContext: string,
): AtomicUIMessage[] {
  if (!transientContext) {
    return messages;
  }

  const lastUserMessageIndex = findLastUserMessageIndex(messages);

  if (lastUserMessageIndex === -1) {
    return messages;
  }

  return messages.map((message, index) =>
    index === lastUserMessageIndex
      ? {
          ...message,
          parts: [...message.parts, { type: 'text', text: transientContext }],
        }
      : message,
  );
}

const findLastUserMessageIndex = (messages: AtomicUIMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return index;
    }
  }

  return -1;
};
