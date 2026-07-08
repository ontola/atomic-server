// @wc-ignore-file
import { useStore, type Store } from '@tomic/react';
import { type AIMessageContext, type AtomicUIMessage } from './types';
import {
  useMcpServers,
  type ReadMCPResource,
} from '@components/AI/MCP/McpServersContext';
import { findSkillByName } from './skills/skill';
import { useSettings } from '@helpers/AppSettings';
import { shortenRefsDeep } from '@helpers/subjectRefs';
import { getDriveInstructionsContext } from './driveInstructionsContext';
import {
  buildClassContext,
  describeClassCompact,
  toCompact,
} from './jsonAdCompact';
import { getClassContextForAgent } from './resourceContextProviders';
import {
  appendTransientContextToLastUser,
  buildIndexingWarningContext,
} from './useProcessMessagesHelpers';

/**
 * A hook that processes AI chat messages by applying context.
 */
export function useProcessMessages({
  includeDriveInstructions,
  includeIndexingWarning,
}: {
  includeDriveInstructions: boolean;
  includeIndexingWarning: boolean;
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

    const transientContext = [
      includeIndexingWarning ? buildIndexingWarningContext() : '',
      driveInstructionsContext,
    ]
      .filter(Boolean)
      .join('\n');

    if (!transientContext) {
      return processedMessages;
    }

    return appendTransientContextToLastUser(
      processedMessages,
      transientContext,
    );
  };
}

/**
 * Processes atomic resources from context. Each attached resource is rendered
 * in compact JSON-AD with its `_schema` lines (mirroring get_atomic_resource
 * results), and tables additionally expand into their row-class schema, row
 * count, and a compact row sample — so the model can act on "this table"
 * without discovery tool calls.
 */
const processAtomicResources = async (
  context: AIMessageContext[],
  store: Store,
) => {
  const atomicContext = context.filter(x => x.type === 'atomic-resource');

  if (atomicContext.length === 0) {
    return { resourcesContent: '' };
  }

  const blocks: string[] = [];

  for (const { subject } of atomicContext) {
    const resource = await store.getResource(subject);

    if (resource.error) {
      blocks.push(
        `Could not read attached resource ${subject}: ${resource.error.message}`,
      );
      continue;
    }

    const classes = resource.getClasses();
    const ctx = await buildClassContext(store, classes);
    const compact: Record<string, unknown> = await toCompact(store, resource, {
      includeCommitData: true,
      context: ctx,
    });

    compact._schema = classes.map(c => describeClassCompact(ctx, c));

    const classContext = await getClassContextForAgent(
      store,
      resource,
      compact,
    );

    const lines = [
      `An atomicdata resource called ${resource.title}. Data:`,
      '```json',
      JSON.stringify(shortenRefsDeep(compact)),
      '```',
      ...(classContext ? [classContext] : []),
    ];

    blocks.push(lines.join('\n'));
  }

  return { resourcesContent: blocks.join('\n\n') };
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

    // Add atomic context if we have any atomic resources. Schemas are inline
    // (`_schema` per resource), same shape as get_atomic_resource results.
    if (atomicData.resourcesContent) {
      messageWithContext += `\n<atomic-context provided-by="user">\n<resources>\n${atomicData.resourcesContent}\n</resources>\n</atomic-context>`;
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
