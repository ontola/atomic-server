import { commits, useStore, type Resource, type Store } from '@tomic/react';
import {
  type AIChatDisplayMessage,
  isMessageWithContext,
  isAIErrorMessage,
  type AIMessageContext,
  isUserMessage,
} from './types';
import { toClassString } from './atomicSchemaHelpers';
import { useMcpServers, type ReadMCPResource } from './MCP/useMcpServers';
import type { CoreMessage } from 'ai';

/**
 * A hook that processes AI chat messages by normalizing them and applying context.
 * @returns A function that normalizes messages and applies context to them
 */
export function useProcessMessages() {
  const store = useStore();
  const { readMCPResource } = useMcpServers();

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

        const contextString = await addContextToMessage(
          '',
          m.context,
          store,
          readMCPResource,
        );

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
 * Processes atomic resources from context
 */
const processAtomicResources = async (
  context: AIMessageContext[],
  store: Store,
) => {
  const atomicContext = context.filter(x => x.type === 'atomic-resource');

  if (atomicContext.length === 0) {
    return { resourcesContent: '', schemasContent: '' };
  }

  const subjects = atomicContext.map(x => x.subject);
  const resources = await Promise.all(subjects.map(s => store.getResource(s)));

  const resourcesContent = resources
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

  return {
    resourcesContent,
    schemasContent: schemaDefs.join('\n'),
  };
};

/**
 * Processes MCP resources from context
 */
const processMCPResources = async (
  context: AIMessageContext[],
  readMCPResource: ReadMCPResource,
) => {
  const mcpContext = context.filter(x => x.type === 'mcp-resource');

  if (mcpContext.length === 0) {
    return '';
  }

  const mcpResults = await Promise.all(
    mcpContext.map(async ctx => {
      try {
        const resourceData = await readMCPResource(ctx.serverId, ctx.uri);

        return `MCP resource "${ctx.name}" (${ctx.uri}):\n\`\`\`${resourceData.mimeType || 'text'}
${typeof resourceData.contents === 'string' ? resourceData.contents : JSON.stringify(resourceData.contents, null, 2)}
\`\`\``;
      } catch (error) {
        return `MCP resource "${ctx.name}" (${ctx.uri}): Error loading - ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    }),
  );

  return mcpResults.join('\n');
};

/**
 * Adds context information to a message by including resource data and schema definitions
 * @param message - The original message to add context to
 * @param context - Array of context objects containing resource references
 * @param store - An Atomic Data store instance
 * @param readMCPResource - Function to read MCP resources
 * @returns A promise that resolves to the message with added context
 */
const addContextToMessage = async (
  message: string,
  context: AIMessageContext[],
  store: Store,
  readMCPResource: ReadMCPResource,
) => {
  const [atomicData, mcpContent] = await Promise.all([
    processAtomicResources(context, store),
    processMCPResources(context, readMCPResource),
  ]);

  let messageWithContext = message;

  // Add atomic context if we have any atomic resources or schemas
  if (atomicData.resourcesContent || atomicData.schemasContent) {
    messageWithContext += `\n<atomic-context>`;

    if (atomicData.resourcesContent) {
      messageWithContext += `\n<resources>\n${atomicData.resourcesContent}\n</resources>`;
    }

    if (atomicData.schemasContent) {
      messageWithContext += `\n<schemas>\n${atomicData.schemasContent}\n</schemas>`;
    }

    messageWithContext += `\n</atomic-context>`;
  }

  // Add MCP context if we have any MCP resources
  if (mcpContent) {
    messageWithContext += `\n<extra-context>\n${mcpContent}\n</extra-context>`;
  }

  return messageWithContext;
};
