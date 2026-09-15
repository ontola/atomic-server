import {
  type Resource,
  type Ai,
  type Store,
  ai,
  core,
  server,
  type JSONValue,
  dataBrowser,
} from '@tomic/react';
import {
  isToolUIPart,
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
import { restoreToolPart, toolPartValues } from './toolHistory';

const TAG_TO_ROLE_MAPPING = {
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/user': 'user',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/assistant':
    'assistant',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/system': 'system',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/tool': 'tool',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/error': 'error',
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/summary': 'summary',
} as const;

const roleToTagMapping = Object.fromEntries(
  Object.entries(TAG_TO_ROLE_MAPPING).map(([tag, role]) => [role, tag]),
);

/** Push a locally-built message (and its parts) to the server. */
export const persistMessageResourceToServer = async (
  messageResource: Resource<Ai.AiMessage>,
  store: Store,
): Promise<void> => {
  const partSubjects = messageResource.props.parts ?? [];

  for (const subject of partSubjects) {
    const partResource = await store.getResource(subject);
    // Always call save(): draft parts from `persistToServer: false` may have a
    // stashed genesis with no dirty flag — skipping save leaves them local-only.
    await partResource.save();
  }

  await messageResource.save();
};

export const uiMessageToResource = async (
  message: AtomicUIMessage,
  parent: Resource<Ai.AiChat>,
  store: Store,
  {
    persistToServer = true,
    existingResource,
  }: {
    persistToServer?: boolean;
    existingResource?: Resource<Ai.AiMessage>;
  } = {},
): Promise<Resource<Ai.AiMessage>> => {
  // Summary messages are stored with role 'summary' regardless of their UI role.
  const persistedRole = message.metadata?.isSummary ? 'summary' : message.role;

  // `content` (parts) is required on ai-message. For a DID drive the subject is
  // derived from the genesis SIGNATURE, while parts are children whose `parent`
  // is that very subject — so real parts can't exist before the genesis is
  // signed. The genesis therefore MUST seed an empty list and push the part
  // subjects in a follow-up commit. An empty `content` is valid: the server
  // materializes an empty list as `ResourceArray([])` (loro.rs) and the required
  // check only tests presence (resources.rs), so the constraint is satisfied.
  // NOTE: if a server ever drops empty arrays, this genesis is rejected on every
  // attempt — that was the ai-message ingest loop. The outbox now classifies
  // "missing. Is required in class" as terminal (local-outbox.ts) so a malformed
  // commit is dropped instead of retried forever.
  const messageResource =
    existingResource ??
    (await store.newResource<Ai.AiMessage>({
      isA: ai.classes.aiMessage,
      parent: parent.subject,
      propVals: {
        [ai.properties.role]: roleToTag(persistedRole),
        [ai.properties.parts]: [],
      },
    }));

  // A message description records why this reply stopped; its received parts
  // remain normal parts and survive provider failures and reloads.
  if (
    message.role === 'assistant' &&
    message.metadata &&
    'error' in message.metadata
  ) {
    await messageResource.set(
      core.properties.description,
      message.metadata?.error,
    );
  }

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

  const priorParts = messageResource.props.parts ?? [];
  const partSubjects: string[] = [];

  for (const [index, part] of message.parts
    .filter(p => p.type !== 'step-start')
    .entries()) {
    const spec = messagePartSpec(part);
    const existing = priorParts[index]
      ? await store.getResource(priorParts[index])
      : undefined;
    let partResource: Resource;

    if (existing?.hasClasses(spec.isA)) {
      partResource = existing;

      for (const [property, value] of Object.entries(spec.propVals)) {
        if (
          JSON.stringify(partResource.get(property)) !== JSON.stringify(value)
        ) {
          await partResource.set(property, value);
        }
      }
    } else {
      partResource = await store.newResource({
        ...spec,
        parent: messageResource.subject,
      });
    }

    if (persistToServer) await partResource.save();
    partSubjects.push(partResource.subject);
  }

  await messageResource.set(ai.properties.parts, partSubjects);

  if (!persistToServer) {
    return messageResource;
  }

  await messageResource.save();

  return messageResource;
};

// Serialize checkpoints per chat so an older partial reply cannot overwrite
// its completed version, and concurrent saves cannot append duplicate messages.
const chatWrites = new WeakMap<Resource, Promise<unknown>>();
const chatMessageResources = new WeakMap<
  Resource,
  Map<string, Resource<Ai.AiMessage>>
>();

export const addMessageToChatResource = async (
  message: AtomicUIMessage,
  chatResource: Resource<Ai.AiChat>,
  store: Store,
  {
    saveChat = true,
    persistToServer = true,
  }: { saveChat?: boolean; persistToServer?: boolean } = {},
): Promise<Resource<Ai.AiMessage>> => {
  const snapshot = structuredClone(message);
  const previous = chatWrites.get(chatResource) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      let known = chatMessageResources.get(chatResource);

      if (!known) {
        known = new Map();
        chatMessageResources.set(chatResource, known);
      }

      const existingResource = known.get(snapshot.id);
      const messageResource = await uiMessageToResource(
        snapshot,
        chatResource,
        store,
        {
          persistToServer,
          existingResource,
        },
      );
      known.set(snapshot.id, messageResource);

      if (!chatResource.props.messages?.includes(messageResource.subject)) {
        chatResource.push(ai.properties.messages, [messageResource.subject]);
      }

      if (saveChat) await chatResource.save();

      return messageResource;
    });
  chatWrites.set(chatResource, work);

  return work;
};

export const removeMessageFromChatResource = async (
  messageResource: Resource,
  chatResource: Resource<Ai.AiChat>,
  { saveChat = true }: { saveChat?: boolean } = {},
): Promise<void> => {
  await chatResource.set(
    ai.properties.messages,
    chatResource.props.messages?.filter(
      subject => subject !== messageResource.subject,
    ),
  );

  if (saveChat) {
    await chatResource.save();
  }

  await messageResource.destroy();
};

export const removeFollowingMessagesFromChatResource = async (
  message: AtomicUIMessage,
  messages: AtomicUIMessage[],
  messageToResourceMap: Map<AtomicUIMessage, Resource>,
  chatResource: Resource<Ai.AiChat>,
  { saveChat = true }: { saveChat?: boolean } = {},
): Promise<AtomicUIMessage[]> => {
  const messageIndex = messages.findIndex(x => x.id === message.id);

  if (messageIndex === -1) {
    throw new Error(`Message not found: ${message.id}`);
  }

  const nextMessages = messages.slice(messageIndex + 1);
  const destroySubjects: string[] = [];

  for (const m of nextMessages) {
    const r = messageToResourceMap.get(m);

    if (r) {
      destroySubjects.push(r.subject);

      try {
        await r.destroy();
      } catch (error) {
        console.error('Error removing message:', error);
      }
    } else {
      throw new Error(`Resource not found for message: ${m.id}`);
    }
  }

  await chatResource.set(
    ai.properties.messages,
    chatResource.props.messages?.filter(x => !destroySubjects.includes(x)),
  );

  if (saveChat) {
    await chatResource.save();
  }

  return messages.slice(0, messageIndex + 1);
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

    if (role === 'summary') {
      const contentResource = partResources[0];

      if (!resourceIsTextPart(contentResource)) {
        throw new Error(
          `Part with class ${contentResource.getClasses()} not supported on role: summary`,
        );
      }

      message = {
        id: resource.subject,
        role: 'user',
        parts: [toTextPart(contentResource)],
        metadata: { isSummary: true },
      };
    }

    if (message) {
      if (role === 'assistant' && resource.get(core.properties.description)) {
        message.metadata = {
          ...message.metadata,
          error: resource.get(core.properties.description),
        };
      }

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

const toToolCallPart = (resource: Resource<Ai.ToolCallPart>): ToolUIPart =>
  restoreToolPart(resource.props);

const toSourceUrlPart = (
  resource: Resource<Ai.SourceUrlPart>,
): SourceUrlUIPart => ({
  type: 'source-url',
  sourceId: crypto.randomUUID(), // Do we need real IDs?
  url: resource.props.url,
  title: resource.props.name,
});

function messagePartSpec(part: AtomicUIMessage['parts'][number]): {
  isA: string;
  propVals: Record<string, JSONValue>;
} {
  if (part.type === 'file')
    return {
      isA: ai.classes.filePart,
      propVals: {
        [ai.properties.data]: part.url,
        [server.properties.mimetype]: part.mediaType,
        ...(part.filename
          ? { [server.properties.filename]: part.filename }
          : {}),
      },
    };
  if (part.type === 'text' || part.type === 'reasoning')
    return {
      isA:
        part.type === 'text' ? ai.classes.textPart : ai.classes.reasoningPart,
      propVals: { [core.properties.description]: part.text },
    };
  if (isToolUIPart(part))
    return { isA: ai.classes.toolCallPart, propVals: toolPartValues(part) };
  if (part.type === 'source-url')
    return {
      isA: ai.classes.sourceUrlPart,
      propVals: {
        [dataBrowser.properties.url]: part.url,
        ...(part.title ? { [core.properties.name]: part.title } : {}),
      },
    };
  throw new Error(`Unknown content type: ${part.type}`);
}

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
