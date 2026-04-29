import {
  type Resource,
  type Ai,
  type Store,
  ai,
  core,
  server,
  type JSONObject,
  dataBrowser,
} from '@tomic/react';
import {
  getStaticToolName,
  isStaticToolUIPart,
  type FileUIPart,
  type ReasoningUIPart,
  type SourceUrlUIPart,
  type TextUIPart,
  type ToolUIPart,
} from 'ai';
import { newContextItem } from '@components/AI/AISidebarContext';
import {
  type AIAtomicResourceMessageContext,
  type AIMCPResourceMessageContext,
  type AIMessageContext,
  type AtomicUIMessage,
  isAtomicResourceContext,
} from './types';
import { addFieldsIf } from '@helpers/addIf';

const TAG_TO_ROLE_MAPPING = {
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/user': 'user',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/assistant':
    'assistant',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/system': 'system',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/tool': 'tool',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/error': 'error',
} as const;

const roleToTagMapping = Object.fromEntries(
  Object.entries(TAG_TO_ROLE_MAPPING).map(([tag, role]) => [role, tag]),
);

export const uiMessageToResource = async (
  message: AtomicUIMessage,
  parent: Resource<Ai.AiChat>,
  store: Store,
): Promise<Resource<Ai.AiMessage>> => {
  const messageResource = await store.newResource<Ai.AiMessage>({
    subject: message.id,
    isA: ai.classes.aiMessage,
    parent: parent.subject,
    propVals: {
      [ai.properties.role]: roleToTag(message.role),
    },
  });

  const context = message.metadata?.userContext;

  if (context && context.length > 0) {
    // Skill context is ephemeral (already inlined into the outgoing message)
    // and has no persisted resource counterpart, so skip it here.
    const persistableContext = context.filter(c => c.type !== 'skill');
    const subjects = await Promise.all(
      persistableContext.map(c => contextToResource(c, messageResource, store)),
    );

    messageResource.props.providedContext = subjects;
  }

  if (message.metadata?.serverContext) {
    messageResource.props.serverProvidedContext =
      message.metadata.serverContext;
  }

  const builder = partsToResourceBuilder(messageResource, store);
  const partResources = await Promise.all(
    message.parts
      .filter(part => part.type !== 'step-start')
      .map(part => {
        if (part.type === 'file') {
          return builder.filePartToResource(part);
        } else if (part.type === 'text') {
          return builder.textPartToResource(part);
        } else if (part.type === 'reasoning') {
          return builder.reasoningPartToResource(part);
        } else if (isStaticToolUIPart(part)) {
          return builder.toolCallPartToResource(part);
        } else if (part.type === 'source-url') {
          return builder.sourceUrlPartToResource(part);
        } else {
          throw new Error(`Unknown content type: ${part.type}`);
        }
      }),
  );

  for (const partResource of partResources) {
    await partResource.save();
    messageResource.push(ai.properties.parts, [partResource.subject]);
  }

  await messageResource.save();

  return messageResource;
};

const contextToResource = async (
  context: AIMessageContext,
  message: Resource<Ai.AiMessage>,
  store: Store,
): Promise<string> => {
  if (isAtomicResourceContext(context)) {
    return context.subject;
  }

  if (context.type !== 'mcp-resource') {
    throw new Error(`Cannot persist context of type: ${context.type}`);
  }

  const contextResource = await store.newResource<Ai.AiMessage>({
    isA: ai.classes.mcpResource,
    parent: message.subject,
    propVals: {
      [core.properties.name]: context.name,
      [ai.properties.mcpUri]: context.uri,
      [ai.properties.mcpServerId]: context.serverId,
      ...(context.mimetype
        ? { [server.properties.mimetype]: context.mimetype }
        : {}),
    },
  });

  contextResource.save();

  return contextResource.subject;
};

export const messageResourcesToDisplayMessages = async (
  subjects: string[],
  store: Store,
): Promise<Map<AtomicUIMessage, Resource<Ai.AiMessage>>> => {
  const resources = await Promise.all(
    subjects.map(s => store.getResource<Ai.AiMessage>(s)),
  );

  const messages = new Map<AtomicUIMessage, Resource<Ai.AiMessage>>();

  for (const resource of resources) {
    if (resource.error) {
      console.error(resource.error);
      messages.set(
        {
          id: resource.subject,
          role: 'assistant',
          parts: [],
          metadata: {
            error: resource.error.message,
          },
        } satisfies AtomicUIMessage,
        resource,
      );
      continue;
    }

    const role = tagToRole(resource.props.role);

    const partResources = await Promise.all(
      resource.props.parts.map(s => store.getResource(s)),
    );

    let message: AtomicUIMessage | undefined;

    if (role === 'user') {
      message = {
        id: resource.subject,
        role,
        parts: partResources.map(r => {
          if (resourceIsFilePart(r)) {
            return toFilePart(r);
          }

          if (resourceIsTextPart(r)) {
            return toTextPart(r);
          }

          throw new Error(
            `Content with class ${r.getClasses()} not supported on role: user`,
          );
        }),
      };

      if (resource.props.providedContext) {
        const context = (
          await Promise.allSettled(
            resource.props.providedContext.map(c =>
              resourceToAIMessageContext(c, store),
            ),
          )
        )
          .filter(c => c.status === 'fulfilled')
          .map(c => c.value);

        message.metadata = {
          ...(message.metadata ?? {}),
          userContext: context,
        };
      }

      if (resource.props.serverProvidedContext) {
        message.metadata = {
          ...(message.metadata ?? {}),
          serverContext: resource.props.serverProvidedContext,
        };
      }
    }

    if (role === 'assistant') {
      message = {
        id: resource.subject,
        role,
        parts: partResources.map(r => {
          if (resourceIsReasoningPart(r)) {
            return toReasoningPart(r);
          }

          if (resourceIsTextPart(r)) {
            return toTextPart(r);
          }

          if (resourceIsToolCallPart(r)) {
            return toToolCallPart(r);
          }

          if (resourceIsSourceUrlPart(r)) {
            return toSourceUrlPart(r);
          }

          if (resourceIsFilePart(r)) {
            return toFilePart(r);
          }

          throw new Error(
            `Content with class ${r.getClasses()} not supported on role: assistant`,
          );
        }),
      };
    }

    if (role === 'system') {
      const contentResource = partResources[0];

      if (!resourceIsTextPart(contentResource)) {
        throw new Error(
          `Part with class ${contentResource.getClasses()} not supported on role: system`,
        );
      }

      message = {
        id: resource.subject,
        role,
        parts: [toTextPart(contentResource)],
      };
    }

    if (message) {
      messages.set(message, resource);
    }
  }

  return messages;
};

const resourceToAIMessageContext = async (
  subject: string,
  store: Store,
): Promise<AIMessageContext> => {
  const resource = await store.getResource(subject);

  if (resource.error) {
    throw resource.error;
  }

  if (resource.hasClasses(ai.classes.mcpResource)) {
    return newContextItem<AIMCPResourceMessageContext>({
      type: 'mcp-resource',
      name: resource.props.name,
      uri: resource.props.mcpUri,
      serverId: resource.props.mcpServerId,
      mimetype: resource.props.mimetype,
    });
  }

  return newContextItem<AIAtomicResourceMessageContext>({
    type: 'atomic-resource',
    subject: resource.subject,
  });
};

const tagToRole = (subject: string) => {
  const tag = TAG_TO_ROLE_MAPPING[subject as keyof typeof TAG_TO_ROLE_MAPPING];

  if (!tag) {
    throw new Error(`Unknown message role: ${subject}`);
  }

  return tag;
};

const roleToTag = (role: string) => {
  const tag = roleToTagMapping[role as keyof typeof roleToTagMapping];

  if (!tag) {
    throw new Error(`Unknown message role: ${role}`);
  }

  return tag;
};

const toFilePart = (resource: Resource<Ai.FilePart>): FileUIPart => {
  return {
    type: 'file',
    url: resource.props.data,
    filename: resource.props.filename,
    mediaType: resource.props.mimetype!,
  };
};

const toTextPart = (resource: Resource<Ai.TextPart>): TextUIPart => ({
  type: 'text',
  text: resource.props.description,
});

const toReasoningPart = (
  resource: Resource<Ai.ReasoningPart>,
): ReasoningUIPart => ({
  type: 'reasoning',
  text: resource.props.description,
});

const toToolCallPart = (resource: Resource<Ai.ToolCallPart>): ToolUIPart => {
  let state: ToolUIPart['state'] = 'input-streaming';

  if (resource.props.toolResultIsError) {
    state = 'output-error';
  } else if (resource.props.toolInput !== undefined) {
    state = 'input-available';

    if (resource.props.toolOutput !== undefined) {
      state = 'output-available';
    }
  }

  // @ts-expect-error - ToolUIPart type does not expect input and output fields to be present for certain states but we handle this beforehand.
  return {
    type: `tool-${resource.props.toolName}`,
    state,
    toolCallId: resource.props.toolId,
    input: resource.props.toolInput,
    output: resource.props.toolOutput,
  };
};

const toSourceUrlPart = (
  resource: Resource<Ai.SourceUrlPart>,
): SourceUrlUIPart => ({
  type: 'source-url',
  sourceId: crypto.randomUUID(), // Do we need real IDs?
  url: resource.props.url,
  title: resource.props.name,
});

const partsToResourceBuilder = (
  parent: Resource<Ai.AiMessage>,
  store: Store,
) => ({
  async filePartToResource(part: FileUIPart) {
    const data = part.url;

    return await store.newResource<Ai.FilePart>({
      isA: ai.classes.filePart,
      parent: parent.subject,
      propVals: {
        [ai.properties.data]: data,
        [server.properties.mimetype]: part.mediaType,
        ...(part.filename
          ? {
              [server.properties.filename]: part.filename,
            }
          : {}),
      },
    });
  },

  async textPartToResource(part: TextUIPart) {
    return await store.newResource<Ai.TextPart>({
      isA: ai.classes.textPart,
      parent: parent.subject,
      propVals: { [core.properties.description]: part.text },
    });
  },

  async reasoningPartToResource(part: ReasoningUIPart) {
    return await store.newResource<Ai.ReasoningPart>({
      isA: ai.classes.reasoningPart,
      parent: parent.subject,
      propVals: { [core.properties.description]: part.text },
    });
  },

  async toolCallPartToResource(part: ToolUIPart) {
    return await store.newResource<Ai.ToolCallPart>({
      isA: ai.classes.toolCallPart,
      parent: parent.subject,
      propVals: {
        [ai.properties.toolName]: getStaticToolName(part),
        [ai.properties.toolId]: part.toolCallId,
        ...addFieldsIf(!!part.input, {
          [ai.properties.toolInput]: part.input as JSONObject,
        }),
        ...addFieldsIf(!!part.output, {
          [ai.properties.toolOutput]: part.output as JSONObject,
        }),
      },
    });
  },

  async sourceUrlPartToResource(part: SourceUrlUIPart) {
    return await store.newResource<Ai.SourceUrlPart>({
      isA: ai.classes.sourceUrlPart,
      parent: parent.subject,
      propVals: {
        [dataBrowser.properties.url]: part.url,
        ...addFieldsIf(!!part.title, {
          [core.properties.name]: part.title,
        }),
      },
    });
  },
});

const resourceIsFilePart = (
  resource: Resource,
): resource is Resource<Ai.FilePart> =>
  resource.hasClasses(ai.classes.filePart);

const resourceIsTextPart = (
  resource: Resource,
): resource is Resource<Ai.TextPart> =>
  resource.hasClasses(ai.classes.textPart);

const resourceIsReasoningPart = (
  resource: Resource,
): resource is Resource<Ai.ReasoningPart> =>
  resource.hasClasses(ai.classes.reasoningPart);

const resourceIsToolCallPart = (
  resource: Resource,
): resource is Resource<Ai.ToolCallPart> =>
  resource.hasClasses(ai.classes.toolCallPart);

const resourceIsSourceUrlPart = (
  resource: Resource,
): resource is Resource<Ai.SourceUrlPart> =>
  resource.hasClasses(ai.classes.sourceUrlPart);
