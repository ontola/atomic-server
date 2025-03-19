import { commits, useStore, type Resource, type Store } from '@tomic/react';
import {
  type AIChatDisplayMessage,
  isMessageWithContext,
  isAIErrorMessage,
  type AIMessageContext,
  isUserMessage,
} from './types';
import { toClassString } from './atomicSchemaHelpers';
import type { CoreMessage } from 'ai';

/**
 * A hook that processes AI chat messages by normalizing them and applying context.
 * @returns A function that normalizes messages and applies context to them
 */
export function useProcessMessages() {
  const store = useStore();

  const normalizeAndApplyContext = async (
    messages: AIChatDisplayMessage[],
  ): Promise<CoreMessage[]> => {
    /**
     * Normalizes a single message by processing its context and content
     * @param m - The message to normalize
     * @returns A promise that resolves to a normalized CoreMessage or undefined if the message should be filtered out
     * @throws Error if a non-user message contains context
     */
    const normalizeMessage = async (
      m: AIChatDisplayMessage,
    ): Promise<CoreMessage | undefined> => {
      if (isMessageWithContext(m)) {
        if (!isUserMessage(m.message))
          throw new Error('Only user messages can have context');

        const contextString = await addContextToMessage('', m.context, store);

        const newContent =
          typeof m.message.content === 'string'
            ? `${m.message.content}\n${contextString}`
            : [
                ...m.message.content,
                {
                  type: 'text',
                  text: contextString,
                } as const,
              ];

        return {
          ...m.message,
          content: newContent,
        };
      }

      if (isAIErrorMessage(m)) return undefined;

      return m;
    };

    const normalizedMessages = await Promise.all(
      messages.map(normalizeMessage),
    );

    return normalizedMessages.filter(m => m !== undefined);
  };

  return normalizeAndApplyContext;
}

/**
 * Converts an Atomic Resource into a plain object representation
 * @param resource - The Atomic Resource to convert
 * @param includeCommitData - Whether to include commit-related data in the output
 * @returns A plain object containing the resource's properties
 */
const toResultObject = (resource: Resource, includeCommitData: boolean) => {
  const props = Object.fromEntries(
    Array.from(resource.getPropVals().entries()).filter(
      ([key]) => includeCommitData || key !== commits.properties.lastCommit,
    ),
  );

  return {
    '@id': resource.subject,
    ...props,
  };
};

/**
 * Adds context information to a message by including resource data and schema definitions
 * @param message - The original message to add context to
 * @param context - Array of context objects containing resource references
 * @param store - An Atomic Data store instance
 * @returns A promise that resolves to the message with added context
 */
const addContextToMessage = async (
  message: string,
  context: AIMessageContext[],
  store: Store,
) => {
  const subjects = context
    .filter(x => x.type === 'resource')
    .map(x => x.subject);

  const resources = await Promise.all(subjects.map(s => store.getResource(s)));

  const result = resources
    .map(
      r => `An atomic resource called ${r.title}. Data:\n\`\`\`json
${JSON.stringify(toResultObject(r, true), null, 2)}
\`\`\``,
    )
    .join('\n');

  const classes = Array.from(new Set(resources.flatMap(r => r.getClasses())));
  const schemaDefs = await Promise.all(
    classes.map(c => toClassString(c, store)),
  );

  const messageWithContext = `${message}\n<context>\n<resources>\n${result}\n</resources>\n<schemas>\n${schemaDefs.join('\n')}\n</schemas>\n</context>`;

  console.log(messageWithContext);

  return messageWithContext;
};
