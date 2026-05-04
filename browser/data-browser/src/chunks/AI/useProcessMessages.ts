// @wc-ignore-file
import { commits, useStore, type Resource, type Store } from '@tomic/react';
import { type AIMessageContext, type AtomicUIMessage } from './types';
import { toClassString } from './atomicSchemaHelpers';
import {
  useMcpServers,
  type ReadMCPResource,
} from '@components/AI/MCP/McpServersContext';
import { findSkillByName } from './skills/skill';
import { useSettings } from '@helpers/AppSettings';
import { getDriveInstructionsContext } from './driveInstructionsContext';

/**
 * A hook that processes AI chat messages by applying context.
 */
export function useProcessMessages({
  includeDriveInstructions,
}: {
  includeDriveInstructions: boolean;
}) {
  const store = useStore();
  const { readMCPResource } = useMcpServers();
  const { drive } = useSettings();

  return async (messages: AtomicUIMessage[]): Promise<AtomicUIMessage[]> => {
    const map = async (message: AtomicUIMessage) => {
      if (message.metadata?.userContext || message.metadata?.serverContext) {
        return {
          ...message,
          parts: [
            ...message.parts,
            {
              type: 'text',
              text: await addContextToMessage(
                '',
                {
                  userContext: message.metadata.userContext,
                  serverContext: message.metadata.serverContext,
                },
                store,
                readMCPResource,
              ),
            },
          ],
        };
      }

      return message;
    };

    const processedMessages = (await Promise.all(
      messages.map(map),
    )) as AtomicUIMessage[];
    const driveInstructionsContext = includeDriveInstructions
      ? await getDriveInstructionsContext(drive, store)
      : '';

    if (!driveInstructionsContext) {
      return processedMessages;
    }

    const lastUserMessageIndex = findLastUserMessageIndex(processedMessages);

    if (lastUserMessageIndex === -1) {
      return processedMessages;
    }

    return processedMessages.map((message, index) =>
      index === lastUserMessageIndex
        ? {
            ...message,
            parts: [
              ...message.parts,
              { type: 'text', text: driveInstructionsContext },
            ],
          }
        : message,
    );
  };
}

const findLastUserMessageIndex = (messages: AtomicUIMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return index;
    }
  }

  return -1;
};

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
      r => `An atomicdata resource called ${r.title}. Data:\n\`\`\`json
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
 * Processes skills from context by inlining the main SKILL.md body.
 * References are left out and can still be loaded via the `read_skill_reference` tool.
 */
const processSkills = (context: AIMessageContext[]): string => {
  const skillContext = context.filter(x => x.type === 'skill');

  if (skillContext.length === 0) {
    return '';
  }

  return skillContext
    .map(ctx => {
      const skill = findSkillByName(ctx.name);

      if (!skill) {
        return `<skill-context name="${ctx.name}">\nSkill not found.\n</skill-context>`;
      }

      return `<skill-context name="${skill.meta.name}">
<skill-main>
${skill.content}
</skill-main>
</skill-context>`;
    })
    .join('\n');
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

        return `\`\`\`${resourceData.mimeType || 'text'}
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
 * @param userContext - Array of context objects containing resource references
 * @param store - An Atomic Data store instance
 * @param readMCPResource - Function to read MCP resources
 * @returns A promise that resolves to the message with added context
 */
const addContextToMessage = async (
  message: string,
  context: {
    userContext?: AIMessageContext[];
    serverContext?: string;
  },
  store: Store,
  readMCPResource: ReadMCPResource,
) => {
  const { userContext, serverContext } = context;

  let messageWithContext = '';

  if (userContext) {
    const [atomicData, mcpContent] = await Promise.all([
      processAtomicResources(userContext, store),
      processMCPResources(userContext, readMCPResource),
    ]);

    // Add atomic context if we have any atomic resources or schemas
    if (atomicData.resourcesContent || atomicData.schemasContent) {
      messageWithContext += `\n<atomic-context provided-by="user">`;

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
      messageWithContext += `\n<context provided-by="user">\n${mcpContent}\n</context>`;
    }

    // Add skill context if the user mentioned any skills with the slash menu
    const skillContent = processSkills(userContext);

    if (skillContent) {
      messageWithContext += `\n${skillContent}`;
    }
  }

  if (serverContext) {
    messageWithContext += `\n<atomic-context provider="RAG">\n${serverContext}\n</atomic-context>`;
  }

  return messageWithContext;
};
